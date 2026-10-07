import { Repo } from '../src/index/repo.js';
import type { StorageDriver } from '../src/index/driver.js';

/** Worker sync writers run only in Queue consumers. Their hard wall limit is
 * 15 minutes including I/O; twenty minutes preserves five minutes of margin.
 * https://developers.cloudflare.com/queues/platform/limits/
 * Deployment requires the current Paid consumer plan, not legacy Bundled with
 * unlimited queue duration. Never use this shorter lease for HTTP-owned syncs.
 * Unfinished rows are retained as audit evidence; local callers keep six hours.
 */
export const WORKER_SYNC_LOCK_MAX_AGE_MS = 20 * 60_000;

export function workerRepository(driver: StorageDriver): Repo {
  return new Repo(driver, { syncLockMaxAgeMs: WORKER_SYNC_LOCK_MAX_AGE_MS });
}
