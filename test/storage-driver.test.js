/** Driver-level conformance: the same contract runs against SQLite and D1. */

import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { D1Driver } from '../dist/index/drivers/d1.js';
import { SqliteDriver } from '../dist/index/drivers/sqlite.js';
import { BM25_WEIGHTS, bm25Expr, buildMatch } from '../dist/index/fts.js';
import { getUserVersion, MIGRATIONS, runMigrations } from '../dist/index/migrations.js';
import { SCHEMA_VERSION } from '../dist/index/schema.js';

const sqlite = async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:'));
  return { driver, dispose: () => driver.close() };
};

let d1Unavailable;
async function d1(t) {
  try {
    const { Miniflare } = await import('miniflare');
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    const driver = new D1Driver(await mf.getD1Database('DB'));
    return { driver, dispose: () => mf.dispose() };
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    d1Unavailable ??= `Miniflare D1 unavailable: ${error.message}`;
    t.skip(d1Unavailable);
    return null;
  }
}

function conformance(name, create) {
  test(`${name} StorageDriver: prepare run/get/all and atomic batch`, async (t) => {
    const fixture = await create(t);
    if (!fixture) return;
    const { driver, dispose } = fixture;
    try {
      await driver.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const result = await driver.prepare('INSERT INTO probe(value) VALUES (?)').run('one');
      assert.equal(Number(result.changes), 1);
      assert.equal((await driver.prepare('SELECT value FROM probe WHERE id = ?').get(1)).value, 'one');
      assert.deepEqual(
        (await driver.prepare('SELECT value FROM probe ORDER BY id').all()).map((row) => row.value),
        ['one'],
      );

      await assert.rejects(() =>
        driver.batch([
          { sql: 'INSERT INTO probe(id, value) VALUES (?, ?)', params: [2, 'two'] },
          { sql: 'INSERT INTO probe(id, value) VALUES (?, ?)', params: [2, 'duplicate'] },
        ]),
      );
      assert.equal((await driver.prepare('SELECT count(*) AS n FROM probe').get()).n, 1);
    } finally {
      await dispose();
    }
  });

  test(`${name} StorageDriver: fresh, repeated, and mid-version migrations`, async (t) => {
    const fixture = await create(t);
    if (!fixture) return;
    const { driver, dispose } = fixture;
    try {
      await runMigrations(driver);
      assert.equal(await getUserVersion(driver), SCHEMA_VERSION);
      await runMigrations(driver);
      assert.equal(await getUserVersion(driver), SCHEMA_VERSION);
    } finally {
      await dispose();
    }

    const middle = await create(t);
    if (!middle) return;
    try {
      for (const migration of MIGRATIONS.filter((migration) => migration.version <= 4)) {
        await migration.up(middle.driver);
      }
      await middle.driver.exec('PRAGMA user_version = 4');
      await runMigrations(middle.driver);
      assert.equal(await getUserVersion(middle.driver), SCHEMA_VERSION);
      assert.ok(
        await middle.driver
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'labels'")
          .get(),
      );
    } finally {
      await middle.dispose();
    }
  });
}

conformance('node:sqlite', sqlite);
conformance('D1', d1);

async function ftsResult(create, t) {
  const fixture = await create(t);
  if (!fixture) return null;
  const { driver, dispose } = fixture;
  try {
    await runMigrations(driver);
    const insert = driver.prepare(
      'INSERT INTO messages_fts(rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)',
    );
    await insert.run(1, 'Refund processed', 'billing@example.com', 'me@example.com', 'status');
    await insert.run(2, 'Account update', 'refunds@example.com', 'me@example.com', 'refund processed');
    await insert.run(3, 'Travel update', 'ops@example.com', 'me@example.com', 'refunds pending');
    const match = buildMatch(['refunds'], { expand: true });
    const rows = await driver
      .prepare(
        `SELECT rowid, ${bm25Expr()} AS score FROM messages_fts
         WHERE messages_fts MATCH ? ORDER BY score, rowid`,
      )
      .all(match);
    return rows.map(({ rowid, score }) => ({ rowid: Number(rowid), score: Number(score) }));
  } finally {
    await dispose();
  }
}

test('D1 and node:sqlite have identical porter stemming and weighted bm25 ranking', async (t) => {
  assert.deepEqual(BM25_WEIGHTS, [10, 8, 4, 1]);
  const sqliteRows = await ftsResult(sqlite, t);
  const d1Rows = await ftsResult(d1, t);
  if (!d1Rows) return;
  assert.deepEqual(
    d1Rows.map(({ rowid }) => rowid),
    sqliteRows.map(({ rowid }) => rowid),
  );
  assert.equal(d1Rows.length, sqliteRows.length);
  for (let i = 0; i < d1Rows.length; i++) {
    assert.ok(Math.abs(d1Rows[i].score - sqliteRows[i].score) < 1e-12);
  }
});

test('D1 migration batches roll back on failure and concurrent first requests converge', async (t) => {
  let Miniflare; try { ({ Miniflare } = await import('miniflare')); } catch { t.skip('Miniflare unavailable'); return; }
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const binding = await mf.getD1Database('DB'); const probe = new D1Driver(binding);
    await probe.beginMigration(); await probe.exec('CREATE TABLE atomic_probe(id INTEGER PRIMARY KEY)'); await probe.exec('INSERT INTO missing_table VALUES(1)');
    await assert.rejects(() => probe.commitMigration()); await probe.rollbackMigration();
    assert.equal(await probe.prepare("SELECT name FROM sqlite_master WHERE name='atomic_probe'").get(), undefined);
    await Promise.all([runMigrations(new D1Driver(binding)), runMigrations(new D1Driver(binding))]);
    assert.equal(await getUserVersion(new D1Driver(binding)), SCHEMA_VERSION);
  } finally { await mf.dispose(); }
});

test('D1 porter-FTS migration is atomic on a populated v6 database', async (t) => {
  const fixture = await d1(t); if (!fixture) return;
  try {
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 6)) await migration.up(fixture.driver);
    await fixture.driver.exec('PRAGMA user_version = 6');
    await fixture.driver.prepare(`INSERT INTO messages(account,gmail_message_id,subject,from_addr,snippet,body_state) VALUES(?,?,?,?,?,?)`).run('acct', 'm1', 'Refunds pending', 'billing@example.com', 'refund status', 'meta');
    const row = await fixture.driver.prepare(`SELECT rowid FROM messages WHERE account='acct' AND gmail_message_id='m1'`).get();
    await fixture.driver.prepare('INSERT INTO messages_fts(rowid,subject,sender,body) VALUES(?,?,?,?)').run(row.rowid, 'Refunds pending', 'billing@example.com', 'refund status');
    await runMigrations(fixture.driver);
    assert.equal(await getUserVersion(fixture.driver), SCHEMA_VERSION);
    assert.equal((await fixture.driver.prepare(`SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'refund'`).get()).n, 1);
  } finally { await fixture.dispose(); }
});
