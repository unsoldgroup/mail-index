import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { JMAP_SESSION_URL, makeJmapFixtureFetch } from '../dist/source/adapters/jmap/fixtures.js';
import { saveJmapAccount } from '../dist-worker/worker/jmap-accounts.js';
import { enqueueScheduledSyncs, runJob } from '../dist-worker/worker/jobs.js';
import { buildWorkerToolContext } from '../dist-worker/worker/index.js';

const key = Buffer.alloc(32, 7).toString('base64');

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const sent: unknown[] = [];
  const queue = { send: async (m: unknown) => { sent.push(m); } };
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: queue, SWEEP_QUEUE: queue, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  return { mf, env, driver, sent };
}

const input = { account: 'stalwart', address: 'you@example.com', sessionUrl: JMAP_SESSION_URL, key };

test('a JMAP mailbox is saved only after its login checks out, with the password encrypted', async () => {
  const { mf, driver } = await fixture();
  try {
    const refused = await saveJmapAccount(driver, { ...input, password: 'wrong' }, makeJmapFixtureFetch());
    assert.equal(refused.ok, false);
    assert.equal(await driver.prepare('SELECT 1 FROM jmap_accounts').get(), undefined);
    assert.deepEqual(await saveJmapAccount(driver, { ...input, password: 'app-password' }, makeJmapFixtureFetch()), { ok: true });
    const row = await driver.prepare('SELECT password_ciphertext FROM jmap_accounts WHERE account=?').get('stalwart') as { password_ciphertext: ArrayBuffer };
    assert.ok(!Buffer.from(row.password_ciphertext as ArrayBuffer).toString().includes('app-password'));
  } finally { await mf.dispose(); }
});

test('cron syncs a JMAP Account through the JMAP adapter and MCP sees it read-only', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await saveJmapAccount(driver, { ...input, password: 'app-password' }, makeJmapFixtureFetch());
    await enqueueScheduledSyncs(env as never);
    const sync = sent.find((m) => (m as { kind: string; account: string }).kind === 'sync' && (m as { account: string }).account === 'stalwart');
    assert.ok(sync, 'the JMAP Account gets a scheduled sync');
    await runJob(env as never, sync as never, makeJmapFixtureFetch());
    const rows = await driver.prepare('SELECT gmail_message_id FROM messages WHERE account=? ORDER BY gmail_message_id').all('stalwart') as { gmail_message_id: string }[];
    assert.deepEqual(rows.map((r) => r.gmail_message_id), ['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1']);

    const ctx = await buildWorkerToolContext(env as never, makeJmapFixtureFetch());
    assert.equal(ctx.config.accounts['stalwart']?.adapter, 'jmap');
    const source = ctx.buildSource!(ctx.config.accounts['stalwart']!);
    assert.equal(source.provider, 'jmap');
    assert.equal(source.modify, undefined);
    assert.equal(source.createDraft, undefined);
  } finally { await mf.dispose(); }
});

test('a rejected JMAP login is recorded and stops scheduled syncs', async () => {
  const { mf, env, driver, sent } = await fixture();
  try {
    await saveJmapAccount(driver, { ...input, password: 'app-password' }, makeJmapFixtureFetch());
    const ctx = await buildWorkerToolContext(env as never, makeJmapFixtureFetch({ password: 'rotated' }));
    assert.equal((await ctx.buildSource!(ctx.config.accounts['stalwart']!).check()).ok, false);
    assert.equal((await driver.prepare('SELECT auth_error FROM jmap_accounts').get() as { auth_error: string }).auth_error, 'unauthorized');
    await enqueueScheduledSyncs(env as never);
    assert.equal(sent.length, 0);
  } finally { await mf.dispose(); }
});
