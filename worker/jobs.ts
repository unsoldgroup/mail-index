/** Remote O(N) execution engine. Cron and future Gmail push both call enqueueSyncJob. */
import { D1Driver } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { runMigrations } from '../src/index/migrations.js';
import { syncMetadata } from '../src/ingest/sync.js';
import { enrich } from '../src/ingest/enrich.js';
import { buildGraph } from '../src/graph/index.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';
import { accessTokenProvider } from './google-oauth.js';
import { markQueueEnqueueFailed } from './job-state.js';
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

const JOB_STALE_AFTER_MS = 6 * 60 * 60_000;

export async function enqueueJob(env: Env, kind: JobKind, account: string, params: Record<string, unknown> = {}): Promise<string> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const now = new Date(); const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - JOB_STALE_AFTER_MS).toISOString();
  await driver.prepare(`UPDATE jobs SET status='failed',terminal=1,error=?,finished_at=?
    WHERE kind=? AND account=? AND status IN ('queued','running')
      AND COALESCE(started_at,created_at) < ?`)
    .run('stale Job lock expired after 6 hours', nowIso, kind, account, staleBefore);
  const existing = await driver.prepare(`SELECT id FROM jobs WHERE kind=? AND account=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(kind, account) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, kind, account, JSON.stringify(params), 'queued', '{}', nowIso);
  try { await env.SYNC_QUEUE.send({ jobId: id, kind, account, params }); }
  catch (error) {
    await markQueueEnqueueFailed(driver, id);
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
  const row = await driver.prepare('SELECT status,kind,account,params_json,terminal FROM jobs WHERE id=?').get(message.jobId) as { status: string; kind: JobKind; account: string; params_json: string; terminal: number } | undefined;
  if (!row) throw new Error(`Unknown Job ${message.jobId}`);
  if (row.status === 'done' || row.terminal === 1) return;
  const job: JobMessage = { jobId: message.jobId, kind: row.kind, account: row.account, params: JSON.parse(row.params_json) as Record<string, unknown> };
  const update = async (status: string, progress: object, error?: string) => {
    const now = new Date().toISOString();
    await driver.prepare(`UPDATE jobs SET status=?,progress_json=?,error=?,started_at=COALESCE(started_at,?),finished_at=? WHERE id=?`)
      .run(status, JSON.stringify(progress), error ?? null, now, status === 'done' || status === 'failed' ? now : null, message.jobId);
  };
  const source = new GmailRestAdapter({ fetchImpl, tokenProvider: accessTokenProvider(driver, job.account, env, fetchImpl) });
  const progress: Record<string, unknown> = {};
  console.log(JSON.stringify({ event: 'job_start', job_id: job.jobId, kind: job.kind }));
  await update('running', progress);
  try {
    if (job.kind === 'webhook_delivery') {
      await deliverWebhook(driver, job.params as unknown as DeliveryParams, fetchImpl);
      progress['delivery'] = { delivered: true, delivery_id: job.params['deliveryId'] };
    } else if (job.kind === 'sync' || job.kind === 'backfill') {
      const sync = await syncMetadata({
        account: job.account,
        source,
        repo,
        scope: typeof job.params['since'] === 'string' ? { since: job.params['since'] } : undefined,
      });
      progress['sync'] = { fetched: sync.fetched, indexed: sync.indexed }; await update('running', progress);
      progress['triggers'] = { deliveries: await evaluateRules(env, driver, repo, job.account, sync.messageIds) }; await update('running', progress);
      const enriched = await enrich({ account: job.account, source, repo, selector: { rule: 'direct' } });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched }; await update('running', progress);
      let terminalCursor = await publishMessageChanges(
        new CrmChangeFeed(driver),
        repo,
        job.account,
        sync.messageIds,
        job.jobId,
      );
      const attachments = await storeMessageAttachments({ source, feed: new CrmChangeFeed(driver), bucket: env.ATTACHMENTS, account: job.account, messageIds: sync.messageIds, jobId: job.jobId });
      terminalCursor = attachments.lastCursor ?? terminalCursor;
      progress['crm'] = { published: sync.messageIds.length, attachments, terminal_cursor: terminalCursor ?? null };
      await update('running', progress);
      await notifyCrmCompletion({
        url: env.CRM_WEBHOOK_URL,
        secret: env.CRM_WEBHOOK_SECRET,
        payload: { account: job.account, terminalCursor: terminalCursor ?? null, jobId: job.jobId },
        fetchImpl,
      });
      const graphRun = await repo.startSyncRun({ account: job.account, phase: 'graph', selector: null });
      const graph = await buildGraph(repo, job.account);
      await repo.finishSyncRun(graphRun, { fetched: 0, indexed: graph.nodes });
      progress['graph'] = graph; await update('running', progress);
    } else {
      const enriched = await enrich({ account: job.account, source, repo, selector: { profile: true, ...(job.params['limit'] ? { limit: Number(job.params['limit']) } : {}) } });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched };
    }
    await update('done', progress);
    console.log(JSON.stringify({ event: 'job_finish', job_id: job.jobId, kind: job.kind, counts: logCounts(progress) }));
  } catch (error) {
    await update('failed', progress, error instanceof Error ? error.message : String(error));
    console.log(JSON.stringify({ event: 'job_fail', job_id: job.jobId, kind: job.kind, error_name: error instanceof Error ? error.name : 'Error' }));
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
  const recent = await driver.prepare(`SELECT id,kind,account,status,terminal,progress_json,error,created_at,started_at,finished_at FROM jobs ${where} ORDER BY created_at DESC LIMIT 20`).all(...(account ? [account] : [])) as Record<string, unknown>[];
  const depth = await driver.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')${account ? ' AND account=?' : ''}`).get(...(account ? [account] : [])) as { n: number };
  const normalized: Record<string, unknown>[] = recent.map((row) => ({ ...row, progress: JSON.parse(String(row['progress_json'])), progress_json: undefined }));
  const lastCron = await driver.prepare(`SELECT created_at FROM jobs WHERE kind='sync'${account ? ' AND account=?' : ''} ORDER BY created_at DESC LIMIT 1`).get(...(account ? [account] : [])) as { created_at: string } | undefined;
  return { sync_interval: env.SYNC_INTERVAL, last_cron_run: lastCron?.created_at ?? null, queue_depth: depth.n, failed_jobs: normalized.filter((row) => row['status'] === 'failed'), recent: normalized };
}
