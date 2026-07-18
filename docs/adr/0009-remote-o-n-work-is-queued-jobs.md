# On the remote Deployment, O(N) work is a queued Job, not a Command handback

[ADR-0001](0001-inline-enrichment-is-o1-only.md)'s rule — inline tool calls
are O(1), O(N) work is handed off — survives the remote Deployment, but its
mechanism can't: a Command handback returns a `mail-index` CLI command, and a
Worker has no CLI for the agent to run. Remotely, a tool that would hand back
a command instead **enqueues a Job** (Cloudflare Queues; the queue consumer is
the same Worker) and returns a job id; `sync_status` reports queue depth and
per-job progress. Scheduled cron sync and on-demand refresh flow through the
same Job path, so there is exactly one execution engine per Deployment: the
CLI locally, the queue remotely.

Chosen over chunked-inline-with-continuation-token (burns agent turns and MCP
round-trips on large backfills, and every tool grows pagination state) and
over cron-only catch-up (agents couldn't request a backfill or bulk Enrichment
when they actually need it). Costs: requires the Workers paid plan (which D1
scale and cron already imply), Jobs are at-least-once so consumers must be
idempotent (upserts by (account, provider message id) already are), and
progress reporting needs a small job table in D1 that has no local
counterpart.
