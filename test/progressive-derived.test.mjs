import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import { refreshDerived } from '../dist/intelligence/progressive.js';

test('cloud rollups converge to full rebuild after backdated replies, moves, label changes, failures and deletes', async () => {
  const db = await openDb({ path: ':memory:' });
  const oracle = await openDb({ path: ':memory:' });
  const repo = new Repo(db);
  const full = new Repo(oracle);
  const account = 'acct-a';
  const own = ['self@example.com'];
  let now = new Date('2026-11-25T12:00:00Z');
  const drain = (progress = async () => {}) => refreshDerived(repo, account, own, progress, now);
  const put = async (id, thread, sender, fields = {}) => {
    const message = {
      account,
      gmailMessageId: id,
      threadId: thread,
      internalDate: now.getTime() - 60000,
      fromAddr: sender,
      direction: 'received',
      isList: false,
      starred: false,
      unread: false,
      important: false,
      subject: id,
      bodyState: 'meta',
      ...fields,
    };
    await repo.upsertMessage(message);
    await full.upsertMessage(message);
  };
  const mutate = async (sql, ...params) => {
    for (const fixture of [db, oracle]) await fixture.prepare(sql).run(...params);
  };
  const compare = async () => {
    await drain();
    await aggregateAccount(full, account, own);
    await interestPass(full, account, { now });
    for (const table of ['threads', 'contacts', 'domains']) {
      const sql = 'SELECT * FROM ' + table + ' ORDER BY 1,2';
      assert.deepEqual(await db.prepare(sql).all(), await oracle.prepare(sql).all(), table);
    }
  };
  try {
    await put('stable', 'unrelated', 'untouched@other.example');
    await put('s', 'thread', own[0], {
      direction: 'sent',
      toAddr: 'Alice <a@example.com>, b@example.com',
    });
    await put('r', null, 'a@example.com', { isList: true });
    await compare();
    await db.exec('CREATE TABLE writes_seen(tbl TEXT, entity TEXT)');
    for (const [table, col] of [
      ['contacts', 'address'],
      ['domains', 'domain'],
      ['threads', 'thread_id'],
      ['contact_stats_snapshot', 'address'],
    ]) {
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        await db.exec(`CREATE TRIGGER audit_${table}_${op} AFTER ${op} ON ${table} BEGIN
          INSERT INTO writes_seen VALUES ('${table}',${op === 'DELETE' ? 'OLD' : 'NEW'}.${col}); END`);
      }
    }
    await put('stable', 'unrelated', 'untouched@other.example');
    await drain();
    assert.deepEqual(await db.prepare('SELECT * FROM writes_seen').all(), []);
    await put('older', 'thread', 'a@example.com', { internalDate: now.getTime() - 90000, unread: true });
    await compare();
    assert.equal((await repo.getContact(account, 'a@example.com')).replied_count, 1);
    await mutate("UPDATE messages SET unread=0,starred=1,important=1 WHERE gmail_message_id='older'");
    await compare();
    await put('s', 'moved', own[0], { direction: 'sent', toAddr: 'temporary@another.example' });
    await assert.rejects(
      drain(async () => {
        throw new Error('interrupted');
      }),
      /interrupted/,
    );
    // Additional changes before retry must also remove the intermediate owner.
    await put('s', 'moved', own[0], { direction: 'sent', toAddr: 'final@new.example' });
    await mutate("DELETE FROM messages WHERE gmail_message_id IN ('older','r')");
    await compare();
    assert.deepEqual(
      await db
        .prepare(
          "SELECT * FROM writes_seen WHERE entity IN ('untouched@other.example','other.example','unrelated')",
        )
        .all(),
      [],
    );
    now = new Date('2026-11-26T12:00:00Z');
    await compare();
    assert.equal(await repo.countSnapshots(account, 'untouched@other.example'), 2);
    await drain();
    assert.equal(await repo.countSnapshots(account, 'untouched@other.example'), 2);
  } finally {
    db.close();
    oracle.close();
  }
});
