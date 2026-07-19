import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { exportIndex } from '../dist/cli/export.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { importSeed } from '../dist-worker/worker/import-seed.js';
import { saveGrant } from '../dist-worker/worker/google-oauth.js';
import { enqueueScheduledSyncs } from '../dist-worker/worker/jobs.js';

async function dump(driver: Parameters<typeof exportIndex>[0], account?: string) { const lines: string[] = []; for await (const line of exportIndex(driver, account)) lines.push(line); return lines.join('\n'); }

test('portable seed round-trips earned state and FTS, resumes, and filters Accounts', async () => {
  const source = await openDb({ path: ':memory:' }); const repo = new Repo(source);
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    await repo.upsertMessage({ account: 'acct-a', gmailMessageId: 'm1', internalDate: 1717000000000, fromAddr: 'person@example.com', subject: 'Polar invoice', snippet: 'expedition receipt', labels: ['INBOX'], category: 'primary', bodyState: 'full', bodyText: 'earned body' });
    await repo.saveMessageSummary({ account: 'acct-a', gmailMessageId: 'm1', text: 'earned summary', isModel: true, at: '2026-01-02T00:00:00.000Z' });
    await repo.upsertMessage({ account: 'acct-b', gmailMessageId: 'm2', subject: 'Other', labels: [], bodyState: 'meta' });
    await source.prepare(`INSERT INTO contacts(account,address,msgs_sent,curation) VALUES(?,?,?,?)`).run('acct-a', 'person@example.com', 1, 'important');
    await source.prepare(`INSERT INTO domains(account,domain,msgs,distinct_contacts,curation,category) VALUES(?,?,?,?,?,?)`).run('acct-a', 'example.com', 1, 1, 'important', 'travel');
    await source.prepare(`INSERT INTO interest_profile(account,keywords_json,updated_at) VALUES(?,?,?)`).run('acct-a', '["polar"]', '2026-01-01T00:00:00.000Z');
    const ndjson = await dump(source); assert.doesNotMatch(ndjson, /google_tokens|refresh_token|"type":"jobs"/);
    const onlyA = await dump(source, 'acct-a'); assert.doesNotMatch(onlyA, /acct-b/);
    const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver);
    const partial = await importSeed(driver, ndjson, { batchSize: 2, maxBatches: 1 }); assert.equal(partial.complete, false);
    await importSeed(driver, ndjson, { batchSize: 2, startLine: partial.nextLine });
    await importSeed(driver, ndjson, { batchSize: 3 });
    const target = new Repo(driver); const message = await target.getMessage('acct-a', 'm1');
    assert.equal(message?.body_state, 'full'); assert.equal(message?.summary_text, 'earned summary');
    assert.equal((await driver.prepare(`SELECT curation FROM contacts WHERE account='acct-a'`).get() as { curation: string }).curation, 'important');
    assert.equal((await driver.prepare(`SELECT category FROM domains WHERE account='acct-a'`).get() as { category: string }).category, 'travel');
    assert.equal((await driver.prepare(`SELECT keywords_json FROM interest_profile WHERE account='acct-a'`).get() as { keywords_json: string }).keywords_json, '["polar"]');
    assert.equal((await target.searchMessages('"expedition"*', { account: 'acct-a' })).length, 1);
    assert.ok(await driver.prepare(`SELECT finished_at FROM sync_runs WHERE account='acct-a' AND finished_at IS NOT NULL`).get());
    const queued: unknown[] = []; const key = Buffer.alloc(32, 2).toString('base64');
    await saveGrant(driver, { account: 'acct-a', address: 'a@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], refreshToken: 'refresh', key });
    await enqueueScheduledSyncs({ DB: await mf.getD1Database('DB'), SYNC_QUEUE: { send: async (m: unknown) => { queued.push(m); } }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m', OAUTH_KV: {} } as never);
    assert.match(String((queued[0] as { params: { since?: string } }).params.since), /^20/);
  } finally { source.close(); await mf.dispose(); }
});
