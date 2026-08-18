import type { StorageDriver } from '../src/index/driver.js';
import type { JobKind } from './jobs.js';

interface QueueLike { send(message: unknown): Promise<void> }

/**
 * The kinds that ride the SWEEP Queue rather than the jobs Queue.
 *
 * A `sync` is unbounded O(mailbox) work: in production one holds its consumer
 * slot for 8-15 minutes, and one was caught dying at the Workers 15-minute WALL
 * limit. With one slot per connected mailbox on a single Queue, syncs held EVERY
 * slot for most of the hour, so these four sat queued until their 50-minute
 * lease expired and were reaped as "queued Job was never delivered" — the
 * UNS-1335 starvation.
 *
 * Split by "does this contend with a sync" rather than by cost: all four are
 * already bounded and resumable (ADR-0009/ADR-0010), so their own Queue drains
 * on its own budget no matter how long a sync runs. `webhook_delivery` stays on
 * the jobs Queue — it is small and latency-sensitive, not a sweep.
 */
const SWEEP_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['enrich_bulk', 'retention', 'backfill_slice', 'graph']);

/**
 * The Queue a Job of this kind belongs on.
 *
 * Lives here rather than in jobs.ts because triggers.ts enqueues too, and a
 * routing rule only one of two callers applies is a routing rule that drifts.
 */
export function queueFor(env: { SYNC_QUEUE: QueueLike; SWEEP_QUEUE: QueueLike }, kind: JobKind): QueueLike {
  return SWEEP_KINDS.has(kind) ? env.SWEEP_QUEUE : env.SYNC_QUEUE;
}

export async function markQueueEnqueueFailed(driver: StorageDriver, jobId: string): Promise<void> {
  await driver.prepare(`UPDATE jobs SET status='failed',terminal=1,error=?,finished_at=? WHERE id=?`)
    .run('queue enqueue failed', new Date().toISOString(), jobId);
}
