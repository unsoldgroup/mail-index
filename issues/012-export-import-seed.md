# M4: Build the seed path — mail-index export and D1 import

## Context
Depends on 002: D1 StorageDriver (import writes through it; "12 after 2" in
the dependency graph). Soft dependency on 006 (the incremental-first-sync
AC is only verifiable once the cron exists). Otherwise independent of the
Worker tickets — usable as soon as a D1 database exists.
Read first: docs/PLAN-worker.md decision #10, CONTEXT.md (Summary, Interest
profile, Working set — Messages are re-fetchable, but Summaries, curation,
and Entity categories are *earned* state that must not require re-backfill),
ADR-0003 (summaries + demotion — summary-only rows have no body to re-fetch
cheaply).

CLI structure: subcommands live in `src/cli/` (index.ts routes; siblings like
`sync.ts`, `status.ts`, `curate.ts`). The index API surface is the
`src/index/index.ts` barrel (`openDb`, `Repo`, `runMigrations`).

## Decision
A portable dump format plus an importer, so a seasoned local index seeds a
fresh remote Deployment.

- `mail-index export [--db <path>] [--out <file>] [--account <label>]`: new
  `src/cli/export.ts`. Streams the local sqlite index to **NDJSON** (one
  self-describing envelope line `{ type: 'header', schema_version, exported_at,
  accounts }`, then one line per row `{ type: '<table>', row: {...} }`).
  Covered tables: messages (all Body states incl. `summary_text`,
  `summary_is_model`, `body_state`), contacts, domains (incl. Entity
  categories), threads/thread summaries, curation and interest-profile state
  — in reality curation lives as columns on `contacts`/`domains` (carried
  with those rows) and `interest_profile` holds keywords (exported as its own
  table) — labels, sync_runs (last-run watermarks so the first remote sync is
  incremental, not a sweep). Worker-only tables (`google_tokens`, `jobs`,
  trigger rule tables) don't exist in the local export source and are never
  part of export/import. NDJSON not a sqlite file because D1
  can't attach a database — rows must replay through the driver anyway.
- Import into D1: `worker/`-side script (run via
  `wrangler d1 execute`-compatible batches or a Node script using the D1
  HTTP driver path — pick one, document it) that reads the NDJSON, verifies
  `schema_version` matches the target (`getUserVersion`), and replays rows in
  **bounded batches** (D1 has statement and batch-size limits; batch inserts
  via the 001 driver's atomic-list primitive, e.g. 500 rows per batch,
  resumable by line offset on failure). Import is idempotent: writes go
  through `Repo` upserts (`upsertMessage` preserves the no-downgrade body
  ladder), so re-running an interrupted import is safe.
- FTS rows are **not** exported: `messages_fts` is rebuilt on the target by
  the same projection (`projectFtsRow` — the FTS contract guarantees
  identical searchability from identical rows).
- Round-trip test: fixture-built local index → export → import into local D1
  → assert message counts, body states, summaries, curation rows, domain
  categories, and a `searchMessages` golden query all match.

## Acceptance criteria
- [ ] `mail-index export` produces NDJSON with header + all covered tables;
      refuses (with a clear error) on schema-version mismatch flags; never
      emits token or job rows.
- [ ] Import replays a real export into D1 in bounded batches; interrupting
      after N batches and re-running converges to the same final state
      (idempotency test).
- [ ] Round-trip equality test passes: counts per table, per-`body_state`
      counts, summary/curation/interest/category rows, and an FTS search
      return identical results on source and target.
- [ ] First remote sync after import is incremental: the import writes a
      completed `sync_runs` watermark row derived from the newest imported
      Message per account; the 006 cron derives its incremental `since` from
      that watermark (verified against fixtures — no full-mailbox sweep, no
      re-enrichment of summary-only Messages). This AC is verifiable only
      once 006 exists — 006 is a soft dependency of this ticket.
- [ ] Export of a multi-account index filtered by `--account` contains only
      that account's rows.
- [ ] Egress guard green (`export` is pure local I/O; the importer lives
      outside guarded core); all 34 existing test files green.

## Out of scope
- No reverse path (D1 → local import) in v1.
- No token/credential migration — operators reconnect Google via 005.
- No live-diff sync between deployments; one-shot seeding only.
- No compression/encryption of the dump file (operator handles transport).
