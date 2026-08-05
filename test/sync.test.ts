/**
 * Sync phase-1 tests (SCOPE 0.6, PLAN §7 phase 1, D12, ADR-0005). Runs the
 * metadata sweep against the in-memory FakeMailSource built from the recorded
 * fixtures (no live network) and asserts: message rows + counts, classification
 * applied, FTS searchability, a sync_runs audit row, idempotent + no-downgrade
 * re-run, and the per-account lock refusing a concurrent run. Tests import the
 * compiled output; `pnpm test` builds first via the pretest hook.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { DEFAULT_FIXTURES } from '../dist/source/fixtures/index.js';
import { syncMetadata, SyncError } from '../dist/ingest/sync.js';

const ACCOUNT = 'test-acct';

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

function fakeSource(): FakeMailSource {
  return new FakeMailSource(DEFAULT_FIXTURES);
}

test('sync indexes every fixture message and returns matching counts', async () => {
  const repo = await freshRepo();
  const result = await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  assert.equal(result.account, ACCOUNT);
  assert.equal(result.fetched, DEFAULT_FIXTURES.messages.length);
  assert.equal(result.indexed, DEFAULT_FIXTURES.messages.length);
  assert.equal(await repo.countMessages(ACCOUNT), DEFAULT_FIXTURES.messages.length);
});

test('sync stores headers/snippet/labels and sets body_state=meta', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  const direct = await repo.getMessage(ACCOUNT, 'fixt-direct-1');
  assert.ok(direct);
  assert.equal(direct.subject, 'Re: Deposit terms for the Antarctica charter');
  assert.equal(direct.from_addr, 'Jordan Partner <jordan@partner.example.com>');
  assert.equal(direct.snippet, DEFAULT_FIXTURES.messages[0]?.snippet);
  assert.equal(direct.body_state, 'meta');
  assert.equal(direct.body_text, null);
});

test('sync applies classification (category / is_list / direction)', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  // Direct human mail: personal category, not a list, received.
  const direct = await repo.getMessage(ACCOUNT, 'fixt-direct-1');
  assert.ok(direct);
  assert.equal(direct.category, 'personal');
  assert.equal(direct.is_list, 0);
  assert.equal(direct.direction, 'received');

  // Newsletter: List-* headers drive is_list=1, updates category.
  const list = await repo.getMessage(ACCOUNT, 'fixt-list-1');
  assert.ok(list);
  assert.equal(list.category, 'updates');
  assert.equal(list.is_list, 1);
  assert.equal(list.unread, 1); // UNREAD label snapshotted (D12)

  // Sent mail: SENT label → direction sent.
  const sent = await repo.getMessage(ACCOUNT, 'fixt-sent-1');
  assert.ok(sent);
  assert.equal(sent.direction, 'sent');
});

test('sync snapshots important/starred/unread from labels (D12)', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  const direct = await repo.getMessage(ACCOUNT, 'fixt-direct-1');
  assert.ok(direct);
  assert.equal(direct.important, 1); // IMPORTANT label present
  assert.equal(direct.unread, 0); // no UNREAD label
  assert.equal(direct.starred, 0);
});

test('synced messages are FTS-searchable by subject/sender/snippet', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  const bySubject = await repo.searchMessages('Antarctica', { account: ACCOUNT });
  assert.ok(
    bySubject.some((m) => m.gmail_message_id === 'fixt-direct-1'),
    'subject term must match',
  );

  const bySender = await repo.searchMessages('jordan', { account: ACCOUNT });
  assert.ok(bySender.some((m) => m.gmail_message_id === 'fixt-direct-1'), 'sender must match');

  const bySnippet = await repo.searchMessages('zodiac', { account: ACCOUNT });
  assert.ok(bySnippet.some((m) => m.gmail_message_id === 'fixt-list-1'), 'snippet must match');
});

test('sync writes a sync_runs audit row with phase + counts', async () => {
  const repo = await freshRepo();
  const result = await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  const row = await repo.driver
    .prepare('SELECT * FROM sync_runs WHERE id = ?')
    .get(result.runId) as Record<string, unknown>;
  assert.ok(row);
  assert.equal(row['account'], ACCOUNT);
  assert.equal(row['phase'], 'sync');
  assert.ok(row['started_at'], 'started_at recorded');
  assert.ok(row['finished_at'], 'finished_at recorded (row closed → lock released)');
  assert.equal(row['fetched'], DEFAULT_FIXTURES.messages.length);
  assert.equal(row['indexed'], DEFAULT_FIXTURES.messages.length);
  assert.equal(row['error'], null);
});

test('sync records the selector for a scoped run', async () => {
  const repo = await freshRepo();
  const result = await syncMetadata({
    account: ACCOUNT,
    source: fakeSource(),
    repo,
    scope: { since: '30d', limit: 2 },
  });
  assert.match(result.selector ?? '', /since=30d/);
  assert.match(result.selector ?? '', /limit=2/);
  // limit honoured by the adapter's listIds.
  assert.equal(result.indexed, 2);
});

test('re-running sync is idempotent — no duplicate rows, two audit rows', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  const firstCount = await repo.countMessages(ACCOUNT);

  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  assert.equal(await repo.countMessages(ACCOUNT), firstCount, 'no duplicate messages on re-run');

  const runs = await repo.driver
    .prepare('SELECT count(*) c FROM sync_runs WHERE account = ?')
    .get(ACCOUNT) as { c: number };
  assert.equal(runs.c, 2, 'each run writes its own audit row');
});

test('re-running sync does not downgrade an enriched (full) body to meta', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

  // Simulate an enrichment having promoted the message to a full body.
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: 'fixt-direct-1',
    bodyState: 'full',
    bodyText: 'the distilled full body',
  });
  assert.equal((await repo.getMessage(ACCOUNT, 'fixt-direct-1'))?.body_state, 'full');

  // A phase-1 re-sync delivers meta — must not clobber the full body (invariant).
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  const after = await repo.getMessage(ACCOUNT, 'fixt-direct-1');
  assert.equal(after?.body_state, 'full', 'no downgrade meta over full');
  assert.equal(after?.body_text, 'the distilled full body', 'full body preserved');
});

test('lock: a second concurrent run for the same account is refused', async () => {
  const repo = await freshRepo();
  // Plant an in-progress run (started, not finished) — the lock (ADR-0005).
  const heldId = await repo.startSyncRun({ account: ACCOUNT, phase: 'sync', selector: null });

  await assert.rejects(
    () => syncMetadata({ account: ACCOUNT, source: fakeSource(), repo }),
    (err: unknown) => err instanceof SyncError && /already in progress/.test((err as Error).message),
  );

  // The held run is still the only active row; nothing was indexed.
  assert.equal(await repo.countMessages(ACCOUNT), 0, 'refused run indexes nothing');
  assert.equal(await repo.activeSyncRun(ACCOUNT), heldId, 'the original lock is untouched');
});

test('lock: a different account is not blocked by another account run', async () => {
  const repo = await freshRepo();
  await repo.startSyncRun({ account: 'other-acct', phase: 'sync', selector: null });

  // A run for ACCOUNT proceeds despite other-acct holding its own lock.
  const result = await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  assert.equal(result.indexed, DEFAULT_FIXTURES.messages.length);
});

test('lock is released after a run so the next run can proceed', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  assert.equal(await repo.activeSyncRun(ACCOUNT), undefined, 'no active run after completion');

  // A follow-up run succeeds (lock was released).
  const second = await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  assert.ok(second.runId > 0);
});

test('a failing source closes the audit row with an error and releases the lock', async () => {
  const repo = await freshRepo();
  const boom: FakeMailSource = fakeSource();
  // Force listIds to throw mid-sweep.
  (boom as unknown as { listIds: () => AsyncIterable<string> }).listIds = () => ({
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error('provider exploded');
    },
  });

  await assert.rejects(() => syncMetadata({ account: ACCOUNT, source: boom, repo }), /provider exploded/);

  // Audit row closed with the error; lock released so a retry can run.
  const row = await repo.driver
    .prepare('SELECT finished_at, error FROM sync_runs WHERE account = ? ORDER BY id DESC LIMIT 1')
    .get(ACCOUNT) as { finished_at: string | null; error: string | null };
  assert.ok(row.finished_at, 'row closed');
  assert.match(row.error ?? '', /provider exploded/);
  assert.equal(await repo.activeSyncRun(ACCOUNT), undefined, 'lock released after failure');
});

// --- Identity guard (migration 3): adapter-switch safety ---------------------

/**
 * A MailSource that serves the DEFAULT_FIXTURES messages but with a caller-set
 * provider id and authenticated address — to simulate the *same* mailbox seen
 * through a different transport (gws ↔ gog), or a *different* mailbox mistakenly
 * bound to the same label.
 */
function sourceAs(provider: string, address: string): FakeMailSource {
  const s = new FakeMailSource({ ...DEFAULT_FIXTURES, address });
  Object.defineProperty(s, 'provider', { value: provider });
  return s;
}

test('identity guard: first sync pins the label to the authenticated mailbox', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: sourceAs('gws', 'al@example.com'), repo });
  const id = await repo.getAccountIdentity(ACCOUNT);
  assert.ok(id);
  assert.equal(id.address, 'al@example.com');
  assert.equal(id.provider, 'gws');
});

test('identity guard: switching transport on the same mailbox reuses the index', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: sourceAs('gws', 'al@example.com'), repo });
  const countAfterGws = await repo.countMessages(ACCOUNT);

  // Same mailbox, different adapter — must succeed and NOT wipe/duplicate rows.
  const second = await syncMetadata({
    account: ACCOUNT,
    source: sourceAs('gog', 'al@example.com'),
    repo,
  });
  assert.ok(second.runId > 0);
  assert.equal(await repo.countMessages(ACCOUNT), countAfterGws, 'cached rows reused, not re-keyed');
  assert.equal((await repo.getAccountIdentity(ACCOUNT))?.provider, 'gog', 'provider refreshed');
});

test('identity guard: a different mailbox under the same label is refused', async () => {
  const repo = await freshRepo();
  await syncMetadata({ account: ACCOUNT, source: sourceAs('gws', 'al@example.com'), repo });
  const before = await repo.countMessages(ACCOUNT);

  await assert.rejects(
    () => syncMetadata({ account: ACCOUNT, source: sourceAs('gog', 'someone-else@example.com'), repo }),
    (err: Error) => err instanceof SyncError && /refusing to sync/.test(err.message),
  );
  // The mismatched sweep wrote nothing — the cache is protected.
  assert.equal(await repo.countMessages(ACCOUNT), before);
  assert.equal((await repo.getAccountIdentity(ACCOUNT))?.address, 'al@example.com', 'identity unchanged');
});
