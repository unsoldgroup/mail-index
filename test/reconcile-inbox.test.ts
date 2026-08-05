/**
 * Inbox membership reconcile tests (label freshness). Seeds an index with a
 * mix of inbox/archived rows, drives {@link reconcileInbox} with a controllable
 * in-memory inbox source, and asserts membership becomes exact: archived rows
 * lose INBOX (and `primary` category), a fresh inbox id is indexed, and a
 * re-inboxed row regains INBOX. Also covers the `messagesByLabel` query.
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { reconcileInbox } from '../dist/ingest/reconcile-inbox.js';

const ACCOUNT = 'test-acct';

async function freshRepo() {
  return new Repo(await openDb({ path: ':memory:' }));
}

/** Minimal MailSource: a fixed live-inbox id set + metadata for new ids. */
function inboxSource(liveIds, metaById = {}) {
  return {
    provider: 'fake',
    check: () => Promise.resolve({ ok: true, address: 'me@example.com' }),
    listIds: async function* () {
      await Promise.resolve();
      for (const id of liveIds) yield id;
    },
    getMetadata: (ids) =>
      Promise.resolve(ids.map((id) => metaById[id]).filter((m) => m != null)),
    getFull: () => Promise.resolve(null),
  };
}

async function seed(repo, id, labels, opts = {}) {
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: id,
    subject: opts.subject ?? `subject ${id}`,
    fromAddr: opts.from ?? 'a@b.com',
    internalDate: opts.internalDate ?? 1_700_000_000_000,
    labels,
    category: labels.includes('INBOX') ? 'primary' : null,
    bodyState: 'meta',
  });
}

test('reconcile drops INBOX from rows no longer in the live inbox', async () => {
  const repo = await freshRepo();
  await seed(repo, 'kept', ['INBOX', 'UNREAD']);
  await seed(repo, 'archived', ['INBOX']);

  const res = await reconcileInbox({
    account: ACCOUNT,
    source: inboxSource(['kept']), // 'archived' fell out of the inbox
    repo,
  });

  assert.equal(res.archived, 1);
  const archived = await repo.getMessage(ACCOUNT, 'archived');
  assert.ok(archived);
  assert.equal(JSON.parse(archived.labels_json).includes('INBOX'), false);
  assert.equal(archived.category, null, 'category drops off primary when INBOX leaves');

  // The still-inbox row is untouched (membership + its other labels intact).
  const kept = await repo.getMessage(ACCOUNT, 'kept');
  assert.deepEqual(JSON.parse(kept.labels_json).sort(), ['INBOX', 'UNREAD']);
});

test('reconcile indexes a live inbox id not yet stored', async () => {
  const repo = await freshRepo();
  const meta = {
    id: 'fresh',
    threadId: null,
    internalDate: 1_700_000_500_000,
    dateHeader: null,
    from: 'new@sender.com',
    to: null,
    cc: null,
    subject: 'fresh inbox mail',
    labels: ['INBOX', 'UNREAD'],
    snippet: 'hello',
    sizeEstimate: 10,
    headers: {},
  };

  const res = await reconcileInbox({
    account: ACCOUNT,
    source: inboxSource(['fresh'], { fresh: meta }),
    repo,
  });

  assert.equal(res.added, 1);
  const row = await repo.getMessage(ACCOUNT, 'fresh');
  assert.ok(row);
  assert.equal(row.subject, 'fresh inbox mail');
  assert.equal(JSON.parse(row.labels_json).includes('INBOX'), true);
  assert.equal(row.category, 'primary');
});

test('reconcile restores INBOX on a re-inboxed indexed row', async () => {
  const repo = await freshRepo();
  await seed(repo, 'reinbox', ['UNREAD']); // indexed, currently NOT in inbox

  const res = await reconcileInbox({
    account: ACCOUNT,
    source: inboxSource(['reinbox']), // now back in the inbox
    repo,
  });

  assert.equal(res.restored, 1);
  const row = await repo.getMessage(ACCOUNT, 'reinbox');
  assert.deepEqual(JSON.parse(row.labels_json).sort(), ['INBOX', 'UNREAD']);
  assert.equal(row.category, 'primary');
});

test('messagesByLabel filters by stored label membership, newest-first', async () => {
  const repo = await freshRepo();
  await seed(repo, 'in-old', ['INBOX'], { internalDate: 1000 });
  await seed(repo, 'in-new', ['INBOX'], { internalDate: 3000 });
  await seed(repo, 'promo', ['CATEGORY_PROMOTIONS'], { internalDate: 4000 });
  await seed(repo, 'starred', ['INBOX', 'STARRED'], { internalDate: 2000 });

  const inbox = await repo.messagesByLabel('INBOX', { account: ACCOUNT });
  assert.deepEqual(
    inbox.map((r) => r.gmail_message_id),
    ['in-new', 'starred', 'in-old'],
    'only INBOX rows, newest internal_date first',
  );

  const starred = await repo.messagesByLabel('STARRED', { account: ACCOUNT });
  assert.deepEqual(starred.map((r) => r.gmail_message_id), ['starred']);
});
