/** Cloudflare D1 implementation of the async storage seam. */

import type {
  BatchStatement,
  PreparedStatement,
  RunResult,
  SqlParam,
  StorageDriver,
} from '../driver.js';

/**
 * Structural subset of Cloudflare's D1 binding used by the driver. Keeping the
 * type at the audited seam prevents Worker globals leaking into the index.
 */
export interface D1DatabaseBinding {
  prepare(sql: string): D1PreparedStatementBinding;
  exec(sql: string): Promise<unknown>;
  batch<T = unknown>(statements: D1PreparedStatementBinding[]): Promise<T[]>;
}

interface D1PreparedStatementBinding {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  run<T = Record<string, unknown>>(): Promise<D1ResultBinding<T>>;
  all<T = Record<string, unknown>>(): Promise<D1ResultBinding<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1ResultBinding<T> {
  results?: T[];
  meta?: { changes?: number; last_row_id?: number };
}

const VERSION_READ = /^\s*PRAGMA\s+user_version\s*;?\s*$/i;
const VERSION_WRITE = /^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i;
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|COMMIT|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/i;
const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL
)`;

function normalizeExecSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('; ');
}

function d1Params(params: readonly SqlParam[]): unknown[] {
  return params.map((value) => {
    if (typeof value === 'bigint') {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) {
        throw new RangeError(`D1 cannot bind bigint outside the safe integer range: ${value}`);
      }
      return number;
    }
    if (value instanceof Uint8Array) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return value;
  });
}

class D1Statement implements PreparedStatement {
  constructor(
    private readonly statement: D1PreparedStatementBinding,
    private readonly versionRead = false,
  ) {}

  async run(...params: SqlParam[]): Promise<RunResult> {
    const result = await this.statement.bind(...d1Params(params)).run();
    return {
      changes: result.meta?.changes ?? 0,
      lastInsertRowid: result.meta?.last_row_id ?? 0,
    };
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    if (this.versionRead) {
      const row = await this.statement.bind(...params).first<{ version: number }>();
      return { user_version: row?.version ?? 0 };
    }
    return (await this.statement.bind(...d1Params(params)).first()) ?? undefined;
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    const result = await this.statement.bind(...d1Params(params)).all();
    return result.results ?? [];
  }
}

export class D1Driver implements StorageDriver {
  #versionTableReady: Promise<void> | undefined;

  constructor(readonly db: D1DatabaseBinding) {}

  async #ensureVersionTable(): Promise<void> {
    this.#versionTableReady ??= this.db.exec(normalizeExecSql(VERSION_TABLE)).then(() => undefined);
    await this.#versionTableReady;
  }

  async exec(sql: string): Promise<void> {
    // D1 rejects interactive SQL transactions; its atomic API is batch().
    // Migrations are forward-only and publish their version only after all
    // steps succeed, so these runner boundaries intentionally become no-ops.
    if (TRANSACTION_CONTROL.test(sql)) return;
    const version = VERSION_WRITE.exec(sql)?.[1];
    if (version !== undefined) {
      await this.#ensureVersionTable();
      await this.db
        .prepare(
          `INSERT INTO schema_version(singleton, version) VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET version = excluded.version`,
        )
        .bind(Number(version))
        .run();
      return;
    }
    const normalized = normalizeExecSql(sql);
    if (normalized) await this.db.exec(normalized);
  }

  prepare(sql: string): PreparedStatement {
    if (VERSION_READ.test(sql)) {
      const statement: D1PreparedStatementBinding = {
        bind: (..._values: unknown[]) => statement,
        run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
        all: async () => ({ results: [] }),
        first: async <T>() => {
          await this.#ensureVersionTable();
          return (await this.db
            .prepare('SELECT version FROM schema_version WHERE singleton = 1')
            .first()) as T | null;
        },
      };
      return new D1Statement(statement, true);
    }
    return new D1Statement(this.db.prepare(sql));
  }

  async batch(statements: readonly BatchStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.db.batch(
      statements.map(({ sql, params = [] }) => this.db.prepare(sql).bind(...d1Params(params))),
    );
  }

  close(): void {
    // D1 bindings are owned by the Worker runtime and have no close operation.
  }
}
