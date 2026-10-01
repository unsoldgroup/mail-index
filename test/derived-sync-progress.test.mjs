// Diagnostic only: tiny real runJob + Miniflare D1, no provider or operator data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout, clearTimeout } from 'node:timers';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant } from '../dist-worker/worker/google-oauth.js';
import { enqueueJob, runJob } from '../dist-worker/worker/jobs.js';
const { Response } = globalThis;

function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('phase never reached within 5 seconds')), 5000); })]); }
  finally { clearTimeout(timer); }
}

for (const phase of ['provider', 'aggregate', 'enrich', 'aggregate-error', 'control']) {
  test(`UNS1554 real D1 runJob distinguishes ${phase}`, { timeout: 20000 }, async () => {
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
    const entered = latch(), release = latch();
    let running;
    try {
      const rawDB = await mf.getD1Database('DB');
      const driver = new D1Driver(rawDB);
      await runMigrations(driver);
      // Synthetic fixture-only encryption/grant, never production credentials.
      const key = Buffer.alloc(32, 4).toString('base64');
      await saveGrant(driver, { account: 'acct-a', address: 'a@example.com', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], refreshToken: 'fixture-refresh', key });
      let aggregateReads = 0, providerMessages = 0;
      const phaseUpdates = [];
      const db = new Proxy(rawDB, { get(target, prop) {
        if (prop !== 'prepare') { const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value; }
        return sql => {
          const isAggregate = /ORDER BY internal_date IS NULL DESC, internal_date ASC, gmail_message_id ASC/.test(sql);
          function wrap(statement) {
            return new Proxy(statement, { get(st, method) {
              if (method === 'bind') return (...args) => {
                if (sql.startsWith('UPDATE jobs SET status=?,progress_json=')) {
                  const value = JSON.parse(args[1]);
                  if (value.sync?.phase) phaseUpdates.push(value.sync.phase);
                }
                return wrap(st.bind(...args));
              };
              if (method === 'all' && isAggregate) return async (...args) => {
                aggregateReads++;
                if (phase === 'aggregate-error') throw new Error('fixture-derived-failure');
                if (phase === 'aggregate' && aggregateReads === 1) { entered.resolve(); await release.promise; }
                return st.all(...args);
              };
              const value = st[method]; return typeof value === 'function' ? value.bind(st) : value;
            } });
          }
          return wrap(target.prepare(sql));
        };
      } });
      const sent = [];
      const env = { DB: db, OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async m => { sent.push(m); } }, SWEEP_QUEUE: { send: async m => { sent.push(m); } }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
      const fetchImpl = async input => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600 });
        if (url.endsWith('/profile')) return Response.json({ emailAddress: 'a@example.com' });
        if (url.includes('/messages?')) {
          if (phase === 'provider') { entered.resolve(); await release.promise; }
          return Response.json({ messages: [{ id: 'm1' }] });
        }
        if (url.includes('/messages/m1')) {
          if (phase === 'enrich' && new URL(url).searchParams.get('format') === 'full') { entered.resolve(); await release.promise; }
          providerMessages++;
          return Response.json({ id: 'm1', threadId: 't1', internalDate: String(Date.now()), labelIds: ['INBOX'], snippet: 'hello', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'person@example.com' }, { name: 'To', value: 'a@example.com' }, { name: 'Subject', value: 'Hello' }], body: { data: Buffer.from('Hello body').toString('base64url') } } });
        }
        throw new Error('unexpected fixture fetch');
      };
      const id = await enqueueJob(env, 'sync', 'acct-a', {});
      running = runJob(env, sent.find(m => m.jobId === id), fetchImpl);
      if (phase === 'aggregate-error') {
        await assert.rejects(running, /fixture-derived-failure/);
        const failed = await driver.prepare('SELECT status,progress_json,error FROM jobs WHERE id=?').get(id);
        assert.equal(failed.status, 'failed');
        assert.equal(JSON.parse(failed.progress_json).sync.phase, 'aggregate');
        assert.equal(JSON.parse(failed.progress_json).sync.indexed, 1);
        assert.equal(sent.length, 1, 'a failed derived pass cannot claim completed handoffs');
        return;
      }
      if (phase !== 'control') {
        await bounded(entered.promise);
        const job = await driver.prepare('SELECT status,progress_json FROM jobs WHERE id=?').get(id);
        const audit = await driver.prepare("SELECT finished_at,fetched,indexed FROM sync_runs WHERE account=? AND phase='sync' ORDER BY id DESC LIMIT 1").get('acct-a');
        const indexed = await driver.prepare('SELECT count(*) n FROM messages WHERE account=?').get('acct-a');
        assert.equal(job.status, 'running');
        if (phase !== 'provider') assert.equal(JSON.parse(job.progress_json).sync.indexed, 1);
        else assert.equal(job.progress_json, '{}');
        assert.equal(indexed.n, phase === 'provider' ? 0 : 1);
        assert.equal(audit.finished_at !== null, phase !== 'provider');
        if (phase === 'aggregate') { assert.equal(audit.indexed, 1); assert.equal(providerMessages, 1); assert.equal(JSON.parse(job.progress_json).sync.phase, 'aggregate'); }
        assert.equal(sent.length, 1, 'follow-ups are not queued while syncMetadata is blocked');
        console.log('[UNS1554-PHASE]', JSON.stringify({ phase, job, audit, indexed: indexed.n, providerMessages, aggregateReads }));
        release.resolve();
      }
      await running;
      const done = await driver.prepare('SELECT status,progress_json FROM jobs WHERE id=?').get(id);
      assert.equal(done.status, 'done');
      assert.equal(JSON.parse(done.progress_json).sync.indexed, 1);
      assert.deepEqual(phaseUpdates, ['metadata', 'aggregate', 'interest', 'compact']);
      assert.ok(sent.some(m => m.kind === 'enrich_bulk'));
      assert.ok(aggregateReads >= 1, 'real aggregation remains in the execution path');
      console.log('[UNS1554-PHASE]', JSON.stringify({ phase, afterRelease: done.status, followUps: sent.map(m => m.kind) }));
    } finally { release.resolve(); if (running) await running.catch(() => {}); await mf.dispose(); }
  });
}
