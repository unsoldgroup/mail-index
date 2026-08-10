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
import { CrmChangeFeed, publishMessageChanges } from './crm-feed.js';
import { notifyCrmCompletion } from './crm-webhook.js';
import { storeMessageAttachments } from './attachments.js';

export type JobKind = 'sync' | 'backfill' | 'enrich_bulk' | 'webhook_delivery';
export interface JobMessage { jobId: string; kind: JobKind; account: string; params: Record<string, unknown> }

const DEFAULT_LOOKBACK_MONTHS = 12;

function lookbackSince(months: number, now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

function configuredLookbackSince(env: Pick<Env, 'SYNC_LOOKBACK_MONTHS'>): string {
  const parsed = Number(env.SYNC_LOOKBACK_MONTHS ?? DEFAULT_LOOKBACK_MONTHS);
  const months = Number.isInteger(parsed) && parsed > 0 && parsed <= 120 ? parsed : DEFAULT_LOOKBACK_MONTHS;
  return lookbackSince(months);
}

export async function enqueueJob(env: Env, kind: JobKind, account: string, params: Record<string, unknown> = {}): Promise<string> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const existing = await driver.prepare(`SELECT id FROM jobs WHERE kind=? AND account=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(kind, account) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, kind, account, JSON.stringify(params), 'queued', '{}', new Date().toISOString());
  try { await env.SYNC_QUEUE.send({ jobId: id, kind, account, params }); }
  catch (error) {
    await driver.prepare(`UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?`).run('queue enqueue failed', new Date().toISOString(), id);
    throw error;
  }
  return id;
}

export function enqueueSyncJob(env: Env, account: string, since?: string): Promise<string> {
  return enqueueJob(env, 'sync', account, { since: since ?? configuredLookbackSince(env) });
}

export async function enqueueScheduledSyncs(env: Env): Promise<string[]> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const rows = await driver.prepare('SELECT account FROM google_tokens ORDER BY account').all() as { account: string }[];
  return Promise.all(rows.map(async (row) => {
    const watermark = await driver.prepare(`SELECT finished_at FROM sync_runs WHERE account=? AND phase='sync' AND finished_at IS NOT NULL AND error IS NULL ORDER BY finished_at DESC LIMIT 1`).get(row.account) as { finished_at: string } | undefined;
    const minimumSince = configuredLookbackSince(env);
    const since = watermark?.finished_at && watermark.finished_at > minimumSince ? watermark.finished_at : minimumSince;
    return enqueueSyncJob(env, row.account, since);
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
  console.log(JSON.stringify({ event: 'job_start', job_id: message.jobId, kind: message.kind }));
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
      let terminalCursor = await publishMessageChanges(
        new CrmChangeFeed(driver),
        repo,
        message.account,
        sync.messageIds,
        message.jobId,
      );
      const attachments = await storeMessageAttachments({ source, feed: new CrmChangeFeed(driver), bucket: env.ATTACHMENTS, account: message.account, messageIds: sync.messageIds, jobId: message.jobId });
      terminalCursor = attachments.lastCursor ?? terminalCursor;
      progress['crm'] = { published: sync.messageIds.length, attachments, terminal_cursor: terminalCursor ?? null };
      await update('running', progress);
      await notifyCrmCompletion({
        url: env.CRM_WEBHOOK_URL,
        secret: env.CRM_WEBHOOK_SECRET,
        payload: { account: message.account, terminalCursor: terminalCursor ?? null, jobId: message.jobId },
        fetchImpl,
      });
      const graphRun = await repo.startSyncRun({ account: message.account, phase: 'graph', selector: null });
      const graph = await buildGraph(repo, message.account);
      await repo.finishSyncRun(graphRun, { fetched: 0, indexed: graph.nodes });
      progress['graph'] = graph; await update('running', progress);
    } else {
      const enriched = await enrich({ account: message.account, source, repo, selector: { profile: true, ...(message.params['limit'] ? { limit: Number(message.params['limit']) } : {}) } });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched };
    }
    await update('done', progress);
    console.log(JSON.stringify({ event: 'job_finish', job_id: message.jobId, kind: message.kind, counts: logCounts(progress) }));
  } catch (error) {
    await update('failed', progress, error instanceof Error ? error.message : String(error));
    console.log(JSON.stringify({ event: 'job_fail', job_id: message.jobId, kind: message.kind, error_name: error instanceof Error ? error.name : 'Error' }));
    throw error;
  }
}

function logCounts(progress: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const phase of ['sync', 'triggers', 'enrich', 'crm', 'graph', 'delivery']) {
    const values = progress[phase]; if (!values || typeof values !== 'object') continue;
    for (const key of ['fetched', 'indexed', 'deliveries', 'enriched', 'nodes', 'edges', 'communities', 'delivered']) {
      const value = (values as Record<string, unknown>)[key];
      if (typeof value === 'number') out[`${phase}_${key}`] = value;
      else if (typeof value === 'boolean') out[`${phase}_${key}`] = value ? 1 : 0;
    }
  }
  return out;
}

export async function jobStatus(env: Env, account?: string) {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const where = account ? 'WHERE account=?' : '';
  const recent = await driver.prepare(`SELECT id,kind,account,status,progress_json,error,created_at,started_at,finished_at FROM jobs ${where} ORDER BY created_at DESC LIMIT 20`).all(...(account ? [account] : [])) as Record<string, unknown>[];
  const depth = await driver.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')${account ? ' AND account=?' : ''}`).get(...(account ? [account] : [])) as { n: number };
  const normalized: Record<string, unknown>[] = recent.map((row) => ({ ...row, progress: JSON.parse(String(row['progress_json'])), progress_json: undefined }));
  const lastCron = await driver.prepare(`SELECT created_at FROM jobs WHERE kind='sync'${account ? ' AND account=?' : ''} ORDER BY created_at DESC LIMIT 1`).get(...(account ? [account] : [])) as { created_at: string } | undefined;
  return { sync_interval: env.SYNC_INTERVAL, last_cron_run: lastCron?.created_at ?? null, queue_depth: depth.n, failed_jobs: normalized.filter((row) => row['status'] === 'failed'), recent: normalized };
}
