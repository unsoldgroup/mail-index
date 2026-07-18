/**
 * Async storage seam (ticket M1 #12; PLAN-worker locked decision #2, ADR-0008).
 *
 * The index layer (`db.ts` / `repo.ts` / `migrations.ts`) used to talk straight
 * to node:sqlite's synchronous `DatabaseSync`. The remote Deployment's store is
 * Cloudflare D1, which is async-only, so every storage call must return a
 * Promise before any Worker work can start. `StorageDriver` is that seam: the
 * smallest async surface the index layer needs from an engine. It is implemented
 * by `drivers/sqlite.ts` (node:sqlite — this ticket) and, in ticket 002, by a D1
 * driver. `src/index/fts.ts` stays pure and gains no dependency on this seam.
 *
 * Atomic writes go through {@link StorageDriver.batch}: a list of statements
 * applied atomically, matching D1's `batch()` model (D1 has no interactive
 * `BEGIN…COMMIT`). Reads may precede a batch; only the writes must be atomic —
 * the atomic unit is the write batch, not surrounding read-then-decide logic.
 */

/** A value that can bind to a `?` placeholder (the node:sqlite value domain). */
export type SqlParam = null | number | bigint | string | Uint8Array;

/** Result of a write statement (mirrors node:sqlite's resulting-changes shape). */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * A prepared statement. Construction (`StorageDriver.prepare`) stays synchronous
 * — both node:sqlite and D1 build the statement object without I/O — but every
 * execution is async and returns plain rows (objects keyed by column name).
 */
export interface PreparedStatement {
  run(...params: SqlParam[]): Promise<RunResult>;
  get(...params: SqlParam[]): Promise<unknown>;
  all(...params: SqlParam[]): Promise<unknown[]>;
}

/** One statement in an atomic write {@link StorageDriver.batch}. */
export interface BatchStatement {
  sql: string;
  params?: SqlParam[];
}

/** The async storage engine seam. See the module comment. */
export interface StorageDriver {
  /** Run one or more SQL statements for their effect (DDL, PRAGMA, control). */
  exec(sql: string): Promise<void>;
  /** Build a reusable prepared statement (synchronous; execution is async). */
  prepare(sql: string): PreparedStatement;
  /** Apply a list of write statements atomically (D1 `batch()` model). */
  batch(statements: readonly BatchStatement[]): Promise<void>;
  /** Release the underlying connection. */
  close(): void;
}
