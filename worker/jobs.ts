/** Remote O(N) execution engine. Cron and future Gmail push both call enqueueSyncJob. */
import { D1Driver } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { runMigrations } from '../src/index/migrations.js';
import { windowCutoff, nextBackfillSlice, BACKFILL_FLOOR } from '../src/index/settings.js';
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

export type JobKind = 'sync' | 'backfill' | 'backfill_slice' | 'enrich_bulk' | 'retention' | 'graph' | 'webhook_delivery';
export interface JobMessage { jobId: string; kind: JobKind; account: string; params: Record<string, unknown> }

/**
 * The kinds that ride the SWEEP Queue rather than the jobs Queue.
 *
 * A `sync` is unbounded O(mailbox) work: in production one holds its consumer
 * slot for 8-15 minutes and sometimes dies at the Workers 15-minute wall limit.
 * With one slot per connected mailbox, syncs held EVERY slot for most of the
 * hour, so these four sat queued until their 50-minute lease expired and were
 * reaped as "queued Job was never delivered" — the UNS-1335 starvation.
 *
 * Splitting by "does this contend with a sync" rather than by cost: all four are
 * already bounded and resumable (ADR-0009/ADR-0010), so their own Queue drains
 * on its own budget no matter how long a sync runs. `webhook_delivery` stays on
 * the jobs Queue — it is small and latency-sensitive, not a sweep.
 */
const SWEEP_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['enrich_bulk', 'retention', 'backfill_slice', 'graph']);

/**
 * Fall back to SYNC_QUEUE when SWEEP_QUEUE is unbound, so a Worker deployed
 * before `wrangler queues create mail-index-sweeps` still works — degraded to
 * the old single-Queue behaviour rather than dropping the Job.
 */
function queueFor(env: Env, kind: JobKind) {
  return SWEEP_KINDS.has(kind) ? env.SWEEP_QUEUE ?? env.SYNC_QUEUE : env.SYNC_QUEUE;
}

const DEFAULT_LOOKBACK_MONTHS = 12;

function lookbackSince(months: number, now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

function configuredLookbackSince(env: Pick<Env, 'SYNC_LOOKBACK_MONTHS'>): string {
  const parsed = Number(env.SYNC_LOOKBACK_MONTHS ?? DEFAULT_LOOKBACK_MONTHS);
  // Ceiling raised to 50 years: this is only the FLOOR for the incremental
  // watermark, and a low ceiling silently truncated coverage back to the
  // default whenever a larger value was configured.
  const months = Number.isInteger(parsed) && parsed > 0 && parsed <= 600 ? parsed : DEFAULT_LOOKBACK_MONTHS;
  return lookbackSince(months);
}

/**
 * How long a RUNNING Job may sit before the next enqueue treats it as a corpse.
 *
 * This is a LEASE, not a timeout: a Job killed mid-flight by a Worker CPU or
 * subrequest limit never reaches `failed`, and the de-dupe below would hand its
 * id back to every later cron tick forever. The lease must therefore be shorter
 * than the cron period (hourly), or one wedged Job silently costs a whole cycle
 * of syncs — which is exactly how an Account went five days without indexing.
 */
const JOB_RUNNING_LEASE_MS = 15 * 60_000;

/**
 * How long a QUEUED Job may wait before it is presumed undeliverable.
 *
 * A Job that has never STARTED cannot have died mid-flight — it is simply
 * waiting its turn behind the other sweeps, and reaping it destroys work that
 * was about to happen. Measured in production: syncs run ~8 minutes, so a Job
 * queued behind two of them routinely waits ~17 minutes. Sharing the running
 * lease killed two thirds of every tick's work.
 *
 * This bound therefore exists only for the genuine case — a message lost to a
 * deploy or a purge, where the row would otherwise block its Account forever.
 * It sits just under the cron period, so a lost Job costs one cycle and no more.
 */
const JOB_QUEUED_LEASE_MS = 50 * 60_000;

/**
 * How many Messages one working-set Job touches per run.
 *
 * Both sweeps are O(mailbox), so they must never try to finish in one
 * invocation — a Worker isolate killed by the CPU or subrequest limit leaves
 * its Job wedged (that is the failure this whole change set exists to prevent).
 * Bounded batches make each run cheap and the work resumable: every tick drains
 * a slice, and the sweep goes quiet once nothing is left.
 */
const RETENTION_BATCH = 200;
const BACKFILL_BATCH = 100;

/**
 * Correspondent fan-out for a historical slice. The chunk keeps each provider
 * `from:{…}` query short enough for Gmail to accept, and the cap stops a
 * mailbox with thousands of Correspondents from turning one slice into
 * thousands of requests — the strongest ties are swept first (see
 * `correspondentAddresses`), and the rest are reached on later passes.
 */
const CORRESPONDENT_CHUNK = 25;
const CORRESPONDENT_CAP = 500;

export async function enqueueJob(env: Env, kind: JobKind, account: string, params: Record<string, unknown> = {}): Promise<string> {
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const now = new Date(); const nowIso = now.toISOString();
  // Two leases, because "wedged" and "waiting" are different conditions. A
  // RUNNING Job that stopped reporting is a corpse holding a lock. A QUEUED Job
  // has not started at all — it is behind the other sweeps, and reaping it
  // throws away work that was about to happen.
  const runningBefore = new Date(now.getTime() - JOB_RUNNING_LEASE_MS).toISOString();
  const queuedBefore = new Date(now.getTime() - JOB_QUEUED_LEASE_MS).toISOString();
  await driver.prepare(`UPDATE jobs SET status='failed',terminal=1,error=?,finished_at=?
    WHERE kind=? AND account=? AND status='running' AND started_at < ?`)
    .run(`stale Job lock expired after ${Math.round(JOB_RUNNING_LEASE_MS / 60_000)} minutes`, nowIso, kind, account, runningBefore);
  await driver.prepare(`UPDATE jobs SET status='failed',terminal=1,error=?,finished_at=?
    WHERE kind=? AND account=? AND status='queued' AND created_at < ?`)
    .run('queued Job was never delivered', nowIso, kind, account, queuedBefore);
  const existing = await driver.prepare(`SELECT id FROM jobs WHERE kind=? AND account=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(kind, account) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id, kind, account, JSON.stringify(params), 'queued', '{}', nowIso);
  try { await queueFor(env, kind).send({ jobId: id, kind, account, params }); }
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
  // An Account whose grant Google has already rejected as `invalid_grant` cannot
  // sync until someone re-consents, and its doomed retry is also the MOST
  // expensive one: with no successful watermark the `since` below falls back to
  // the full lookback window, so every hour would replay a 12-month sweep that
  // can only fail. Skip it until the grant is repaired (see markAuthFailed).
  const rows = await driver.prepare('SELECT account FROM google_tokens WHERE auth_error IS NULL ORDER BY account').all() as { account: string }[];
  const ids = await Promise.all(rows.map(async (row) => {
    const watermark = await driver.prepare(`SELECT finished_at FROM sync_runs WHERE account=? AND phase='sync' AND finished_at IS NOT NULL AND error IS NULL ORDER BY finished_at DESC LIMIT 1`).get(row.account) as { finished_at: string } | undefined;
    const minimumSince = configuredLookbackSince(env);
    const since = watermark?.finished_at && watermark.finished_at > minimumSince ? watermark.finished_at : minimumSince;
    return enqueueSyncJob(env, row.account, since);
  }));
  // The working-set sweeps are deliberately NOT queued here. Every enqueue is an
  // INSERT followed by a SYNC_QUEUE.send, and the sends are buffered until the
  // invocation ends — so a cron that runs out of CPU part-way leaves committed
  // `queued` rows with no message behind them, which is exactly the "Job never
  // delivered" reap we were seeing hourly. The sync hands them off instead (see
  // runJob), which both shrinks this invocation and moves the enqueue inside a
  // Job that has already proven it can reach the provider.
  //
  // NOTE: this is still one Promise.all over Accounts, and a failed send
  // rethrows — one bad Account can strand the ones not yet reached. Per-account
  // allSettled is the upgrade path if that ever bites; at one enqueue per
  // Account the window is small enough to leave alone.
  return ids;
}

/**
 * Keep each Account's working set at its configured shape: fill in bodies inside
 * the retention window, evict the ones that fell out of it.
 *
 * These are chained off each Account's completed sync rather than queued by the
 * cron, one bounded batch per Account per successful sync, so the window
 * converges over a few cycles instead of one enormous run. The Job-level
 * de-dupe means a batch still draining is never doubled up.
 *
 * The cadence is therefore "per sync that reached the provider", not "per cron
 * tick" as ADR-0010 originally stated — see the amendment there for why.
 */
export async function enqueueWorkingSetJobs(env: Env, driver: D1Driver, accounts: readonly string[]): Promise<string[]> {
  const repo = new Repo(driver);
  const queued: string[] = [];
  for (const account of accounts) {
    const settings = await repo.getAccountSettings(account);
    // An unconfigured window means the operator has not chosen a policy yet;
    // the defaults apply, which is a 3-month working set.
    if (windowCutoff(settings) != null) queued.push(await enqueueJob(env, 'enrich_bulk', account, { limit: BACKFILL_BATCH }));
    if (settings.retention === 'window') queued.push(await enqueueJob(env, 'retention', account, { limit: RETENTION_BATCH }));
    // NOTE: the historical slice is deliberately NOT queued here. It contends
    // with the sync for the Account lock, and the cron enqueues sync first, so a
    // slice queued now would find the Account busy and yield — every tick,
    // forever. The sync hands it off on completion instead (see runJob).
  }
  return queued;
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
      // The graph is rebuilt over the WHOLE mailbox, so it is O(N) work and
      // belongs in its own Job (ADR-0009) rather than the tail of every sync
      // tick. Inline, it was the phase most likely to exhaust the invocation's
      // CPU budget on a large Account — killing the isolate before this Job
      // could mark itself done, which is what left rows stuck at `running`.
      progress['graph'] = { queued_job: await enqueueJob(env, 'graph', job.account, {}) };

      // Hand off the next historical slice HERE rather than from the cron. Both
      // take the Account lock this sync is still holding, so queueing them
      // together means the slice always loses the race and yields. Chained, it
      // runs once this Job releases the lock — the same shape as the graph
      // handoff above.
      const backfillSettings = await repo.getAccountSettings(job.account);
      const slice = nextBackfillSlice(backfillSettings);
      if (slice) progress['backfill_next'] = { queued_job: await enqueueJob(env, 'backfill_slice', job.account, slice), ...slice };

      // Chained for the reasons above, plus one of its own: enrich_bulk takes
      // the Account lock this Job still holds, so queued from the cron it found
      // the Account busy and yielded every tick.
      progress['working_set'] = { queued_jobs: await enqueueWorkingSetJobs(env, driver, [job.account]) };
      await update('running', progress);
    } else if (job.kind === 'backfill_slice') {
      // One historical slice, swept by CORRESPONDENCE rather than wholesale.
      //
      // Deep history is dominated by bulk mail — a decade of newsletters is
      // volume without recall value, and indexing it wholesale is what turns a
      // 220k-message mailbox into days of provider calls. What earns its place
      // is mail you took part in: everything you SENT, plus mail from the people
      // you sent it to. Two passes give exactly that.
      const since = String(job.params['since'] ?? '');
      const until = String(job.params['until'] ?? '');
      let fetched = 0;
      let indexed = 0;

      // Losing the race for the Account lock is normal, not a failure: history
      // is not going anywhere, so yield the tick. Note this deliberately does
      // NOT advance the cursor — that would silently SKIP a year of mail.
      if (await yieldIfBusy(repo, job.account, 'backfill', progress, update, job)) return;

      // Pass 1 — everything sent in the slice. Cheap, and it is what discovers
      // (and scores) the Correspondents pass 2 depends on.
      const sent = await syncMetadata({ account: job.account, source, repo, scope: { since, until, query: 'in:sent' } });
      fetched += sent.fetched; indexed += sent.indexed;
      progress['backfill_sent'] = { fetched: sent.fetched, indexed: sent.indexed, since, until };
      await update('running', progress);

      // Pass 2 — received mail from known Correspondents, in chunked provider
      // queries so one `from:(…)` never grows unbounded.
      const correspondents = await repo.correspondentAddresses(job.account, CORRESPONDENT_CAP);
      for (let i = 0; i < correspondents.length; i += CORRESPONDENT_CHUNK) {
        const chunk = correspondents.slice(i, i + CORRESPONDENT_CHUNK);
        const received = await syncMetadata({
          account: job.account,
          source,
          repo,
          scope: { since, until, query: `from:{${chunk.join(' ')}}` },
        });
        fetched += received.fetched; indexed += received.indexed;
      }
      progress['backfill'] = { fetched, indexed, since, until, correspondents: correspondents.length };

      // Advance the cursor even on an empty slice: the sweep walks backwards
      // through time, and empty years are exactly what it must walk PAST.
      const done = since <= BACKFILL_FLOOR;
      await repo.setAccountSettings(job.account, { backfill_cursor: since, backfill_done: done });
      progress['backfill_cursor'] = { cursor: since, done };
      await update('running', progress);
    } else if (job.kind === 'graph') {
      // startSyncRun is the non-atomic open, so this row IS the Account's sync
      // lock until it closes. Without the finally a throwing buildGraph leaves
      // it open, and activeSyncRun then reports the Account busy for the full
      // STALE_LOCK_MS window — blocking every later sync behind a failure.
      const graphRun = await repo.startSyncRun({ account: job.account, phase: 'graph', selector: null });
      let graph;
      try {
        graph = await buildGraph(repo, job.account);
      } finally {
        await repo.finishSyncRun(graphRun, { fetched: 0, indexed: graph?.nodes ?? 0 });
      }
      progress['graph'] = graph;
    } else if (job.kind === 'retention') {
      // Evict bodies that aged out of the working set. Bounded per run so the
      // sweep can never exhaust the isolate's CPU budget; whatever it does not
      // reach this tick, the next one does.
      const settings = await repo.getAccountSettings(job.account);
      const cutoff = windowCutoff(settings, new Date());
      let evicted = 0;
      if (settings.retention === 'window' && cutoff != null) {
        const limit = Number(job.params['limit'] ?? RETENTION_BATCH);
        for (const id of await repo.retentionEligible(job.account, cutoff, limit)) {
          if (await repo.evictBody(job.account, id)) evicted += 1;
        }
      }
      progress['retention'] = { evicted, cutoff };
    } else {
      // enrich takes the same Account lock as sync, so yield rather than fail
      // when the cron's own sync is still running.
      if (await yieldIfBusy(repo, job.account, 'enrich', progress, update, job)) return;
      // Backfill bodies INSIDE the working set. `since` comes from the same
      // windowCutoff the retention sweep uses — if the two ever disagreed, the
      // boundary messages would be re-fetched and re-dropped every cycle.
      const settings = await repo.getAccountSettings(job.account);
      const cutoff = windowCutoff(settings, new Date());
      //
      // Inside the window the policy is "everything readable", not "everything
      // the interest profile happens to match" — an empty profile is exactly why
      // an Account could hold 10k messages and 33 bodies. With the window off we
      // fall back to the profile, which is the pre-window behaviour.
      const enriched = await enrich({
        account: job.account,
        source,
        repo,
        selector: {
          ...(cutoff != null ? { rule: 'all' as const, since: cutoff } : { profile: true }),
          ...(job.params['limit'] ? { limit: Number(job.params['limit']) } : {}),
        },
      });
      progress['enrich'] = { fetched: enriched.fetched, enriched: enriched.enriched };
    }
    await update('done', progress);
    console.log(JSON.stringify({ event: 'job_finish', job_id: job.jobId, kind: job.kind, counts: logCounts(progress) }));
  } catch (error) {
    await update('failed', progress, error instanceof Error ? error.message : String(error));
    // error_code is the first token of the message — enough to see `invalid_grant`
    // in Workers logs without ever emitting Message content (see the log-leak test).
    console.log(JSON.stringify({ event: 'job_fail', job_id: job.jobId, kind: job.kind, error_name: error instanceof Error ? error.name : 'Error', error_code: errorCode(error) }));
    throw error;
  }
}

/**
 * A machine-readable code for a failure, or null when the message has none.
 *
 * Only a bare lower_snake_case trailing segment qualifies — the shape of an
 * OAuth/API error code (`invalid_grant`, `rate_limit_exceeded`). Anything with
 * spaces, capitals or punctuation is prose, which may quote Message content and
 * must never reach a log line (ADR-0002).
 */
/**
 * Skip this run when another Job already holds the Account's sync lock.
 *
 * `sync`, `enrich_bulk` and `backfill_slice` all take it, and the cron queues
 * them together, so collisions are routine rather than exceptional. Reporting
 * one as a FAILURE is what made a healthy tick look broken. The sweep simply
 * runs on the next tick; callers must not advance any cursor when this returns
 * true.
 */
async function yieldIfBusy(
  repo: Repo,
  account: string,
  phase: string,
  progress: Record<string, unknown>,
  update: (status: string, progress: object, error?: string) => Promise<void>,
  job: JobMessage,
): Promise<boolean> {
  if (await repo.activeSyncRun(account) == null) return false;
  progress[phase] = { skipped: 'account busy' };
  await update('done', progress);
  console.log(JSON.stringify({ event: 'job_finish', job_id: job.jobId, kind: job.kind, counts: {} }));
  return true;
}

function errorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const tail = message.split(':').pop()?.trim() ?? '';
  return /^[a-z][a-z0-9_]{2,40}$/.test(tail) ? tail : null;
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
