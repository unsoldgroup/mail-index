import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDriver } from '../dist/index/drivers/sqlite.js';

test('SQLite retains outer rollback across successful bounded batches', async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:'));
  try {
    await driver.exec('CREATE TABLE writes(id INTEGER PRIMARY KEY)');
    const repo = new Repo(driver);
    await assert.rejects(repo.transaction(async () => {
      await driver.batch(Array.from({ length: 50 }, (_, id) => ({ sql: 'INSERT INTO writes VALUES (?)', params: [id] })));
      await driver.batch([{ sql: 'INSERT INTO writes VALUES (?)', params: [50] }]);
      await driver.batch([{ sql: 'INSERT INTO writes VALUES (?)', params: [0] }]);
    }));
    assert.equal((await driver.prepare('SELECT count(*) n FROM writes').get()).n, 0);
  } finally { driver.close(); }
});

test('derived D1 writes bound round trips and preserve user-owned context', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const driver = new D1Driver(await mf.getD1Database('DB'));
    await runMigrations(driver);
    const repo = new Repo(driver);
    for (let i = 0; i < 64; i++) await repo.upsertMessage({ account: 'acct-a', gmailMessageId: `m${i}`, threadId: `t${i}`, internalDate: 1717000000000 + i, fromAddr: 'own@example.com', toAddr: `p${i}@domain${i}.example`, subject: `s${i}`, direction: 'sent', isList: false, unread: false, starred: false, important: false, snippet: 'x', bodyState: 'meta' });
    await aggregateAccount(repo, 'acct-a', ['own@example.com']);
    await driver.prepare("UPDATE contacts SET curation='important',person_id='person-0' WHERE account='acct-a' AND address='p0@domain0.example'").run();
    await driver.prepare("UPDATE threads SET summary_text='human-owned summary' WHERE account='acct-a' AND thread_id='t0'").run();
    await driver.prepare("UPDATE domains SET curation='important',category='travel operator',category_note='human note' WHERE account='acct-a' AND domain='domain0.example'").run();
    const counts = { writes: 0, reads: 0, batches: [], statements: 0 };
    const pause = () => new Promise(r => setTimeout(r, 2));
    const instrumented = {
      exec: sql => driver.exec(sql), close() {},
      prepare(sql) {
        const statement = driver.prepare(sql);
        return {
          async run(...args) { counts.writes++; counts.statements++; await pause(); return statement.run(...args); },
          async get(...args) { counts.reads++; await pause(); return statement.get(...args); },
          async all(...args) { counts.reads++; await pause(); return statement.all(...args); },
        };
      },
      async batch(statements) { counts.writes++; counts.statements += statements.length; counts.batches.push(statements.length); await pause(); await driver.batch(statements); },
    };
    const observed = new Repo(instrumented);
    const start = performance.now();
    await aggregateAccount(observed, 'acct-a', ['own@example.com']);
    await interestPass(observed, 'acct-a', { now: new Date('2026-01-01T00:00:00Z') });
    const elapsedMs = performance.now() - start;
    const contact = await driver.prepare("SELECT msgs_sent,curation,person_id FROM contacts WHERE account='acct-a' AND address='p0@domain0.example'").get();
    assert.deepEqual(contact, { msgs_sent: 1, curation: 'important', person_id: 'person-0' });
    assert.equal((await driver.prepare("SELECT summary_text FROM threads WHERE account='acct-a' AND thread_id='t0'").get()).summary_text, 'human-owned summary');
    assert.deepEqual(await driver.prepare("SELECT curation,category,category_note FROM domains WHERE account='acct-a' AND domain='domain0.example'").get(), { curation: 'important', category: 'travel operator', category_note: 'human note' });
    assert.equal((await driver.prepare("SELECT count(*) n FROM contact_stats_snapshot WHERE account='acct-a'").get()).n, 64);
    assert.equal((await driver.prepare("SELECT count(*) n FROM contacts WHERE account='acct-a' AND address='own@example.com'").get()).n, 0);
    console.log('[UNS1554-BENCH]', JSON.stringify({ messages: 64, syntheticLatencyMs: 2, elapsedMs, ...counts }));
    assert.ok(counts.writes <= 12, `derived writes require ${counts.writes} round trips for 64 messages`);
    assert.ok(counts.batches.every(n => n <= 50), 'each write batch is bounded');
    await interestPass(repo, 'acct-a', { now: new Date('2026-01-01T00:00:00Z') });
    assert.equal((await driver.prepare("SELECT count(*) n FROM contact_stats_snapshot WHERE account='acct-a'").get()).n, 64, 'same snapshot generation is idempotent');
    await driver.prepare("DELETE FROM messages WHERE account='acct-a' AND gmail_message_id='m63'").run();
    await aggregateAccount(repo, 'acct-a', ['own@example.com']);
    assert.equal((await driver.prepare("SELECT count(*) n FROM contacts WHERE account='acct-a'").get()).n, 63, 'obsolete derived contacts are removed');
    assert.equal((await driver.prepare("SELECT count(*) n FROM threads WHERE account='acct-a'").get()).n, 63);
    assert.equal((await driver.prepare("SELECT count(*) n FROM domains WHERE account='acct-a'").get()).n, 63);
  } finally { await mf.dispose(); }
});
