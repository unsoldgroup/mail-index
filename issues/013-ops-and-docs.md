# M4: Ship remote ops and docs — threat model, install guide, status polish, push design note

## Context
Depends on all of 001–012 ("13 last") — it documents and hardens what they
built.
Read first: ADR-0008 (the costs it promises to state plainly — this ticket
redeems that promise in the threat model), docs/THREAT-MODEL.md (current
local-only posture), docs/INSTALL.md + docs/agent-install.md (the local
guides the worker guide mirrors), docs/oauth-and-verification.md, CONTEXT.md
(Deployment, Trigger rule).

## Decision
Four deliverables, no new features:

- **Threat model, remote section** (extend docs/THREAT-MODEL.md): the widened
  posture "never leaves infrastructure you own"; what the Worker holds
  (AES-GCM-encrypted refresh tokens in D1, key only in Worker secrets — a D1
  export alone is useless); index data at rest on Cloudflare (D1 encryption,
  operator's account); the new audited seams (gmail-rest fetch, D1 driver,
  webhook egress) vs the still-network-free `src/` core and how
  `test/egress-guard.test.ts` pins them; MCP surface exposure (007 OAuth +
  operator allowlist as the whole authz model); webhook consumer trust
  (HMAC, replay window, at-least-once duplicates); what an attacker gets
  from each compromised component (Cloudflare account, Google client,
  consumer endpoint). Honest deltas from the local model, per ADR-0008 —
  no soft-pedaling.
- **docs/INSTALL-worker.md**: end-to-end operator deploy guide — Cloudflare
  prerequisites (paid Workers plan per ADR-0009), create D1 + Queues + KV,
  BYO Google Cloud OAuth client setup (per oauth-and-verification.md Option
  B), `wrangler secret put` list (TOKEN_ENC_KEY generation command included),
  vars (`OPERATOR_EMAILS`, `SYNC_INTERVAL` + cron), deploy, `/setup` account
  connect (readonly and the `--enable-writes`-equivalent re-consent),
  claude.ai remote-connector registration steps (recorded in 007), seeding
  from a local index (012), verification checklist (`/healthz`,
  `sync_status`, first cron run in the Cloudflare dashboard — 004's wrangler
  config sets observability `head_sampling_rate: 1`; 013 verifies it is
  still set).
- **Status/observability polish**: `sync_status` (and `mail-index status`
  where it applies) reads cleanly on the remote Deployment — last cron run,
  queue depth, per-job progress, failed-job surfacing with the error;
  `/healthz` includes schema version and migration state; structured
  `console.log` lines on job start/finish/fail so Workers Logs are
  greppable (no mailbox content in logs — assert in a test).
- **Gmail-push fast-follow design note** (docs/research/ or docs/adr/ draft,
  not an accepted ADR): how `users.watch` + Pub/Sub push slots into the 006
  seam — the push webhook route calls the same "enqueue sync job for account
  since watermark" entry point; watch renewal (7-day expiry) as a cron job;
  Pub/Sub JWT verification; interaction with the polling cron (poll becomes
  the fallback). Explicitly NOT implemented in this ticket.

## Acceptance criteria
- [ ] docs/THREAT-MODEL.md gains a remote Deployment section covering every
      bullet above; local section's claims updated where ADR-0008 amended
      them (no silently contradicted claim remains).
- [ ] docs/INSTALL-worker.md exists; a clean-room follow-through (fresh
      Cloudflare account or scripted dry-run) reaches a working connector —
      checklist included in the doc. Verification = a committed checklist run
      log (docs/ or the PR description) from executing the guide top-to-bottom
      on a fresh Cloudflare account or scripted dry-run.
- [ ] `sync_status` on the Worker shows last cron run, queue depth, and
      failed jobs with errors (test over fixtures with an injected failure).
- [ ] A test asserts job log lines contain ids/counts but never subject,
      body, address, or snippet content.
- [ ] The Gmail-push design note exists and names the 006 entry point it
      would call; no push code shipped.
- [ ] README.md mentions the remote Deployment option and links
      INSTALL-worker.md; all 34+ test files green.

## Out of scope
- No Gmail push implementation.
- No new tools, schema changes, or Worker features.
- No multi-region/HA guidance, no Terraform/IaC for the Cloudflare resources.
- No Google OAuth verification (CASA) guidance beyond what
  oauth-and-verification.md already says.
