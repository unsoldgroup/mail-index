/**
 * openDb prototype-DB guard test (SCOPE M1.1 carry-over). The old single-file
 * prototype created a `messages` table without ever setting `user_version`, so
 * a version-0 file that already contains app tables must not be treated as an
 * empty DB to migrate into — openDb should emit a clear IndexError instead of
 * letting migration fail with the raw "table messages already exists".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, IndexError } from '../dist/index/db.js';

/** Create a fresh prototype-shaped DB (a `messages` table, user_version=0). */
function makePrototypeDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE messages (gmail_message_id TEXT PRIMARY KEY, subject TEXT)`);
  // The prototype never set user_version, so it stays at the default 0.
  const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(v.user_version, 0, 'precondition: prototype DB is unversioned');
  db.close();
}

test('openDb throws a clear IndexError on a pre-existing un-versioned prototype DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-index-guard-'));
  const path = join(dir, 'mail.sqlite');
  try {
    makePrototypeDb(path);

    await assert.rejects(
      async () => await openDb({ path }),
      (err: unknown) =>
        err instanceof IndexError &&
        /pre-existing un-versioned database/.test((err as Error).message) &&
        (err as Error).message.includes(path),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb still opens a normal fresh DB and migrates it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-index-fresh-'));
  const path = join(dir, 'mail.sqlite');
  try {
    const db = await openDb({ path });
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`)
      .get() as { name: string } | undefined;
    assert.ok(row, 'migrations created the messages table');
    db.close();

    // Re-opening the now-versioned DB is fine (guard only fires at version 0).
    const db2 = await openDb({ path });
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
