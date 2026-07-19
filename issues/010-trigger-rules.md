# M4: Implement Trigger rules with signed webhook delivery

## Context
Depends on 006: Job engine (evaluation hooks into the sync pipeline; delivery
retries ride Queues) and 008: tool parity (new tools join the same TOOLS
registry, gated by 007 OAuth).
Read first: CONTEXT.md **Trigger rule** — use its predicate list *exactly*:
"category, `is_list`, Correspondent status, Interest profile membership,
label, sender/domain, subject/FTS terms — evaluated against newly synced
Messages". The differentiator vs provider filters: rules can reference what
the index knows ("curated-important Correspondent wrote"). Avoid the words
"filter" and "alert". Also docs/PLAN-worker.md decision #8, ADR-0009.

## Decision
Remote-Deployment feature: D1 schema for rules + consumers, CRUD via new MCP
tools, evaluation inside the sync Job, HMAC-signed at-least-once webhook
delivery.

- Migration (next schema version): two tables.
  - `trigger_rules`: `id` TEXT PK, `name`, `account` (nullable = all
    accounts), `predicate_json`, `consumer_ids_json`, `enabled` INTEGER,
    `created_at`, `updated_at`.
  - `webhook_consumers`: `id` TEXT PK, `url`, `secret` (HMAC key,
    operator-supplied at registration; stored like any index data — D1 at
    rest, not in Worker secrets since consumers are data, not deployment
    config), `created_at`. Rules reference consumers via
    `trigger_rules.consumer_ids_json` (small N; no join table).
- Predicate model (`predicate_json`): a conjunction of typed conditions, one
  discriminated union per CONTEXT.md predicate: `category` (one of
  `CATEGORIES` from `src/index/schema.ts`), `is_list` (bool),
  `correspondent` (bool — `msgs_sent > 0` via contact lookup),
  `interest_profile` (curation membership — all of `CURATIONS`
  (`important`|`muted`|`blocked`) are valid predicate values),
  `label` (label id/name), `from_addr`/`from_domain`, `subject_fts` (terms
  through the FTS contract's `buildMatch` from `src/index/fts.ts`).
  Evaluation module lives in guarded `src/` (pure — takes a Repo + message
  rows, returns matches) so it is unit-testable without the Worker.
- Pipeline hook: after a sync Job's metadata phase, evaluate enabled rules
  **against the newly synced Messages only** (the upsert results of that
  run — new ids, not the whole index). `SyncResult` today exposes only counts
  (`src/ingest/sync.ts`) — this ticket extends the sync path to surface newly
  synced Message ids to the rule evaluator. Matches enqueue a
  `webhook_delivery` Job per (rule, consumer, message batch).
- Delivery: POST JSON `{ delivery_id (stable UUID per delivery),
  rule: {id,name}, matches: [message summary shape — id, account, from,
  subject, date, category, labels], delivered_at }` with
  `X-MailIndex-Signature: sha256=<hex HMAC of raw body>` and
  `X-MailIndex-Timestamp` (unix seconds) with a 5-minute replay window
  (013's threat-model section cites this). At-least-once via Queues retries;
  consumer failure (non-2xx) throws so the queue redelivers; deliveries are
  idempotent for consumers via the stable `delivery_id` in the body.
- New MCP tools in `TOOLS` (CRUD): `trigger_rule_save` (create/update from
  predicate fields), `trigger_rule_list`, `trigger_rule_delete`,
  `webhook_consumer_register`, `webhook_consumer_delete`. Remote-Deployment
  tools: on local, they return a clear not-available-on-this-Deployment
  error (rules require the webhook path).

## Acceptance criteria
- [ ] Migration adds both tables; `SCHEMA_VERSION` bumped; local tests green.
- [ ] Predicate evaluator unit tests cover every CONTEXT.md predicate type,
      including the flagship compound: curated-important Correspondent +
      category — and confirm evaluation sees only newly synced Messages
      (pre-existing rows never re-fire).
- [ ] A sync Job over fixtures with a matching rule produces an HTTP POST to
      a test consumer with a valid HMAC (recomputed in the test) and the
      documented payload shape.
- [ ] A 500-ing consumer causes redelivery (Queues retry observed); a
      2xx stops it.
- [ ] CRUD tools appear in `toolList()`, round-trip via the worker MCP
      endpoint, and validate predicates (bad category name rejected).
- [ ] FTS predicate goes through `buildMatch` (no ad-hoc MATCH string
      building — FTS contract respected).
- [ ] Egress guard: webhook POSTs happen in worker//queue consumer code or a
      pinned seam, never in guarded core; guard test green.

## Out of scope
- No provider-side filters, Gmail labels-as-triggers, or push (`users.watch`).
- No delivery dashboard/UI; `sync_status` job visibility is enough.
- No per-rule rate limiting or digest batching windows.
- No local-Deployment rule engine.
