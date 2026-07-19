# Remote Deployment plan — mail-index on Cloudflare Workers

Status: decided (interview 2026-07-17/18), tickets in GitHub Issues.
Read with [CONTEXT.md](../CONTEXT.md), [ADR-0008](adr/0008-self-hosted-remote-deployment.md),
[ADR-0009](adr/0009-remote-o-n-work-is-queued-jobs.md).

The Worker is an **additional deployment option**. The local CLI/stdio path
stays first-class and unchanged in behavior.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Tenancy | Single-tenant, self-hosted on the operator's own Cloudflare account. No hosted service, no multi-tenant. |
| 2 | Repo shape | One package. Extract an **async StorageDriver** (node:sqlite impl + D1 impl) alongside the existing `MailSource` contract (gog/gws CLI impls + new **Gmail REST** impl). `worker/` entry + wrangler config in-repo, outside the egress-guarded `src/` core; guard extended to pin the new seams. |
| 3 | Google auth | BYO Google Cloud OAuth client (oauth-and-verification.md Option B). Worker runs the OAuth flow itself; refresh tokens AES-GCM-encrypted (key in Worker secrets), ciphertext in D1. Multi-account supported. `gmail.readonly` default; `gmail.modify` opt-in re-consent (ADR-0007 semantics). |
| 4 | MCP auth | Full MCP OAuth (`workers-oauth-provider`). Consent/login step = Google sign-in restricted to an operator email allowlist (same identity as the mailbox). Works as a claude.ai remote connector. |
| 5 | Sync signal | Cron Trigger polling, **operator-customizable interval** (default 15 min; cron expression + `SYNC_INTERVAL` var). Entry point shaped so Gmail `users.watch` + Pub/Sub push slots in as a fast-follow without rework. |
| 6 | O(N) work | Queued **Jobs** (Cloudflare Queues, same-Worker consumer) replace Command handbacks remotely; job id returned, progress via `sync_status`. Workers paid plan assumed. (ADR-0009) |
| 7 | V1 scope | **Full parity with local** (the entire `TOOLS` registry — 25 tools at time of writing — incl. graph, cadence, interest, writes) **plus** webhook triggers and a minimal A2A surface. |
| 8 | Trigger rules | Index-aware structured predicates (category, `is_list`, Correspondent, Interest profile, label, from/domain, subject/FTS). Evaluated in the sync pipeline against newly synced Messages; on match, HMAC-signed POST to registered consumer URLs; retries via Queues. |
| 9 | A2A | `/.well-known/agent-card.json` + synchronous `message/send` wrapping the same engine as the MCP tools. No long-running A2A task lifecycle in v1. |
| 10 | Seeding | `mail-index export` from a local index + an import path into D1, so summaries/curation/interest carry over without re-backfill. |
| 11 | Migrations | Same forward-only migrations (schema v9+) run against D1 at deploy/first-request; no self-update process remotely. |
| 12 | Trust posture | ADR-0008: "never leaves infrastructure you own." Threat model gains a remote section. |

## Deltas that need care (from codebase map)

- Repo/db layer (`src/index/`) is synchronous `node:sqlite` → the whole
  storage API goes **async** (D1 forces it); local impl wraps sync calls.
- Freshness auto-refresh uses a **detached child process** (`spawnDetachedSync`,
  ADR-0005) → remotely becomes `ctx.waitUntil`/Job enqueue. Freshness block on
  every response is preserved.
- Self-update launch shim is meaningless on Workers → excluded from `worker/`.
- graphology (louvain) is pure JS → portable, but graph rebuild must respect
  Worker CPU limits (raise `limits.cpu_ms`, chunk if needed).
- FTS5 on D1: supported, but the FTS contract module must not assume
  `node:sqlite` specifics — verify porter tokenizer + bm25 weights behave
  identically; bench harness (`bench/`) should run against both drivers.
- `wrangler` config must enable observability (`head_sampling_rate: 1`) per
  operator convention.

## Milestones → tickets

**M1 Portability foundation** (no behavior change locally)
1. Extract async StorageDriver; port `src/index/` call sites; node:sqlite impl; all tests green.
2. D1 StorageDriver + migrations-on-D1 runner; FTS contract verified on D1 (bench subset).
3. Gmail REST `MailSource` adapter (injectable fetch + token provider); egress-guard extension pinning the new seams.

**M2 Worker skeleton**
4. `worker/` entry + wrangler config: streamable-HTTP MCP reusing the `buildServer`/dispatch engine behind a small fetch-Request/Response transport shim (`serveHttp` itself binds `node:http` and doesn't transfer), `/healthz`, D1/Queues bindings, secrets, observability.
5. Google OAuth connect flow: setup pages, token encryption in D1, multi-account, `--enable-writes`-equivalent re-consent.
6. Cron sync + Job engine: queue consumer running sync→enrich→graph, job table, customizable interval, `sync_status` over jobs.

**M3 MCP auth + parity**
7. MCP OAuth via workers-oauth-provider; Google-sign-in consent + operator allowlist.
8. Tool parity: the whole `TOOLS` registry on the Worker; freshness via waitUntil/Jobs; handbacks → job ids; write tools gated on modify grant.
9. Intelligence layer on Worker: graph/cadence/interest within CPU limits (chunked rebuild if needed).

**M4 Triggers, A2A, ops**
10. Trigger rules: D1 schema, CRUD tools, sync-pipeline evaluation, signed webhook delivery with retries.
11. A2A surface: agent card + `message/send`.
12. Seed path: `mail-index export` + D1 import.
13. Ops & docs: remote threat-model section, deploy guide (INSTALL-worker), status/observability polish, Gmail-push fast-follow design note.

Dependencies: 1→2→(4,6); 3→(5,6); 4→7→8; 6→(8,10); 8→9; 10→11 (shares engine); 12 after 2; 13 last.

## Implementation mode

Implementation will run as a **Workflow** (multi-agent orchestration) using
**Opus subagents** (`model: 'opus'` per `agent()` call), one milestone per
workflow phase, with adversarial verify on each ticket's acceptance criteria.
