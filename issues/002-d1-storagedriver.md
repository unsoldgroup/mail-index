# M1: Add the D1 StorageDriver with migrations and FTS contract verification

## Context
Depends on 001: Extract async StorageDriver.
Read first: docs/PLAN-worker.md (decisions #2, #11; "Deltas that need care" —
FTS5 on D1), CONTEXT.md (FTS contract), ADR-0006 (self-contained FTS5, not
external content), ADR-0008.

The FTS contract lives in `src/index/fts.ts`: `FTS_TOKENIZER = 'porter
unicode61'`, `FTS_TABLE_DDL` (fts5 virtual table `messages_fts`),
`projectBody`/`projectFtsRow` (body projection over the Body state ladder),
`buildMatch` + `expandQuery`, and `BM25_WEIGHTS = [10, 8, 4, 1]` /
`bm25Expr()`. Index-time and query-time must not drift on D1. The bench
harness is `bench/run.mjs` + `bench/accuracy.mjs`.

## Decision
Implement `StorageDriver` on Cloudflare D1 and prove the index behaves
identically.

- New D1 driver module implementing the 001 `StorageDriver` interface over a
  `D1Database` binding (`prepare().bind().run()/all()/first()`, `batch()` for
  the atomic-statement-list primitive). Lives with the other driver(s) under
  `src/index/drivers/`; it imports only Cloudflare *types* — no runtime
  network primitive — so the egress guard stays green (D1 access is via an
  injected binding, an audited seam per ADR-0008).
- Migrations on D1: `runMigrations` (async since 001) runs the same
  forward-only `MIGRATIONS` array (schema v9+) against D1 at deploy/first
  request. D1 has no `PRAGMA user_version` persistence guarantee — if
  verification shows it unsupported, store the version in a one-row
  `schema_version` table behind the same `getUserVersion` driver method, so
  `migrations.ts` stays engine-agnostic. SQLite-only pragmas (WAL etc.) belong
  to the node:sqlite driver, not to migrations.
- FTS contract verified on D1: `messages_fts` created from `FTS_TABLE_DDL`
  verbatim; porter tokenizer stemming and `bm25(messages_fts, 10, 8, 4, 1)`
  ranking produce the same ordering as node:sqlite on identical rows.
- This ticket OWNS writing the driver-level conformance suite and must run
  it against BOTH drivers (node:sqlite + D1).
- Tests run the D1 driver via Miniflare/`wrangler d1` local mode (dev
  dependency; test-only — production `dependencies` stay the current four).
  Reuse existing repo/FTS test bodies parameterised over the driver where
  practical rather than copying suites.
- Bench: a subset of `bench/run.mjs` cases — at least the RESULTS.md accuracy
  cases — runs against both drivers; results recorded in a new
  `bench/RESULTS-D1.md`.

## Acceptance criteria
- [ ] A driver-level conformance suite (written in this ticket) exists and
      passes against BOTH drivers: the D1 implementation and node:sqlite
      (same test body).
- [ ] `runMigrations` brings a fresh D1 database to `SCHEMA_VERSION` (9) and
      is a no-op on re-run; a mid-version database migrates forward.
- [ ] An FTS parity test asserts identical hit ordering and bm25 scores (or
      documented-equivalent ordering) for a fixed corpus on both drivers,
      exercising porter stemming (`buildMatch`/`expandQuery`) and the
      `BM25_WEIGHTS` projection.
- [ ] Bench subset (at least the RESULTS.md accuracy cases) executed against
      both drivers with results checked in to `bench/RESULTS-D1.md`.
- [ ] All pre-existing tests (34 files) still green; egress-guard test passes
      with no new allowlist entry for `src/index/`.
- [ ] `npm run typecheck` passes without Cloudflare types leaking into
      non-driver modules.

## Out of scope
- No worker/ entry, wrangler deploy config, or bindings wiring (004).
- No Gmail REST adapter (003), no OAuth (005/007).
- No data import/export tooling (012).
- No schema changes beyond a version-tracking shim if D1 requires it.
