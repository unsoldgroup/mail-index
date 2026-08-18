import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { CrmChangeFeed } from '../dist-worker/worker/crm-feed.js';
import { handleAuthorizedRequest } from '../dist-worker/worker/index.js';

test('CRM change feed replays an ordered deployment cursor with tombstones', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });

  try {
    const driver = new D1Driver(await mf.getD1Database('DB'));
    await runMigrations(driver);
    const feed = new CrmChangeFeed(driver);

    const firstCursor = await feed.append({
      account: 'advisor-a',
      entityType: 'message',
      entityKey: 'message-1',
      operation: 'upsert',
      payload: { subject: 'Polar quote' },
    });
    const terminalCursor = await feed.append({
      account: 'advisor-b',
      entityType: 'message',
      entityKey: 'message-2',
      operation: 'tombstone',
      reason: 'provider_deleted',
    });

    const firstPage = await feed.read({ limit: 1 });
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.events[0]?.account, 'advisor-a');
    assert.equal(firstPage.nextCursor, firstCursor);
    assert.equal(firstPage.terminalCursor, terminalCursor);
    assert.equal(firstPage.hasMore, true);

    const replay = await feed.read({ after: firstPage.nextCursor, limit: 10 });
    assert.equal(replay.events.length, 1);
    assert.equal(replay.events[0]?.operation, 'tombstone');
    assert.equal(replay.events[0]?.reason, 'provider_deleted');
    assert.equal(replay.nextCursor, terminalCursor);
    assert.equal(replay.hasMore, false);

    assert.deepEqual(await feed.read({ after: firstCursor, limit: 10 }), replay);
  } finally {
    await mf.dispose();
  }
});

test('authorized CRM API exposes source discovery, change pages, and coalesced refresh jobs', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    kvNamespaces: ['OAUTH_KV'],
  });
  const queued: unknown[] = [];
  const env = {
    DB: await mf.getD1Database('DB'),
    OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'),
    SYNC_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    SWEEP_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    OPERATOR_EMAILS: 'operator@example.com',
    SYNC_INTERVAL: '60m',
  };

  try {
    const driver = new D1Driver(env.DB);
    await runMigrations(driver);
    await driver.prepare(
      `INSERT INTO google_tokens(account,address,scopes,refresh_token_ciphertext,iv,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run('advisor-a', 'advisor@example.com', 'gmail.readonly', new Uint8Array([1]), new Uint8Array([2]), 'now', 'now');
    const cursor = await new CrmChangeFeed(driver).append({
      account: 'advisor-a',
      entityType: 'candidate',
      entityKey: 'candidate@example.com',
      operation: 'upsert',
      payload: { address: 'candidate@example.com', displayName: 'Candidate' },
    });

    const sources = await handleAuthorizedRequest(new Request('https://worker.example/crm/v1/sources'), env);
    assert.equal(sources.status, 200);
    assert.deepEqual((await sources.json() as { sources: unknown[] }).sources, [{
      key: 'advisor-a',
      address: 'advisor@example.com',
      scopes: ['gmail.readonly'],
    }]);

    const changes = await handleAuthorizedRequest(new Request('https://worker.example/crm/v1/changes?limit=10'), env);
    assert.equal(changes.status, 200);
    const page = await changes.json() as { events: Array<{ payload?: unknown }>; terminalCursor: string };
    assert.equal(page.terminalCursor, cursor);
    assert.deepEqual(page.events[0]?.payload, { address: 'candidate@example.com', displayName: 'Candidate' });

    const refreshRequest = () => handleAuthorizedRequest(new Request(
      'https://worker.example/crm/v1/sources/advisor-a/refresh',
      { method: 'POST' },
    ), env);
    const first = await refreshRequest();
    const second = await refreshRequest();
    assert.equal(first.status, 202);
    assert.equal((await first.json() as { jobId: string }).jobId, (await second.json() as { jobId: string }).jobId);
    assert.equal(queued.length, 1);
  } finally {
    await mf.dispose();
  }
});
