# M3: Reach full MCP tool parity on the Worker

## Context
Depends on 004 (worker MCP endpoint), 006 (Job engine — handbacks and
auto-refresh become Jobs), 007 (OAuth in front), 005 (stored `scopes` for
write gating).
Read first: ADR-0001 (inline is O(1) only), ADR-0005 **including its
2026-07-01 amendment** (freshness block on every response; any stale
account-scoped read auto-refreshes), ADR-0009 (handback → Job), ADR-0007
(write tools opt-in), CONTEXT.md (Command handback, Job, Inline enrichment).

The single tool registry is `TOOLS` in `src/mcp/server.ts` — currently **25**
tools: search, list_labeled, refresh_inbox, get_message, get_thread,
list_contacts, get_contact, find_person, list_threads, graph_neighbors,
graph_communities, interest_propose, interest_set, interest_get, save_summary,
domains_to_categorize, save_domain_category, cadence, sync_status,
relay_menu_status, sync_now, catch_up, digest_sources, archive_message,
modify_labels. (PLAN-worker.md says "the entire TOOLS registry — 25 tools at
time of writing"; parity means **the whole TOOLS registry**, not a frozen
count.) Handlers live in `src/mcp/tools.ts`
(`ToolContext`, `Freshness`, `STALE_AFTER_MS` = 3 h, `handback(...)` builder,
`BackgroundSync` = the `spawnDetachedSync` seam from `src/mcp/server.ts`).

## Decision
Every tool in `TOOLS` works on the Worker through the same
`buildServer(ctx)`; the Deployment differences are injected via
`ToolContext`, never forked handlers.

- Generalise the two local-only seams in `ToolContext`:
  - `BackgroundSync` (today `spawnDetachedSync(account, since)`): worker
    implementation enqueues a 006 sync Job inside `ctx.waitUntil` and returns
    true. ADR-0005 amendment preserved in spirit: stale account-scoped reads
    still return current data immediately with the freshness block
    (`index_as_of`, `sync_started`) on every response, refresh runs in the
    background; the debounce/lock (in-progress `sync_runs` + job dedupe)
    carries over.
  - `handback(...)` (Command handback strings): on the remote Deployment the
    same decision points enqueue a Job and return `{ job_id, status,
    poll: 'sync_status' }` instead of a CLI string (ADR-0009). Introduce one
    `ToolContext` capability (e.g. `enqueueJob?: (kind, account, params) =>
    Promise<string>`) — handlers branch on its presence, so local behavior
    is byte-identical.
- Write tools (`archive_message`, `modify_labels`): gated on the account's
  stored grant including `gmail.modify` (005 `scopes` column) — without it,
  return the same guidance-shaped error the local ADR-0007 path gives
  (pointing at the `/setup` re-consent URL instead of
  `mail-index setup --enable-writes`). With it, flow through the gmail-rest
  adapter's `modify` seam.
- Inline enrichment stays O(1) on the Worker (`get_message` may fetch one
  body via the adapter; thread-wide enrichment enqueues — ADR-0001).
- Golden parity test: for each tool name in `TOOLS`, call it via the worker
  endpoint against a fixture-seeded D1 and assert the response shape matches
  the local dispatch result (reusing the exported `dispatch`/`toolList`
  helpers), modulo the documented handback→job_id substitution.

## Acceptance criteria
- [ ] `toolList()` served by the Worker equals the local list (every current
      TOOLS entry present, none stubbed).
- [ ] Parity test passes for all tools against fixture data on D1.
- [ ] A stale `catch_up`/`digest_sources`/account-scoped read on the Worker
      returns immediately with the freshness block and enqueues exactly one
      sync Job (dedupe verified on repeat calls within the debounce window).
- [ ] No tool response on the remote Deployment contains a `mail-index` CLI
      command string; O(N) paths return a job id readable via `sync_status`.
- [ ] `archive_message`/`modify_labels` refused without the modify grant
      (guidance error), succeed with it (fixture adapter observes the
      `LabelChange`).
- [ ] Local Deployment behavior unchanged: all 34 existing test files
      green, `spawnDetachedSync` and Command handbacks still the local
      mechanisms.

## Out of scope
- No graph/cadence/interest CPU-limit work beyond "the tool answers" — heavy
  rebuild tuning is 009.
- No new tools (Trigger-rule CRUD is 010).
- No changes to tool schemas or local response shapes.
