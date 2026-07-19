# M2: Wire cron sync and the queued Job engine

## Context
Depends on 001, 002 (D1 driver), 003 (gmail-rest source), 004 (worker entry,
Queues bindings), 005 (hard dependency — see account source below; fixtures
suffice for tests).
The Worker's account list = rows in the `google_tokens` table (005). 005 is
therefore a hard dependency, not optional. For tests/dev, accounts may be
injected via a wrangler var consumed by the same accessor.
Read first: ADR-0009 (O(N) work is a queued Job — "exactly one execution
engine per Deployment: the CLI locally, the queue remotely"), ADR-0005
(stale reads trigger background sync; `sync_runs` row as the lock), CONTEXT.md
(Job, Command handback, Working set), docs/PLAN-worker.md decisions #5, #6.

Local pipeline today: `syncMetadata(options: SyncOptions): Promise<SyncResult>`
in `src/ingest/sync.ts` (phase 1, writes `sync_runs` audit rows via
`Repo.startSyncRun`/`finishSyncRun`; `SYNC_PHASES = ['sync','enrich','graph']`
in `src/index/schema.ts`), then `src/ingest/enrich.ts`, then graph rebuild.

## Decision
Cron Trigger + Queues consumer running the same pipeline code, tracked in a
D1 `jobs` table.

- Cron: `triggers.crons` in `worker/wrangler.jsonc`, default `*/15 * * * *`,
  operator-customizable — the cron expression in config plus a
  `SYNC_INTERVAL` var the deploy guide tells operators to keep in step
  (decision #5). `SYNC_INTERVAL` is consumed by the freshness/staleness math
  (`STALE_AFTER_MS`-equivalent and `sync_status` ETA) so tool responses can
  state when the next sync is due; the cron expression must be kept in step
  with it. The `scheduled()` handler only **enqueues** a sync Job per
  configured account — it does no O(N) work inline.
- Queue consumer (same Worker, `queue()` handler per ADR-0009): executes
  jobs. Job kinds for v1: `sync` (metadata sweep → enrich → graph, honoring
  `SYNC_PHASES` order), `backfill`, `enrich_bulk` (the Command-handback
  replacements 008 will enqueue). Messages carry `{ jobId, kind, account,
  params }` only — payload state lives in D1.
- New migration (next schema version — coordinate with 005; whichever lands
  first takes the next number): `jobs` table — `id` TEXT PK (crypto.randomUUID),
  `kind`, `account`, `params_json`, `status`
  ('queued'|'running'|'done'|'failed'), `progress_json` (counts per phase),
  `error`, `created_at`, `started_at`, `finished_at`. At-least-once safe:
  the consumer is idempotent because upserts already are (ADR-0009); a
  re-delivered job re-runs harmlessly and the `sync_runs` in-progress row +
  `STALE_LOCK_MS` (repo.ts) still dedupe concurrent syncs per account.
- Lock atomicity: the existing `sync_runs` acquireLock atomicity rests on
  node:sqlite's serial single-connection guarantee, which D1 does not provide
  across isolates. The D1 path must make check-and-insert atomic (conditional
  `INSERT ... SELECT ... WHERE NOT EXISTS` or the driver's atomic batch).
- `sync_status` tool grows a `jobs` section on the remote Deployment: queue
  depth, recent jobs with status/progress (repo method over the jobs table;
  local Deployment reports an empty/absent jobs section — no local jobs
  runner is built).
- **Push-ready shape (build the seam, not the feature):** the "enqueue a sync
  job for account X since Y" function is a single exported entry point that
  cron calls today and a future Gmail `users.watch` + Pub/Sub webhook route
  can call tomorrow — no other rework needed. Document this in the module
  header; the design note itself is 013.
- Chunking: a sync job that exceeds a safe budget re-enqueues a continuation
  (same jobId, cursor in `progress_json`) rather than blowing Worker limits.

## Acceptance criteria
- [ ] Migration adds `jobs`; `SCHEMA_VERSION` bumped; local tests green.
- [ ] `scheduled()` enqueues one sync Job per account and returns without
      calling Gmail; verified in a Miniflare test.
- [ ] Queue consumer runs sync→enrich→graph phases against fixtures, updating
      `jobs.status/progress_json` through
      queued→running→done, and `sync_runs` rows appear exactly as a local
      sync would write them.
- [ ] Duplicate delivery of the same job message does not duplicate Messages
      (idempotency test: deliver twice, row counts equal).
- [ ] A test proves two concurrent lock attempts yield exactly one winner on
      the D1 driver.
- [ ] A failed job records `status='failed'` + `error`, and Queues retry
      redelivers (test with an injected failing fetch).
- [ ] `sync_status` returns queue depth + per-job progress on the Worker;
      its local output shape is unchanged (existing tests untouched).
- [ ] Cron interval is configurable without code changes (config/var only).

## Out of scope
- No Gmail push (`users.watch`/Pub/Sub) implementation — seam only; design
  note in 013.
- No tool-side Job enqueueing from handbacks or freshness auto-refresh — 008.
- No Trigger-rule evaluation in the pipeline — 010 hooks in later.
- No local jobs runner; Command handbacks stay the local mechanism.
