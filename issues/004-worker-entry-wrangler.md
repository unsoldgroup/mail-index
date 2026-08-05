# M2: Create the worker/ entry and wrangler config serving streamable-HTTP MCP

## Context
Depends on 001: Extract async StorageDriver and 002: D1 StorageDriver.
Read first: docs/PLAN-worker.md (decisions #1, #2, #11 — #11 excludes the
self-update shim), ADR-0008 (Worker lives outside the egress-guarded core),
CONTEXT.md (Deployment).

The MCP engine to reuse lives in `src/mcp/server.ts`: the `TOOLS` registry
(single source of truth binding name → schema → handler), `dispatch()`,
`toolList()`, and `buildServer(ctx: ToolContext): Server`. Note:
`serveHttp(opts: HttpServeOptions)` implements streamable HTTP **on
`node:http`** (`createServer` + the SDK's `StreamableHTTPServerTransport`
keyed by session id). A Worker has no `node:http` server — what transfers is
`buildServer`/`dispatch`/the transport-per-session pattern, not `serveHttp`'s
listener. Budget a small transport shim (see Decision).

## Decision
A `worker/` directory at repo root — **outside `src/`**, so the egress guard's
core claim is untouched — plus wrangler config.

- `worker/index.ts`: the Workers `fetch` handler. Routes:
  - `POST/GET/DELETE /mcp` (the MCP route path) → streamable-HTTP MCP built from
    `buildServer(ctx)` with a `ToolContext` wired to the D1 driver (002) and
    the gmail-rest source (003; a stub token provider until 005).
    Transport: use the MCP SDK's Workers/fetch-compatible streamable HTTP
    transport if the installed SDK version provides one; otherwise a thin
    Request/Response adapter around `StreamableHTTPServerTransport`,
    mirroring `serveHttp`'s session map. Keep it in one file so 007 can wrap
    it with OAuth unchanged.
  - `GET /healthz` → 200 JSON: version, schema version (from the storage
    driver's schema-version accessor — not the node:sqlite-only
    `getUserVersion` signature), uptime-free liveness only (no mailbox data).
- `worker/wrangler.jsonc`:
  - D1 binding `DB` for the index database; queue `mail-index-jobs` with
    producer + consumer bindings as `SYNC_QUEUE` (consumer wired in 006 —
    declare now so config churn is once); KV namespace binding `OAUTH_KV`
    reserved for OAuth (007);
  - `observability: { enabled: true, head_sampling_rate: 1 }` (non-negotiable
    per operator convention);
  - secrets documented by name (values via `wrangler secret put`):
    `TOKEN_ENC_KEY` (005), Google client id/secret (005), dev bearer (below);
  - `nodejs_compat` flag as required by the MCP SDK.
- Auth: none yet. A clearly-temporary dev-only bearer check is allowed
  (`DEV_BEARER_TOKEN` secret; constant-time compare; file-level comment
  "TEMPORARY — replaced by 007 MCP OAuth"). Requests without it get 401.
- Exclusions per PLAN-worker.md decision #11: no self-update/launch shim (`bin/selfupdate.mjs`,
  `bin/launch.mjs` are local-only), no `spawnDetachedSync` path.
- Build: `worker/` compiles via wrangler's bundler against the compiled or
  source `src/` modules; `npm run typecheck` covers it (own tsconfig if the
  Workers lib types conflict with the Node build).

## Acceptance criteria
- [ ] `worker/index.ts` and `worker/wrangler.jsonc` exist; `wrangler dev`
      serves an MCP endpoint that answers `initialize`, `tools/list` (same
      payload as local `toolList()`), and at least one `tools/call`
      round-trip against a seeded local-D1 database.
- [ ] `GET /healthz` returns 200 with version + schema version.
- [ ] Observability block present with `head_sampling_rate: 1`.
- [ ] D1 + Queues bindings declared; missing-binding startup fails loudly.
- [ ] Requests without the dev bearer are rejected 401; the stub is marked
      TEMPORARY in code and config comments.
- [ ] `src/` diff is zero or type-only for this ticket; egress-guard test
      untouched and green (guard does not scan `worker/`; extending it to pin
      worker seams is 013's ops polish if needed).
- [ ] All 34 existing test files remain green; a worker smoke test (Miniflare
      or `wrangler dev` scripted) exercises healthz + tools/list.

## Out of scope
- No MCP OAuth (`workers-oauth-provider`) — that's 007; the bearer stub dies
  there.
- No Google OAuth connect flow or token storage (005).
- No cron trigger, queue consumer logic, or jobs table (006).
- No tool-parity guarantees — some tools may return not-implemented until 008.
- No production deploy docs (013).
