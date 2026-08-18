# Cron fan-out dies partway, stranding most Jobs [UNS-1335]

## Problem

Most scheduled Jobs never run. Their `jobs` rows exist as `queued`, but no Queue
message is ever delivered for them.

Evidence (2026-08-18, worker `0bd78f63`):

- 14:00 tick inserted 9 rows. Exactly **one** (`sync`/unsold-group) was ever
  consumed. The other 8 sat `queued` for 59+ minutes with `started_at IS NULL`.
- Clearing the wedged running Job and its `sync_runs` lock changed nothing — so
  this is NOT our Account lock.
- `wrangler tail` during the stall shows **zero** queue invocations while the
  consumer is still attached (`wrangler queues info` reports 1 consumer).
- Overnight the same signature produced 133 `stale Job lock expired` reaps.
- It is worst immediately after a deploy, when a cold isolate also runs
  migrations.

## Root cause (HYPOTHESIS — confirm before building)

`enqueueScheduledSyncs` does all fan-out inside one `scheduled()` `waitUntil`:
per Account it runs `runMigrations`, a watermark query, `getAccountSettings`,
then N× (`INSERT` row + `SYNC_QUEUE.send`). The row insert precedes the send, so
an invocation that dies mid-loop leaves rows with no message behind them —
exactly what is observed.

### Confirm first (do not skip)

1. `wrangler tail mail-index --format json` across a top-of-hour tick; capture
   the `scheduled` event. Look for `outcome != "ok"` (`exceededCpu`,
   `exceptionThrown`, `canceled`) or a `cron_fail` log line.
2. Cross-check counts: rows inserted by that tick vs queue invocations observed.
   Rows > invocations confirms the hypothesis.
3. If `outcome` is `ok` and messages still never arrive, STOP — the cause is
   Cloudflare-side delivery, not our fan-out, and this plan does not apply.
   Record the finding and re-plan.

## Fix

Shrink the cron to the smallest possible unit of work and chain the rest, the
pattern already used for `graph` and `backfill_slice` (`worker/jobs.ts`).

- `enqueueScheduledSyncs` enqueues **one** Job per Account (`sync`) and nothing
  else. No `getAccountSettings`, no working-set logic in the cron path.
- The `sync` Job, on completion, chains `enrich_bulk` and `retention` for its own
  Account, alongside the `graph` and `backfill_slice` handoffs it already does.
- Net: cron work drops from ~9 enqueues + 3 settings reads to 3 enqueues, and
  every remaining enqueue happens inside a Job invocation that has already
  proven it can reach the provider.

Ordering note: chaining means the working-set sweeps run AFTER the sync releases
the Account lock, which also removes the `account busy` yields they currently
hit.

## Files

- `worker/jobs.ts` — `enqueueScheduledSyncs` (drop the working-set fan-out),
  `enqueueWorkingSetJobs` (call from the sync branch of `runJob` instead of the
  cron), sync branch of `runJob` (add the two handoffs next to `graph`).
- `test/worker-jobs.test.ts` — update `cron enqueues one sync Job per connected
  Account` to assert kinds `['sync']` only; add a test that a completed sync
  chains `enrich_bulk`, `retention`, `graph` and `backfill_slice`.

## Verification

1. `npm run typecheck && npm run lint && npm test` (Node 24; tests import
   `dist/` + `dist-worker/`, so build first — `pretest` does this).
2. After deploy, at the next top-of-hour tick:
   - every `jobs` row created by the tick reaches `running` (not stuck `queued`);
   - `SELECT count(*) FROM jobs WHERE status='queued' AND created_at < now-10min`
     is 0;
   - `personal` and `unsold-group` gain an `account_settings.backfill_cursor`,
     and `min(internal_date)` steps back — the backfill finally advancing is the
     end-to-end proof.

## Rollback

Single commit, revert-safe. Reverting restores cron fan-out; no schema change, no
data migration.

## Out of scope

- The post-deploy consumption gap, if it survives this fix — file separately.
- Queue `max_concurrency` / `max_batch_size` (already tuned; leave alone).
- Any change to the retention or backfill algorithms.

## Context for the executing agent

- Deploys are NOT part of this task. Stop at a merged PR; Al deploys with
  `npx wrangler deploy --config worker/wrangler.production.jsonc`.
- Read-only prod inspection is fine and encouraged:
  `npx wrangler d1 execute mail-index --remote --config worker/wrangler.production.jsonc --json --command "..."`.
- Do NOT purge the queue or mass-update `jobs`/`sync_runs` on prod; that is
  operator recovery, not part of the fix.
- Branch `uns-1335-cron-fanout`, PR title referencing [UNS-1335].
