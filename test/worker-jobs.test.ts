import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant } from '../dist-worker/worker/google-oauth.js';
import { enqueueJob, enqueueScheduledSyncs, jobStatus, runJob } from '../dist-worker/worker/jobs.js';
import worker from '../dist-worker/worker/index.js';
import { evaluateRules, triggerAdmin } from '../dist-worker/worker/triggers.js';
import { nextBackfillSlice, BACKFILL_FLOOR } from '../dist/index/settings.js';

const key = Buffer.alloc(32, 4).toString('base64');

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const sent: unknown[] = [];
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async (m: unknown) => { sent.push(m); } }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  await saveGrant(driver, { account: 'acct-a', address: 'a@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], refreshToken: 'refresh', key });
  return { mf, env, driver, sent };
}

const gmailFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
  if (url.endsWith('/profile')) return Response.json({ emailAddress: 'a@example.com' });
  if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'm1' }] });
  if (url.includes('/messages/m1')) return Response.json({ id: 'm1', threadId: 't1', internalDate: '1717000000000', labelIds: ['INBOX'], snippet: 'hello', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'person@example.com' }, { name: 'To', value: 'a@example.com' }, { name: 'Subject', value: 'Hello' }], body: { data: Buffer.from('Hello body').toString('base64url') } } });
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

test('cron enqueues one sync Job per connected Account without Gmail', async () => {
  const { mf, env, sent } = await fixture();
  try {
    let pending: Promise<unknown> | undefined;
    worker.scheduled({}, env, { waitUntil(promise: Promise<unknown>) { pending = promise; }, passThroughOnException() {} });
    await pending;
    const kinds = sent.map((message) => (message as { kind: string }).kind);
    // The cron queues the sync and NOTHING else. Every other kind is chained off
    // the completed sync, so a cron invocation that dies part-way can strand at
    // most the Accounts it had not reached — never a whole tick's sweeps.
    assert.deepEqual(kinds, ['sync']);
    const params = (sent[0] as { params: Record<string, unknown> }).params;
    assert.equal(typeof params['since'], 'string');
    const ageDays = (Date.now() - Date.parse(String(params['since']))) / 86_400_000;
    assert.ok(ageDays > 360 && ageDays < 380, `expected a 12-month lookback, got ${ageDays} days`);
  }
  finally { await mf.dispose(); }
});

test('the historical backfill walks backwards a slice at a time and stops at the floor', async () => {
  const { mf, driver } = await fixture();
  try {
    const repo = new Repo(driver);
    const first = nextBackfillSlice(await repo.getAccountSettings('acct-a'), new Date('2026-08-17T00:00:00Z'));
    assert.equal(first?.until, '2026-08-17');
    assert.equal(first?.since, '2025-08-17', 'one year per slice');

    // Each completed slice moves the cursor earlier.
    await repo.setAccountSettings('acct-a', { backfill_cursor: first.since });
    const second = nextBackfillSlice(await repo.getAccountSettings('acct-a'));
    assert.equal(second?.until, '2025-08-17');
    assert.equal(second?.since, '2024-08-17');

    // Approaching the floor clamps rather than overshooting into empty years.
    await repo.setAccountSettings('acct-a', { backfill_cursor: '2004-06-01' });
    const last = nextBackfillSlice(await repo.getAccountSettings('acct-a'));
    assert.equal(last?.since, BACKFILL_FLOOR, 'the final slice stops at the floor');

    // At the floor the sweep is over — no more slices, ever.
    await repo.setAccountSettings('acct-a', { backfill_cursor: BACKFILL_FLOOR, backfill_done: true });
    assert.equal(nextBackfillSlice(await repo.getAccountSettings('acct-a')), null);
  } finally { await mf.dispose(); }
});

test('a completed sync hands off the next historical slice', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await enqueueScheduledSyncs(env);
    const syncMessage = sent.find((m) => (m as { kind: string }).kind === 'sync') as never;
    await runJob(env, syncMessage, gmailFetch);

    // Queued by the sync itself, so it starts only once the Account lock is
    // free. Queued by the cron instead, it would find the Account busy and
    // yield on every tick — which is exactly what starved it in production.
    const slice = sent.find((m) => (m as { kind: string }).kind === 'backfill_slice') as { params: Record<string, unknown> } | undefined;
    assert.ok(slice, 'the sync hands off a historical slice');
    assert.ok(typeof slice.params['since'] === 'string' && typeof slice.params['until'] === 'string');

    const repo = new Repo(driver);
    assert.equal((await repo.getAccountSettings('acct-a')).backfill_done, false);
  } finally { await mf.dispose(); }
});

test('a completed sync chains every follow-up Job the cron used to queue', async () => {
  const { mf, env, sent } = await fixture();
  try {
    await enqueueScheduledSyncs(env);
    assert.deepEqual(sent.map((m) => (m as { kind: string }).kind), ['sync'], 'the cron queues the sync alone');

    const syncMessage = sent.find((m) => (m as { kind: string }).kind === 'sync') as never;
    await runJob(env, syncMessage, gmailFetch);

    // Everything the cron used to fan out now rides the tail of a Job that has
    // already reached the provider, so a cron invocation dying part-way can no
    // longer leave `queued` rows with no Queue message behind them.
    const kinds = sent.map((m) => (m as { kind: string }).kind);
    for (const kind of ['enrich_bulk', 'retention', 'graph', 'backfill_slice']) {
      assert.ok(kinds.includes(kind), `the sync hands off ${kind}, got ${kinds.join(',')}`);
    }
  } finally { await mf.dispose(); }
});

test('a backfill slice sweeps sent mail and Correspondents, not the whole year', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    const queries: string[] = [];
    const recordingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/messages?')) queries.push(decodeURIComponent(new URL(url).searchParams.get('q') ?? ''));
      return gmailFetch(input as never);
    }) as typeof fetch;

    const repo = new Repo(driver);
    // A Correspondent has to be DERIVED, not asserted: aggregation rebuilds
    // contacts from the indexed messages, so a hand-inserted contact row with no
    // mail behind it is (correctly) discarded. Seed the sent message instead —
    // which is exactly how pass 1 creates the Correspondents pass 2 then sweeps.
    await repo.upsertMessage({
      account: 'acct-a', gmailMessageId: 'sent-1', threadId: 'ts', internalDate: Date.parse('2024-06-01T00:00:00Z'),
      fromAddr: 'a@example.com', toAddr: 'friend@example.com', subject: 'hello', direction: 'sent',
      isList: false, unread: false, starred: false, important: false, snippet: 'hi', bodyText: null, bodyState: 'meta',
    });
    const jobId = await enqueueJob(env, 'backfill_slice', 'acct-a', { since: '2024-01-01', until: '2025-01-01' });
    await runJob(env, sent.find((m) => (m as { jobId: string }).jobId === jobId) as never, recordingFetch);

    assert.ok(queries.some((q) => q.includes('in:sent')), 'pass 1 sweeps everything sent');
    assert.ok(queries.some((q) => q.includes('from:{friend@example.com}')), 'pass 2 sweeps Correspondents');
    assert.ok(queries.every((q) => q.includes('after:2024/01/01') && q.includes('before:2025/01/01')), 'every pass stays inside the slice');

    const settings = await repo.getAccountSettings('acct-a');
    assert.equal(settings.backfill_cursor, '2024-01-01', 'the cursor advances even when a slice is thin');
    assert.equal(settings.backfill_done, false);
  } finally { await mf.dispose(); }
});

test('a backfill slice yields to a busy Account without losing its place', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    const repo = new Repo(driver);
    // Something else holds the Account-level sync lock.
    await repo.startSyncRun({ account: 'acct-a', phase: 'sync', selector: null });

    const jobId = await enqueueJob(env, 'backfill_slice', 'acct-a', { since: '2024-01-01', until: '2025-01-01' });
    await runJob(env, sent.find((m) => (m as { jobId: string }).jobId === jobId) as never, gmailFetch);

    const row = await driver.prepare('SELECT status,progress_json FROM jobs WHERE id=?').get(jobId) as { status: string; progress_json: string };
    assert.equal(row.status, 'done', 'losing the race is not a failure');
    assert.match(row.progress_json, /account busy/);
    // Crucially the cursor did NOT move — advancing it would skip the year.
    assert.equal((await repo.getAccountSettings('acct-a')).backfill_cursor, null);
  } finally { await mf.dispose(); }
});

test('the Queue consumer takes one Job per invocation', async () => {
  // The consumer awaits each message SERIALLY, so a batch larger than one makes
  // several sync pipelines share a single 30s CPU budget. Exhausting it kills
  // the isolate mid-Job: the D1 writes already made survive, but the closing
  // `update('done')` never lands and the row sticks at `running` forever —
  // which then suppresses every later enqueue for that Account. Config, so
  // nothing else would catch a regression.
  const { readFileSync } = await import('node:fs');
  for (const path of ['worker/wrangler.jsonc', 'worker/wrangler.production.jsonc']) {
    const config = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const consumer = /"consumers"\s*:\s*\[\{([^}]*)\}/.exec(config)?.[1] ?? '';
    assert.match(consumer, /"max_batch_size"\s*:\s*1\b/, `${path} must take one Job per invocation`);
    // Capped, but NOT to 1: the sync lock is per Account, so one invocation per
    // mailbox is the useful ceiling. Serialising globally made a tick drain
    // slower than the hour that queues it and starved the last-enqueued kind.
    assert.match(consumer, /"max_concurrency"\s*:\s*[1-9]\d*\b/, `${path} must cap concurrency to the Account count`);
  }
});

test('the scheduler skips an Account whose grant Google already rejected', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await saveGrant(driver, { account: 'acct-dead', address: 'dead@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], refreshToken: 'refresh', key });
    await driver.prepare("UPDATE google_tokens SET auth_error='invalid_grant',auth_failed_at=? WHERE account=?")
      .run(new Date().toISOString(), 'acct-dead');

    await enqueueScheduledSyncs(env);
    const swept = new Set(sent.map((message) => (message as { account: string }).account));
    assert.deepEqual([...swept], ['acct-a'], 'only the healthy Account is swept');

    // Repairing the grant puts it straight back in the rotation.
    await driver.prepare('UPDATE google_tokens SET auth_error=NULL,auth_failed_at=NULL WHERE account=?').run('acct-dead');
    await enqueueScheduledSyncs(env);
    assert.ok(sent.some((message) => (message as { account: string }).account === 'acct-dead'), 're-consent resumes syncing');
  } finally { await mf.dispose(); }
});

test('a Job past its lease is reclaimed within one cron period, not six hours', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    // Wedged 20 minutes ago: past the 15-minute lease, far short of six hours.
    const wedged = new Date(Date.now() - 20 * 60_000).toISOString();
    await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('wedged', 'sync', 'acct-a', '{}', 'running', '{}', wedged, wedged);

    const replacement = await enqueueJob(env, 'sync', 'acct-a');
    assert.notEqual(replacement, 'wedged', 'the corpse no longer suppresses new work');
    assert.equal(sent.length, 1, 'a real Job reached the Queue');
    const reaped = await driver.prepare('SELECT status,terminal,error FROM jobs WHERE id=?').get('wedged') as { status: string; terminal: number; error: string };
    assert.equal(reaped.status, 'failed');
    assert.equal(reaped.terminal, 1);
    assert.match(reaped.error, /stale Job lock expired after 15 minutes/);
  } finally { await mf.dispose(); }
});

test('a QUEUED Job is left alone while it waits its turn', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    // Queued 20 minutes ago and never started: past the RUNNING lease, but this
    // Job has not died — it is behind an 8-minute sync. Measured in production,
    // sweeps routinely wait ~17 minutes, and reaping them killed two thirds of
    // every tick's work.
    const waiting = new Date(Date.now() - 20 * 60_000).toISOString();
    await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('waiting', 'sync', 'acct-a', '{}', 'queued', '{}', waiting, null);

    assert.equal(await enqueueJob(env, 'sync', 'acct-a'), 'waiting', 'the waiting Job is still the answer');
    assert.equal(sent.length, 0, 'no duplicate work queued');
    const row = await driver.prepare('SELECT status FROM jobs WHERE id=?').get('waiting') as { status: string };
    assert.equal(row.status, 'queued', 'waiting is not wedged');
  } finally { await mf.dispose(); }
});

test('a QUEUED Job that was never delivered is eventually reclaimed', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    // An hour old with no start: the message is gone (a deploy or a purge ate
    // it), so the row would otherwise block this Account forever.
    const lost = new Date(Date.now() - 60 * 60_000).toISOString();
    await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('lost', 'sync', 'acct-a', '{}', 'queued', '{}', lost, null);

    assert.notEqual(await enqueueJob(env, 'sync', 'acct-a'), 'lost');
    assert.equal(sent.length, 1, 'a replacement reached the Queue');
    const row = await driver.prepare('SELECT status,error FROM jobs WHERE id=?').get('lost') as { status: string; error: string };
    assert.equal(row.status, 'failed');
    assert.match(row.error, /never delivered/);
  } finally { await mf.dispose(); }
});

test('a Job inside its lease still de-duplicates', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    const recent = new Date(Date.now() - 60_000).toISOString();
    await driver.prepare(`INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,?)`).run('live', 'sync', 'acct-a', '{}', 'running', '{}', recent, recent);

    assert.equal(await enqueueJob(env, 'sync', 'acct-a'), 'live', 'a live Job is still the answer');
    assert.equal(sent.length, 0, 'no duplicate work queued');
  } finally { await mf.dispose(); }
});

test('a Queue send failure is marked failed and never strands Job deduplication', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    env.SYNC_QUEUE.send = async () => { throw new Error('queue unavailable'); };
    await assert.rejects(() => enqueueScheduledSyncs(env), /queue unavailable/);
    const failed = await driver.prepare('SELECT id,status,error FROM jobs').get() as { id: string; status: string; error: string };
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'queue enqueue failed');
    env.SYNC_QUEUE.send = async (message: unknown) => { sent.push(message); };
    await enqueueScheduledSyncs(env);
    const rows = await driver.prepare("SELECT id,status FROM jobs WHERE kind='sync' ORDER BY created_at").all() as { id: string; status: string }[];
    assert.equal(rows.length, 2); assert.notEqual(rows[1]?.id, failed.id);
    assert.equal(sent.filter((message) => (message as { kind: string }).kind === 'sync').length, 1);
  } finally { await mf.dispose(); }
});

test('scheduled sync Job runs the full sync, enrichment, and graph pipeline', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await enqueueScheduledSyncs(env);
    const message = sent[0] as { jobId: string; kind: 'sync'; account: string; params: Record<string, unknown> };
    await runJob(env, message, gmailFetch);
    const first = await driver.prepare('SELECT count(*) n FROM messages').get() as { n: number };
    await runJob(env, message, gmailFetch);
    const second = await driver.prepare('SELECT count(*) n FROM messages').get() as { n: number };
    assert.equal(first.n, 1); assert.equal(second.n, 1);
    const status = await jobStatus(env, 'acct-a');
    // The working-set sweeps queued by the same tick are still pending here, so
    // assert on the sync Job itself rather than the head of the list.
    const syncJob = status.recent.find((row) => row['id'] === message.jobId);
    assert.equal(syncJob?.['status'], 'done');
    const progress = syncJob?.['progress'] as Record<string, unknown>;
    assert.ok(progress['enrich']);
    // The graph is O(mailbox), so the sync HANDS IT OFF rather than running it
    // inline — that tail is what exhausted the invocation's CPU budget.
    const graphJobId = (progress['graph'] as { queued_job?: string })?.queued_job;
    assert.ok(graphJobId, 'sync queues a follow-up graph Job');
    const runs = await driver.prepare('SELECT phase FROM sync_runs ORDER BY id').all() as { phase: string }[];
    assert.deepEqual(runs.map((r) => r.phase), ['sync', 'enrich'], 'no graph run inside the sync Job');

    // Running that follow-up completes the graph exactly as before.
    const graphMessage = sent.find((m) => (m as { kind: string }).kind === 'graph') as never;
    await runJob(env, graphMessage, gmailFetch);
    const after = await driver.prepare('SELECT phase FROM sync_runs ORDER BY id').all() as { phase: string }[];
    assert.deepEqual(after.map((r) => r.phase), ['sync', 'enrich', 'graph']);
    const graphStatus = await jobStatus(env, 'acct-a');
    assert.equal(graphStatus.recent.find((row) => row['id'] === graphJobId)?.['status'], 'done');
  } finally { await mf.dispose(); }
});

test('a stale Job is failed and replaced without crossing Account or kind boundaries', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
    const insert = `INSERT INTO jobs(id,kind,account,params_json,status,progress_json,created_at,started_at)
      VALUES(?,?,?,?,?,?,?,?)`;
    await driver.prepare(insert).run('stale-a-running', 'sync', 'acct-a', '{}', 'running', '{}', old, old);
    await driver.prepare(insert).run('stale-a-queued', 'sync', 'acct-a', '{}', 'queued', '{}', old, null);
    await driver.prepare(insert).run('stale-b', 'sync', 'acct-b', '{}', 'running', '{}', old, old);
    await driver.prepare(insert).run('stale-other-kind', 'backfill', 'acct-a', '{}', 'running', '{}', old, old);

    const replacement = await enqueueJob(env, 'sync', 'acct-a');
    assert.notEqual(replacement, 'stale-a-running');
    assert.equal(sent.length, 1);
    const rows = await driver.prepare('SELECT id,status,error,terminal FROM jobs ORDER BY id').all() as { id: string; status: string; error: string | null; terminal: number }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get('stale-a-running')?.status, 'failed');
    assert.match(byId.get('stale-a-running')?.error ?? '', /stale Job lock expired/);
    assert.equal(byId.get('stale-a-running')?.terminal, 1);
    assert.equal(byId.get('stale-a-queued')?.status, 'failed', 'orphaned queued Job is expired too');
    assert.equal(byId.get('stale-b')?.status, 'running', 'other Account is untouched');
    assert.equal(byId.get('stale-other-kind')?.status, 'running', 'other Job kind is untouched');
    assert.equal(byId.get(replacement)?.status, 'queued');

    await runJob(env, { jobId: 'stale-a-running', kind: 'sync', account: 'acct-a', params: {} }, gmailFetch);
    assert.equal((await driver.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n, 0, 'expired queue message stays terminal');
  } finally { await mf.dispose(); }
});

test('a mismatched queue envelope executes the persisted Account, kind, and params', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await enqueueJob(env, 'sync', 'acct-a', { since: '2026-08-01T00:00:00.000Z' });
    const queued = sent[0] as { jobId: string; kind: 'sync'; account: string; params: Record<string, unknown> };
    await runJob(env, { ...queued, kind: 'backfill', account: 'acct-b', params: { since: '1999-01-01T00:00:00.000Z' } }, gmailFetch);
    const row = await driver.prepare('SELECT status,error FROM jobs WHERE id=?').get(queued.jobId) as { status: string; error: string | null };
    assert.equal(row.status, 'done');
    assert.equal(row.error, null);
    const run = await driver.prepare(`SELECT account,selector FROM sync_runs WHERE phase='sync'`).get() as { account: string; selector: string };
    assert.equal(run.account, 'acct-a');
    assert.equal(run.selector, 'since=2026-08-01T00:00:00.000Z');
  } finally { await mf.dispose(); }
});

test('explicit backfill Job retains the full enrichment and graph pipeline', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await enqueueJob(env, 'backfill', 'acct-a');
    await runJob(env, sent[0] as never, gmailFetch);
    const status = await jobStatus(env, 'acct-a');
    const progress = status.recent.find((row) => row['kind'] === 'backfill')?.['progress'] as Record<string, unknown>;
    assert.ok(progress['enrich']);
    assert.ok((progress['graph'] as { queued_job?: string })?.queued_job, 'backfill hands the graph off too');
    const runs = await driver.prepare('SELECT phase FROM sync_runs ORDER BY id').all() as { phase: string }[];
    assert.deepEqual(runs.map((r) => r.phase), ['sync', 'enrich']);
    const changes = await driver.prepare(
      'SELECT account,entity_type,entity_key,operation,payload_json FROM crm_change_events ORDER BY sequence',
    ).all() as Array<Record<string, unknown>>;
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.account, 'acct-a');
    assert.equal(changes[0]?.entity_type, 'message');
    assert.equal(changes[0]?.entity_key, 'm1');
    assert.equal(changes[0]?.operation, 'upsert');
    const payload = JSON.parse(String(changes[0]?.payload_json)) as Record<string, unknown>;
    assert.equal(payload['bodyMarkdown'], 'Hello body');
    assert.equal(payload['subject'], 'Hello');
    assert.equal(payload['threadKey'], 't1');
  } finally { await mf.dispose(); }
});

test('D1 concurrent sync lock has exactly one winner', async () => {
  const { mf, driver } = await fixture();
  try {
    const repo = new Repo(driver);
    const results = await Promise.all([repo.acquireSyncRun({ account: 'acct-a', phase: 'sync' }), repo.acquireSyncRun({ account: 'acct-a', phase: 'sync' })]);
    assert.equal(results.filter((id) => id != null).length, 1);
  } finally { await mf.dispose(); }
});

test('failed Job records failure and remains retryable', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await enqueueScheduledSyncs(env); const message = sent[0] as never;
    await assert.rejects(() => runJob(env, message, (async () => Response.json({ error: 'down' }, { status: 500 })) as typeof fetch));
    const row = await driver.prepare('SELECT status,error FROM jobs').get() as { status: string; error: string };
    assert.equal(row.status, 'failed'); assert.match(row.error, /500|token exchange failed/);
    let retried = false;
    await worker.queue({ messages: [{ body: { jobId: 'missing', kind: 'sync', account: 'acct-a', params: {} }, ack() {}, retry() { retried = true; } }] }, env);
    assert.equal(retried, true);
    const status = await jobStatus(env, 'acct-a');
    assert.ok(status.last_cron_run); assert.equal(status.failed_jobs[0]?.error, row.error);
    // The sync Job is off the queue; the working-set sweeps from the same tick
    // are legitimately still queued, so depth is not zero any more.
    const pendingSyncs = status.recent.filter((job) => job['kind'] === 'sync' && ['queued', 'running'].includes(String(job['status'])));
    assert.equal(pendingSyncs.length, 0);
  } finally { await mf.dispose(); }
});

test('structured Job logs expose ids and counts but no Message content', async () => {
  const { mf, env, sent } = await fixture(); const lines: string[] = []; const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await enqueueScheduledSyncs(env); await runJob(env, sent[0] as never, gmailFetch);
    const text = lines.join('\n'); assert.match(text, /job_start/); assert.match(text, /job_finish/); assert.match(text, /indexed/);
    assert.doesNotMatch(text, /Hello|person@example\.com|Hello body|snippet|subject|address/i);
  } finally { console.log = original; await mf.dispose(); }
});

test('a webhook Queue send failure records a terminal Job', async () => {
  const { mf, env, driver } = await fixture();
  try {
    const repo = new Repo(driver);
    await repo.upsertMessage({ account: 'acct-a', gmailMessageId: 'm1', category: 'primary', subject: 'Trigger me' });
    const admin = triggerAdmin(driver);
    const consumer = await admin.registerConsumer({ url: 'https://consumer.example/hook', secret: 'shared-secret' }) as { id: string };
    await admin.saveRule({ name: 'Primary mail', predicate: { conditions: [{ type: 'category', value: 'primary' }] }, consumer_ids: [consumer.id] });
    env.SYNC_QUEUE.send = async () => { throw new Error('queue unavailable'); };
    await assert.rejects(() => evaluateRules(env, driver, repo, 'acct-a', ['m1']), /queue unavailable/);
    const row = await driver.prepare(`SELECT status,terminal,error FROM jobs WHERE kind='webhook_delivery'`).get() as { status: string; terminal: number; error: string };
    assert.equal(row.status, 'failed');
    assert.equal(row.terminal, 1);
    assert.equal(row.error, 'queue enqueue failed');
  } finally { await mf.dispose(); }
});

test('sync Job evaluates Trigger rules and signed webhook retries until 2xx', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    const admin = triggerAdmin(driver);
    const consumer = await admin.registerConsumer({ url: 'https://consumer.example/hook', secret: 'shared-secret' }) as { id: string };
    await admin.saveRule({ name: 'Primary mail', predicate: { conditions: [{ type: 'category', value: 'primary' }] }, consumer_ids: [consumer.id] });
    await enqueueScheduledSyncs(env); await runJob(env, sent[0] as never, gmailFetch);
    const delivery = sent.find((message) => (message as { kind: string }).kind === 'webhook_delivery') as { jobId: string; kind: 'webhook_delivery'; account: string; params: Record<string, unknown> };
    assert.ok(delivery, 'the Trigger rule queued a webhook delivery');
    let attempts = 0; let captured: RequestInit | undefined;
    const consumerFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { attempts++; captured = init; return new Response('', { status: attempts === 1 ? 500 : 200 }); }) as typeof fetch;
    await assert.rejects(() => runJob(env, delivery as never, consumerFetch), /500/);
    await runJob(env, delivery as never, consumerFetch); assert.equal(attempts, 2);
    const body = String(captured?.body); const payload = JSON.parse(body);
    assert.equal(payload.delivery_id, delivery.params['deliveryId']); assert.equal(payload.matches[0].id, 'm1');
    const expected = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode('shared-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(body));
    assert.equal(new Headers(captured?.headers).get('x-mailindex-signature'), `sha256=${Buffer.from(expected).toString('hex')}`);
    assert.ok(new Headers(captured?.headers).get('x-mailindex-timestamp'));
  } finally { await mf.dispose(); }
});
