import type { StorageDriver } from '../src/index/driver.js';

export async function markQueueEnqueueFailed(driver: StorageDriver, jobId: string): Promise<void> {
  await driver.prepare(`UPDATE jobs SET status='failed',terminal=1,error=?,finished_at=? WHERE id=?`)
    .run('queue enqueue failed', new Date().toISOString(), jobId);
}
