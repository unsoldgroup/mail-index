# M1: Extract async StorageDriver

## Context
Depends on nothing — this is the root of the dependency graph (1→2→(4,6)).
Read first: docs/PLAN-worker.md (locked decision #2, "Deltas that need care"),
CONTEXT.md (Deployment, FTS contract), ADR-0008, ADR-0006.

Pain point: the whole index layer (`src/index/`) is synchronous `node:sqlite`.
`src/index/db.ts` exports `openDb(options): DatabaseSync`; `src/index/repo.ts`
is `export class Repo` wrapping a live `DatabaseSync` with ~60 sync verb
methods (`upsertMessage`, `searchMessages`, `startSyncRun`, `finishSyncRun`,
`saveMessageSummary`, `compactEligible`, `replaceAggregates`, …);
`src/index/migrations.ts` exports `runMigrations(db: DatabaseSync): void`.
D1 is async-only, so the storage API must go async before any Worker work can
start. This ticket is pure portability: **no behavior change locally**.

## Decision
Introduce an async `StorageDriver` seam under `src/index/` and port every call
site to it.

- New `src/index/driver.ts`: a `StorageDriver` interface abstracting what
  `db.ts`/`repo.ts` need from the engine — at minimum `exec(sql)`,
  prepared-statement `run`/`get`/`all` (async, returning plain rows), and a
  transaction/batch primitive compatible with both `node:sqlite` and D1's
  `batch()` model (D1 has no interactive transactions — design the primitive
  as "list of statements applied atomically", not `BEGIN…COMMIT` callbacks).
  Reads may precede the batch; only writes must be atomic — the atomic unit
  is the write batch, not surrounding read-then-decide logic.
- New `src/index/drivers/sqlite.ts` (name flexible, stays inside `src/index/`):
  the `node:sqlite` implementation, wrapping the existing sync
  `DatabaseSync`/`StatementSync` calls in resolved promises. `openDb()` in
  `db.ts` keeps its PRAGMA/WAL behavior and now yields a driver.
- `Repo` methods become async (`Promise<…>` returns), still verbs, still one
  class; invariants 1–3 in the repo header comment (idempotent upsert by
  (account, gmail_message_id), never-downgrade body_state, FTS lockstep) are
  untouched.
- `runMigrations`/`getUserVersion` in `migrations.ts` become async over the
  driver; the `MIGRATIONS` array and forward-only semantics
  (`SCHEMA_VERSION = 9` in `schema.ts`) unchanged.
- `src/index/fts.ts` is already pure (projections, `buildMatch`,
  `BM25_WEIGHTS`, `FTS_TABLE_DDL`) — it must gain **no** driver dependency.
- Port call sites: `src/ingest/` (sync.ts, enrich.ts, mutate.ts,
  reconcile-inbox.ts, sync-labels.ts), `src/cli/*`, `src/mcp/tools.ts`
  (`ToolContext` holds the repo — tool handlers that were sync become async;
  `src/mcp/server.ts` `dispatch` already awaits handlers), `src/graph/`,
  `src/intelligence/`, `src/curation/`, `src/writeback/`.
- Update the `src/index/index.ts` barrel exports.
- Existing tests adapted to `await` — assertions unchanged.

## Acceptance criteria
- [ ] `src/index/driver.ts` exists and exports the `StorageDriver` interface;
      `src/index/repo.ts` and `src/index/migrations.ts` depend only on it, not
      on `node:sqlite` types.
- [ ] The node:sqlite driver implements `StorageDriver`; `openDb`
      (`src/index/db.ts`) still applies the same pragmas/WAL and
      `defaultDbPath()` is unchanged.
- [ ] Every public `Repo` method returns a Promise; no caller uses `.then` on
      a sync value pattern — `npm run typecheck` passes.
- [ ] All 34 existing test files pass under `npm test` (node --test over
      compiled dist), adapted for async only — no assertion weakened, none
      skipped.
- [ ] `test/egress-guard.test.ts` still passes unmodified (no new network or
      spawn primitives in `src/`).
- [ ] CLI smoke: `mail-index sync`/`search`/`status` behave identically on an
      existing local index (schema stays v9; no migration added). Smoke = run
      sync + search against the fake source fixtures and diff output
      before/after the refactor.

## Out of scope
- No D1 code, no `@cloudflare/*` imports, no wrangler config (002/004).
- No new MailSource adapter (003).
- No schema/migration changes — v9 stays v9.
- No changes to FTS ranking, tokenizer, or weights.
- No worker/ directory.
