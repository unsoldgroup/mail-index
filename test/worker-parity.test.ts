import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { dispatch, toolList } from '../dist/mcp/server.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant, GMAIL_MODIFY, GMAIL_READONLY } from '../dist-worker/worker/google-oauth.js';
import { buildWorkerToolContext } from '../dist-worker/worker/index.js';

test('Worker context exposes the complete registry and gates mailbox writes by stored scope', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const key = Buffer.alloc(32, 9).toString('base64');
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const driver = new D1Driver(env.DB); await runMigrations(driver); const repo = new Repo(driver);
  await saveGrant(driver, { account: 'acct-write', address: 'user@example.com', scopes: [GMAIL_READONLY], refreshToken: 'refresh', key });
  await repo.upsertMessage({ account: 'acct-write', gmailMessageId: 'm1', labels: ['INBOX'], bodyState: 'meta' });
  let modified = 0;
  const fakeFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
    modified += 1; return Response.json({ id: 'm1' });
  }) as typeof fetch;
  try {
    assert.ok(toolList().length >= 25);
    const readonly = await buildWorkerToolContext(env, fakeFetch);
    await assert.rejects(() => dispatch(readonly, 'archive_message', { ref: 'acct-write:m1' }), /\/setup\?account=acct-write&writes=1/);
    assert.equal(modified, 0);
    await driver.prepare('UPDATE google_tokens SET scopes=? WHERE account=?').run(`${GMAIL_READONLY} ${GMAIL_MODIFY}`, 'acct-write');
    const writable = await buildWorkerToolContext(env, fakeFetch);
    await dispatch(writable, 'archive_message', { ref: 'acct-write:m1' });
    assert.equal(modified, 1);
    assert.ok(!(await repo.getMessage('acct-write', 'm1'))?.labels_json?.includes('INBOX'));
    const run = await repo.startSyncRun({ account: 'acct-write', phase: 'sync' });
    await repo.finishSyncRun(run, { fetched: 0, indexed: 0 });
    let intelligenceJobs = 0;
    writable.enqueueJob = async () => { intelligenceJobs += 1; return 'unexpected'; };
    await dispatch(writable, 'graph_neighbors', { account: 'acct-write', address: 'person@example.com' });
    await dispatch(writable, 'graph_communities', { account: 'acct-write' });
    await dispatch(writable, 'cadence', { account: 'acct-write' });
    await dispatch(writable, 'interest_propose', { account: 'acct-write' });
    assert.equal(intelligenceJobs, 0, 'intelligence tools read precomputed state without inline rebuild Jobs');
    const registered = await dispatch(writable, 'webhook_consumer_register', { url: 'https://consumer.example/hook', secret: 'secret' }) as { id: string };
    const saved = await dispatch(writable, 'trigger_rule_save', { name: 'Primary', predicate: { conditions: [{ type: 'category', value: 'primary' }] }, consumer_ids: [registered.id] }) as { id: string };
    const listed = await dispatch(writable, 'trigger_rule_list', {}) as { rules: { id: string }[] };
    assert.equal(listed.rules[0]?.id, saved.id);
    await assert.rejects(() => dispatch(writable, 'trigger_rule_save', { name: 'Bad', predicate: { conditions: [{ type: 'category', value: 'spam' }] }, consumer_ids: [] }), /category/);
  } finally { await mf.dispose(); }
});
