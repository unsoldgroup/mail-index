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

## Amendment — 2026-08-18, UNS-1335

Queued Jobs alone were not enough: they need **separate Queues** when their
durations differ by an order of magnitude.

A `sync` Job is still unbounded O(mailbox) work. In production one holds its
consumer slot for 8–15 minutes, and one was observed dying at the Workers
15-minute wall limit (`899,982ms`, `outcome: exceededWallTime`). With a single
Queue capped at one invocation per connected mailbox, syncs held every slot for
most of the hour. The bounded sweeps — `enrich_bulk`, `retention`,
`backfill_slice`, `graph` — sat queued until their 50-minute lease expired and
were reaped as "queued Job was never delivered", while the cron that enqueued
them reported `outcome: ok` with 47ms of CPU. The symptom looked like lost
messages; it was concurrency starvation.

So the split is now by **contention, not cost**: anything that would queue behind
a sync rides `mail-index-sweeps` with its own concurrency budget, and
`mail-index-jobs` carries `sync`, `backfill` and `webhook_delivery`. Both stay at
`max_batch_size: 1`.

This bounds the blast radius rather than removing the cause. A `sync` that runs
for 15 minutes still dies at the wall limit and still leaves its row `running`
until the next tick's lease reaps it — it just no longer takes the sweeps down
with it. Slicing the sync itself, the way `backfill_slice` already is, remains the
real fix and is deliberately not attempted here.
