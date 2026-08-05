# Handover — finish the Worker deployment (Codex)

Goal: implement tickets 002–013 on branch `worker-deployment`, then push, open a
PR, and merge to `main`. Ticket 001 is done. Read this file top-to-bottom before
touching code.

## Read first (in order)

1. `docs/PLAN-worker.md` — every locked product decision, milestones, dependency graph. Authoritative; do not re-litigate.
2. `CONTEXT.md` — domain glossary. Use its terms exactly (Message, Enrichment, Job, Trigger rule, Deployment, Correspondent, FTS contract).
3. `docs/adr/0008-self-hosted-remote-deployment.md`, `0009-remote-o-n-work-is-queued-jobs.md` (+ 0001, 0005, 0007 when a ticket cites them).
4. The ticket file for whatever you are implementing: `issues/001…013-*.md`. Each is self-contained (Context / Decision / Acceptance criteria / Out of scope) and cold-audited — an implementer should never need to guess. GitHub issues #12–#24 mirror these files 1:1 (001→#12 … 013→#24, mapping in `issues/README.md`).

## Current state (verified 2026-07-18)

- Branch `worker-deployment`, 3 commits ahead of `main`:
  - `9101184` docs: plan + ADRs + tickets
  - `cb9d52f` test: egress-guard now pins `mcp/server.ts` `node:http` as an audited seam (`SRC_NETWORK_ALLOW`) — this failure pre-dated the branch; do not "fix" it back
  - `120f8ce` ticket 001 complete: async `StorageDriver` (`src/index/driver.ts`) + node:sqlite impl (`src/index/drivers/sqlite.ts`), whole call graph async, 386 tests green at that commit
- **Ticket 002 is HALF DONE, uncommitted in the working tree**: `src/index/drivers/d1.ts`, `test/storage-driver.test.js`, `bench/RESULTS-D1.md`, edits to `package.json` (adds `miniflare`), `src/index/index.ts`, `src/index/migrations.ts`, plus a regenerated `package-lock.json` (commit it — old lock hit an npm ERESOLVE/null-matches bug; regenerated with `--legacy-peer-deps`).
- `node_modules` is installed and Miniflare works in THIS environment. Current suite: 391 tests, 389 pass, **2 fail** (both D1 conformance — see next section).

## Immediate task: finish ticket 002

Both failures are one root cause: **D1 `exec()` treats every newline as a
statement boundary**, so any multi-line SQL dies with
`D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS schema_version (: incomplete input`.
Broken call sites in `src/index/drivers/d1.ts`: `#ensureVersionTable()` (the
multi-line `VERSION_TABLE` template at line ~36) and `exec()`'s fall-through
`await this.db.exec(sql)` (line ~112), which receives multi-line migration DDL.

Fix: normalize SQL before handing it to D1 — split on `;`, collapse
intra-statement newlines/whitespace to single spaces, drop empty statements,
re-join. Safe here because the schema has **no triggers / BEGIN…END blocks**
(the only `BEGIN` is the transaction control at `src/index/migrations.ts:494`,
already turned into a no-op by `TRANSACTION_CONTROL` in the D1 driver).
Alternatively route each normalized statement through `prepare().run()`.

Then: `npm run build && node --test test/storage-driver.test.js && npm test`
until **all 391 pass**, and re-run the FTS-parity bench so `bench/RESULTS-D1.md`
records a real D1 result (it currently records a blocked run). Commit as
`feat(index): D1 StorageDriver with migrations + FTS conformance (#13)`.

## Loop for tickets 003–013 (one at a time, in order)

003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013. The order
encodes the dependency graph — do not reorder or parallelize.

Per ticket:
1. Read the ticket file fully, incl. Out of scope.
2. Implement. Build on prior tickets' code; never rework a committed ticket except where the ticket explicitly says so (e.g. 007 replaces 004's dev-bearer stub, 008 swaps handbacks for Job ids).
3. Write the tests the acceptance criteria name. Node built-in runner only.
4. `npm run build` + `npm test` fully green before every commit — no skips, no `.only`.
5. Self-check every acceptance checkbox; anything not satisfiable, say so in the commit/PR notes rather than silently dropping it.
6. Commit: `feat(worker): <summary> (#<issue>)` (issue numbers: 003→#14 … 013→#24).

## Environment gotchas (all hit already — don't rediscover them)

- `npm install` needs `--legacy-peer-deps` (knip/eslint-utils peer conflict).
- Tests leak temp dirs into the repo (`mail-index-setup-*`, `mail-index-cfg-*`, `mi-cli-*`, `mi-init-*`, `node-compile-cache/`). Delete before committing; never `git add -A` from the repo root without checking `git status` first. Also never commit: `CLAUDE.md`, `.claude/`, `.config/`.
- Sandboxed runs may block `spawnSync`/network — if `cli.test.ts`/`smoke.test.ts` fail with EPERM under YOUR sandbox but the code is untouched, they are environment failures, not regressions (they pass here).
- `wrangler`/Miniflare: workerd needs to bind 127.0.0.1; if your sandbox forbids it, escalate rather than fake results. Do not fabricate bench numbers — record blocked runs as blocked.
- Cloudflare account creds: `CLOUDFLARE_ACCOUNT_ID` + API tokens live in Bitwarden Secrets (`bws`); no real deploy is required for any acceptance criterion — Miniflare covers 004–013 testing.

## Finish line (after 013)

1. Full suite green, tree clean, temp dirs removed.
2. `git push -u origin worker-deployment`
3. `gh pr create --title "Remote Worker deployment: D1 + Gmail REST + MCP OAuth + triggers (#12–#24)" --body "Closes #12, #13, #14, #15, #16, #17, #18, #19, #20, #21, #22, #23, #24"` — body must also summarize per-milestone changes and note the two pre-existing fixes (egress guard, lockfile).
4. Merge the PR into `main` (merge commit, not squash — per-ticket history is the audit trail). Al has already authorized the merge.
5. `gh` is authenticated as `al-unsoldgroup`; repo is `unsoldgroup/mail-index`.

## Product guardrails (non-negotiable, from the ADRs)

- Local deployment behavior must not change: CLI + stdio MCP + node:sqlite stay first-class; every existing test keeps passing.
- `src/` core stays egress-free; new network code lives only in seams the egress guard explicitly pins (`SRC_NETWORK_ALLOW` / adapter seams). Extend the guard, never waive it.
- No secrets in code or committed files, ever. Tokens: AES-GCM in D1, key in Worker secrets (ticket 005).
- Worker `wrangler` config must enable observability (`head_sampling_rate: 1`).
- No mail-index-operated hosting assumptions; single-tenant, operator-owned everything.
