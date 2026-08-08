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
    assert.equal(sent.length, 1);
    const params = (sent[0] as { params: Record<string, unknown> }).params;
    assert.equal(typeof params['since'], 'string');
    const ageDays = (Date.now() - Date.parse(String(params['since']))) / 86_400_000;
    assert.ok(ageDays > 360 && ageDays < 380, `expected a 12-month lookback, got ${ageDays} days`);
  }
  finally { await mf.dispose(); }
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
    const rows = await driver.prepare('SELECT id,status FROM jobs ORDER BY created_at').all() as { id: string; status: string }[];
    assert.equal(rows.length, 2); assert.notEqual(rows[1]?.id, failed.id); assert.equal(sent.length, 1);
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
    assert.equal(status.queue_depth, 0); assert.equal(status.recent[0]?.status, 'done');
    const progress = status.recent[0]?.progress as Record<string, unknown>;
    assert.ok(progress['enrich']);
    assert.ok(progress['graph']);
    const runs = await driver.prepare('SELECT phase FROM sync_runs ORDER BY id').all() as { phase: string }[];
    assert.deepEqual(runs.map((r) => r.phase), ['sync', 'enrich', 'graph']);
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
    const progress = status.recent[0]?.progress as Record<string, unknown>;
    assert.ok(progress['enrich']);
    assert.ok(progress['graph']);
    const runs = await driver.prepare('SELECT phase FROM sync_runs ORDER BY id').all() as { phase: string }[];
    assert.deepEqual(runs.map((r) => r.phase), ['sync', 'enrich', 'graph']);
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
    assert.ok(status.last_cron_run); assert.equal(status.queue_depth, 0); assert.equal(status.failed_jobs[0]?.error, row.error);
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
    const delivery = sent[1] as { jobId: string; kind: 'webhook_delivery'; account: string; params: Record<string, unknown> };
    assert.equal(delivery.kind, 'webhook_delivery');
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
