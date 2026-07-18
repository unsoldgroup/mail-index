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
   * the D1 `batch()` contract is honoured here with an IMMEDIATE transaction:
   * all statements commit together or none do.
   */
  async batch(statements: readonly BatchStatement[]): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of statements) {
        let st = this.#batchStmts.get(s.sql);
        if (!st) {
          st = this.db.prepare(s.sql);
          this.#batchStmts.set(s.sql, st);
        }
        st.run(...((s.params ?? []) as never[]));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
