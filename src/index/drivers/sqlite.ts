/**
 * node:sqlite implementation of {@link StorageDriver} (ticket M1 #12).
 *
 * Thin async wrapper over the built-in synchronous `DatabaseSync` /
 * `StatementSync`: every method does the same sync work the index layer did
 * before and hands the result back as a resolved Promise. No behavior change
 * locally — this is pure portability so the D1 driver (ticket 002) can slot into
 * the same seam. Lives inside `src/index/` (an audited storage seam), not the
 * egress-guarded provider surface.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  BatchStatement,
  PreparedStatement,
  RunResult,
  SqlParam,
  StorageDriver,
} from '../driver.js';

/** Async facade over a single `StatementSync`. */
class SqliteStatement implements PreparedStatement {
  readonly #stmt: StatementSync;

  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
  }

  async run(...params: SqlParam[]): Promise<RunResult> {
    const r = this.#stmt.run(...(params as never[]));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    return this.#stmt.get(...(params as never[]));
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    return this.#stmt.all(...(params as never[])) as unknown[];
  }
}

/**
 * {@link StorageDriver} backed by a live node:sqlite connection. Prepared
 * statements are cached (both here for {@link batch} and in the repo layer) so
 * the hot sync loop reuses the parse.
 */
export class SqliteDriver implements StorageDriver {
  readonly db: DatabaseSync;
  #batchStmts = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new SqliteStatement(this.db.prepare(sql));
  }

  /**
   * Apply `statements` atomically. node:sqlite has interactive transactions, so
   * the D1 `batch()` contract is honoured here with an IMMEDIATE transaction,
   * or a savepoint when a Repo transaction already owns the connection.
   */
  async batch(statements: readonly BatchStatement[]): Promise<void> {
    // SAVEPOINT also works inside a Repo transaction; releasing it preserves
    // the outer transaction's rollback of every bounded write chunk.
    const nested = this.db.isTransaction;
    this.db.exec(nested ? 'SAVEPOINT mail_index_batch' : 'BEGIN IMMEDIATE');
    try {
      for (const s of statements) {
        let st = this.#batchStmts.get(s.sql);
        if (!st) {
          st = this.db.prepare(s.sql);
          this.#batchStmts.set(s.sql, st);
        }
        st.run(...((s.params ?? []) as never[]));
      }
      this.db.exec(nested ? 'RELEASE mail_index_batch' : 'COMMIT');
    } catch (err) {
      this.db.exec(nested ? 'ROLLBACK TO mail_index_batch' : 'ROLLBACK');
      if (nested) this.db.exec('RELEASE mail_index_batch');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
