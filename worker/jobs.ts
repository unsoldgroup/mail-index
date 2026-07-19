/** Remote O(N) execution engine. Cron and future Gmail push both call enqueueSyncJob. */
import { D1Driver } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { runMigrations } from '../src/index/migrations.js';
import { syncMetadata } from '../src/ingest/sync.js';
import { enrich } from '../src/ingest/enrich.js';
import { buildGraph } from '../src/graph/index.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';
import { accessTokenProvider } from './google-oauth.js';
import type { Env } from './index.js';
import { deliverWebhook, evaluateRules, type DeliveryParams } from './triggers.js';

export type JobKind = 'sync' | 'backfill' | 'enrich_bulk' | 'webhook_delivery';
export interface JobMessage { jobId: string; kind: JobKind; account: string; params: Record<string, unknown> }

export async function enqueueJob(env: Env, kind: JobKind, account: string, params: Record<string, unknown> = {}): Promise<string> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const existing = await driver.prepare(`SELECT id FROM jobs WHERE kind=? AND account=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(kind, account) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, kind, account, JSON.stringify(params), 'queued', '{}', new Date().toISOString());
  await env.SYNC_QUEUE.send({ jobId: id, kind, account, params });
  return id;
}

export function enqueueSyncJob(env: Env, account: string, since?: string): Promise<string> {
  return enqueueJob(env, 'sync', account, since ? { since } : {});
}

export async function enqueueScheduledSyncs(env: Env): Promise<string[]> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const rows = await driver.prepare('SELECT account FROM google_tokens ORDER BY account').all() as { account: string }[];
  return Promise.all(rows.map(async (row) => {
    const watermark = await driver.prepare(`SELECT finished_at FROM sync_runs WHERE account=? AND phase='sync' AND finished_at IS NOT NULL AND error IS NULL ORDER BY finished_at DESC LIMIT 1`).get(row.account) as { finished_at: string } | undefined;
    return enqueueSyncJob(env, row.account, watermark?.finished_at);
  }));
}

export async function runJob(env: Env, message: JobMessage, fetchImpl: typeof fetch = fetch): Promise<void> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const repo = new Repo(driver);
  const row = await driver.prepare('SELECT status FROM jobs WHERE id=?').get(message.jobId) as { status: string } | undefined;
  if (!row) throw new Error(`Unknown Job ${message.jobId}`);
  if (row.status === 'done') return;
  const update = async (status: string, progress: object, error?: string) => {
    const now = new Date().toISOString();
    await driver.prepare(`UPDATE jobs SET status=?,progress_json=?,error=?,started_at=COALESCE(started_at,?),finished_at=? WHERE id=?`)
      .run(status, JSON.stringify(progress), error ?? null, now, status === 'done' || status === 'failed' ? now : null, message.jobId);
  };
  const source = new GmailRestAdapter({ fetchImpl, tokenProvider: accessTokenProvider(driver, message.account, env, fetchImpl) });
  const progress: Record<string, unknown> = {};
  await update('running', progress);
  try {
    if (message.kind === 'webhook_delivery') {
      await deliverWebhook(driver, message.params as unknown as DeliveryParams, fetchImpl);
      progress['delivery'] = { delivered: true, delivery_id: message.params['deliveryId'] };
    } else if (message.kind === 'sync' || message.kind === 'backfill') {
      const sync = await syncMetadata({ account: message.account, source, repo, scope: typeof message.params['since'] === 'string' ? { since: message.params['since'] } : undefined });
      progress['sync'] = { fetched: sync.fetched, indexed: sync.indexed }; await update('running', progress);
      progress['triggers'] = { deliveries: await evaluateRules(env, driver, repo, message.account, sync.messageIds) }; await update('running', progress);
      const enriched = await enrich({ account: message.account, source, repo, selector: { rule: 'direct' } });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched }; await update('running', progress);
      const graphRun = await repo.startSyncRun({ account: message.account, phase: 'graph', selector: null });
      const graph = await buildGraph(repo, message.account);
      await repo.finishSyncRun(graphRun, { fetched: 0, indexed: graph.nodes });
      progress['graph'] = graph; await update('running', progress);
    } else {
      const enriched = await enrich({ account: message.account, source, repo, selector: { profile: true, ...(message.params['limit'] ? { limit: Number(message.params['limit']) } : {}) } });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched };
    }
    await update('done', progress);
  } catch (error) {
    await update('failed', progress, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function jobStatus(env: Env, account?: string) {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const where = account ? 'WHERE account=?' : '';
  const recent = await driver.prepare(`SELECT id,kind,account,status,progress_json,error,created_at,started_at,finished_at FROM jobs ${where} ORDER BY created_at DESC LIMIT 20`).all(...(account ? [account] : [])) as Record<string, unknown>[];
  const depth = await driver.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')${account ? ' AND account=?' : ''}`).get(...(account ? [account] : [])) as { n: number };
  return { sync_interval: env.SYNC_INTERVAL, queue_depth: depth.n, recent: recent.map((row) => ({ ...row, progress: JSON.parse(String(row['progress_json'])), progress_json: undefined })) };
}
