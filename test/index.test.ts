/**
 * Index-layer tests (SCOPE 0.2): migrations run clean, upsert idempotency, the
 * no-downgrade rule, and FTS round-trips. All against an in-memory DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Tests import the compiled output (matching test/smoke.test.ts); `pnpm test`
// builds first via the pretest hook so dist is fresh.
import { openDb, IndexError } from '../dist/index/db.js';
import { getUserVersion, MIGRATIONS, runMigrations } from '../dist/index/migrations.js';
import { Repo } from '../dist/index/repo.js';
import { SCHEMA_VERSION } from '../dist/index/schema.js';

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

const TABLES = [
  'messages',
  'messages_fts',
  'contacts',
  'domains',
  'threads',
  'interest_profile',
  'contact_stats_snapshot',
  'sync_runs',
  'account_identity',
  'labels',
  'google_tokens',
  'jobs',
  'crm_change_events',
];

test('migrations run clean on a fresh db and create every PLAN §6 table', async () => {
  const db = await openDb({ path: ':memory:' });
  assert.equal(await getUserVersion(db), SCHEMA_VERSION);

  const names = (
    await db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  for (const t of TABLES) {
    assert.ok(names.includes(t), `expected table ${t} to exist`);
  }
});

test('running migrations twice is a no-op (idempotent)', async () => {
  const db = await openDb({ path: ':memory:' });
  const before = await getUserVersion(db);
  await runMigrations(db); // second pass
  assert.equal(await getUserVersion(db), before);
});

test('repair migration restores a CRM feed table missing from an already-versioned database', async () => {
  const db = await openDb({ path: ':memory:' });
  await db.exec('DROP TABLE crm_change_events');
  await db.exec('PRAGMA user_version = 15');
  await runMigrations(db);
  assert.equal(await getUserVersion(db), SCHEMA_VERSION);
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_change_events'").get());
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_crm_change_events_dedupe_key'").get());
});

test('repair preflight also lets the deduplication migration recover a version-13 database', async () => {
  const db = await openDb({ path: ':memory:', skipMigrations: true });
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 13)) await migration.up(db);
  await db.exec('DROP TABLE crm_change_events');
  await db.exec('PRAGMA user_version = 13');
  await runMigrations(db);
  assert.equal(await getUserVersion(db), SCHEMA_VERSION);
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_change_events'").get());
  assert.ok(await db.prepare("SELECT name FROM pragma_table_info('crm_change_events') WHERE name='dedupe_key'").get());
});

test('sqlite StorageDriver batch applies writes atomically', async () => {
  const db = await openDb({ path: ':memory:' });
  await db.exec('CREATE TABLE batch_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await assert.rejects(
    () => db.batch([
      { sql: 'INSERT INTO batch_probe (id, value) VALUES (?, ?)', params: [1, 'first'] },
      { sql: 'INSERT INTO batch_probe (id, value) VALUES (?, ?)', params: [1, 'duplicate'] },
    ]),
  );
  const row = await db.prepare('SELECT count(*) AS c FROM batch_probe').get() as { c: number };
  assert.equal(row.c, 0, 'a failed write batch rolls back every statement');
  db.close();
});

test('forward-only: refuses to open a db newer than the build', async () => {
  const db = await openDb({ path: ':memory:', skipMigrations: true });
  db.exec('PRAGMA user_version = 9999');
  await assert.rejects(async () => await runMigrations(db), /newer than this build/);
});

test('upsertMessage is idempotent by (account, gmail_message_id)', async () => {
  const repo = await freshRepo();
  const input = {
    account: 'acct-a',
    gmailMessageId: 'm1',
    subject: 'Deposit terms',
    fromAddr: 'partner@example.com',
    snippet: 'about the deposit',
  };
  await repo.upsertMessage(input);
  await repo.upsertMessage(input);
  await repo.upsertMessage({ ...input, subject: 'Deposit terms (updated)' });

  assert.equal(await repo.countMessages(), 1);
  assert.equal(await repo.countMessages('acct-a'), 1);
  const row = await repo.getMessage('acct-a', 'm1');
  assert.equal(row?.subject, 'Deposit terms (updated)');
});

test('account namespacing: same message id in two accounts are distinct rows', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: 'acct-a', gmailMessageId: 'shared' });
  await repo.upsertMessage({ account: 'acct-b', gmailMessageId: 'shared' });
  assert.equal(await repo.countMessages(), 2);
  assert.equal(await repo.countMessages('acct-a'), 1);
});

test('no-downgrade: a meta re-sync never clobbers a full body', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', snippet: 'snip' });

  // Enrich to full.
  const full = await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    snippet: 'snip',
    bodyState: 'full',
    bodyText: 'the full distilled body',
  });
  assert.equal(full, 'full');

  // A later metadata-only sync arrives (body_state defaults to meta).
  const after = await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    snippet: 'snip refreshed',
  });
  assert.equal(after, 'full', 'state must stay full');

  const row = await repo.getMessage('a', 'm1');
  assert.equal(row?.body_state, 'full');
  assert.equal(row?.body_text, 'the full distilled body', 'body must survive');
  // Metadata still refreshes.
  assert.equal(row?.snippet, 'snip refreshed');
});

test('no-downgrade: full does not clobber summary-only', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', bodyState: 'full', bodyText: 'b' });
  // Simulate demotion to summary-only at the storage level via a direct write,
  // then prove a full re-sync is held back.
  repo.driver
    .prepare(`UPDATE messages SET body_state='summary-only', body_text=NULL WHERE gmail_message_id='m1'`)
    .run();

  const after = await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    bodyState: 'full',
    bodyText: 'refetched body',
  });
  assert.equal(after, 'summary-only');
  assert.equal((await repo.getMessage('a', 'm1'))?.body_state, 'summary-only');
});

test('FTS insert + search round-trips on metadata fields', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    subject: 'Antarctica logistics',
    fromAddr: 'ops@expedition.example',
    toAddr: 'al@example.com',
    snippet: 'the zodiac schedule for landings',
  });

  assert.equal((await repo.searchMessages('Antarctica')).length, 1);
  assert.equal((await repo.searchMessages('zodiac')).length, 1, 'snippet is indexed as body');
  assert.equal((await repo.searchMessages('expedition')).length, 1, 'sender is indexed');
  assert.equal((await repo.searchMessages('nonexistentterm')).length, 0);
});

test('FTS reflects body text after enrichment to full', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', subject: 'Q', snippet: 'snip' });
  assert.equal((await repo.searchMessages('deposit')).length, 0);

  await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    subject: 'Q',
    snippet: 'snip',
    bodyState: 'full',
    bodyText: 'we agreed on a 20% deposit by Friday',
  });
  assert.equal((await repo.searchMessages('deposit')).length, 1, 'body now searchable');
});

test('FTS search can be scoped by account', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: 'a', gmailMessageId: 'm1', subject: 'shared topic' });
  await repo.upsertMessage({ account: 'b', gmailMessageId: 'm2', subject: 'shared topic' });
  assert.equal((await repo.searchMessages('shared')).length, 2);
  assert.equal((await repo.searchMessages('shared', { account: 'a' })).length, 1);
});

test('sync_runs start/finish audit row', async () => {
  const repo = await freshRepo();
  const id = await repo.startSyncRun({ account: 'a', phase: 'sync', selector: '--all' });
  await repo.finishSyncRun(id, { fetched: 10, indexed: 10 });
  const row = await repo.driver.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as {
    fetched: number;
    indexed: number;
    finished_at: string | null;
  };
  assert.equal(row.fetched, 10);
  assert.ok(row.finished_at);
});

test('activeSyncRun: a fresh in-progress row locks; a >6h-old one is a dead lock', async () => {
  const repo = await freshRepo();
  const id = await repo.startSyncRun({ account: 'a', phase: 'sync', selector: null });
  assert.equal(await repo.activeSyncRun('a'), id, 'a fresh in-progress row is the live lock');

  // Backdate its start past the stale-lock threshold (crashed sync, row never closed).
  const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
  await repo.driver.prepare('UPDATE sync_runs SET started_at = ? WHERE id = ?').run(old, id);
  assert.equal(await repo.activeSyncRun('a'), undefined, 'a stale lock no longer blocks');

  // A new run can now take the lock.
  const next = await repo.startSyncRun({ account: 'a', phase: 'sync', selector: null });
  assert.equal(await repo.activeSyncRun('a', next), undefined, 'only the stale row exists besides the new one');
  assert.equal(await repo.activeSyncRun('a'), next, 'the new run is the live lock');
});

test('closed-enum guards throw IndexError', async () => {
  const repo = await freshRepo();
  await assert.rejects(
    async () =>
      await repo.upsertMessage({
        account: 'a',
        gmailMessageId: 'm1',
        // @ts-expect-error invalid by design
        bodyState: 'garbage',
      }),
    IndexError,
  );
  await assert.rejects(
    async () => await repo.startSyncRun({ account: 'a', phase: 'nope' as never }),
    IndexError,
  );
});

test('contact + domain-category write-backs are idempotent', async () => {
  const repo = await freshRepo();
  await repo.upsertContact({ account: 'a', address: 'x@y.com', domain: 'y.com', displayName: 'X' });
  await repo.upsertContact({ account: 'a', address: 'x@y.com', curation: 'important' });
  const c = await repo.driver
    .prepare(`SELECT display_name, curation FROM contacts WHERE address='x@y.com'`)
    .get() as { display_name: string; curation: string };
  assert.equal(c.display_name, 'X', 'COALESCE keeps prior display_name');
  assert.equal(c.curation, 'important');

  await repo.setDomainCategory({ account: 'a', domain: 'y.com', category: 'travel operator' });
  const d = await repo.driver.prepare(`SELECT category FROM domains WHERE domain='y.com'`).get() as {
    category: string;
  };
  assert.equal(d.category, 'travel operator');
});
