/**
 * Opt-in mailbox-write tests (archive + label edit). Covers the two layers the
 * feature adds with NO live provider:
 *  - Repo.applyLabelChange — the INDEX-ONLY label/derived-column update.
 *  - ingest/mutate.applyLabelChange — provider-write-then-index orchestration,
 *    the read-only-adapter guard, and scope-error propagation.
 * Tests import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import {
  applyLabelChange,
  archiveChange,
  MailboxWriteUnsupportedError,
} from '../dist/ingest/mutate.js';
import { InsufficientScopeError } from '../dist/source/index.js';

async function repoWithMessage(labels) {
  const repo = new Repo(await openDb({ path: ':memory:' }));
  await repo.upsertMessage({
    account: 'acct',
    gmailMessageId: 'm1',
    subject: 'hi',
    labels,
    category: labels.includes('CATEGORY_PROMOTIONS') ? 'promotions' : 'primary',
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    important: labels.includes('IMPORTANT'),
  });
  return repo;
}

test('Repo.applyLabelChange recomputes derived columns from the new label set', async () => {
  const repo = await repoWithMessage(['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']);
  const next = await repo.applyLabelChange('acct', 'm1', { add: ['STARRED'], remove: ['UNREAD'] });
  assert.deepEqual([...(next ?? [])].sort(), ['CATEGORY_PROMOTIONS', 'INBOX', 'STARRED']);

  const row = await repo.getMessage('acct', 'm1');
  assert.equal(row.unread, 0, 'removing UNREAD clears the unread flag');
  assert.equal(row.starred, 1, 'adding STARRED sets the starred flag');
  assert.equal(row.category, 'promotions', 'category still derives from CATEGORY_PROMOTIONS');
});

test('Repo.applyLabelChange archive drops INBOX and re-derives category', async () => {
  const repo = await repoWithMessage(['INBOX']);
  const next = await repo.applyLabelChange('acct', 'm1', { remove: ['INBOX'] });
  assert.deepEqual(next, []);
  const row = await repo.getMessage('acct', 'm1');
  // No INBOX and no CATEGORY_* label → category is no longer 'primary'.
  assert.equal(row.category, null);
});

test('Repo.applyLabelChange returns null for a message not in the index', async () => {
  const repo = await repoWithMessage(['INBOX']);
  assert.equal(await repo.applyLabelChange('acct', 'missing', { remove: ['INBOX'] }), null);
});

test('ingest.applyLabelChange writes the provider first, then the index', async () => {
  const repo = await repoWithMessage(['INBOX']);
  const calls = [];
  const source = {
    provider: 'fake',
    modify: (id, change) => {
      calls.push({ id, change });
      return Promise.resolve();
    },
  };
  const result = await applyLabelChange({
    account: 'acct',
    id: 'm1',
    source,
    repo,
    change: archiveChange(),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].change, { removeLabelIds: ['INBOX'] });
  assert.equal(result.indexed, true);
  assert.deepEqual(result.labels, []);
  // Archive dropped INBOX → category re-derives to null in the local row.
  assert.equal((await repo.getMessage('acct', 'm1')).category, null);
});

test('ingest.applyLabelChange rejects a read-only adapter (no modify)', async () => {
  const repo = await repoWithMessage(['INBOX']);
  const source = { provider: 'readonly' }; // no modify method
  await assert.rejects(
    async () => await applyLabelChange({ account: 'acct', id: 'm1', source, repo, change: archiveChange() }),
    MailboxWriteUnsupportedError,
  );
});

test('ingest.applyLabelChange propagates a scope error WITHOUT touching the index', async () => {
  const repo = await repoWithMessage(['INBOX']);
  const source = {
    provider: 'gog',
    modify: () => Promise.reject(new InsufficientScopeError('gog', 'gog auth add ...')),
  };
  await assert.rejects(
    async () => await applyLabelChange({ account: 'acct', id: 'm1', source, repo, change: archiveChange() }),
    InsufficientScopeError,
  );
  // The local row is untouched because the provider write failed first: the
  // INBOX-derived category is still 'primary' (an archive would have nulled it).
  assert.equal((await repo.getMessage('acct', 'm1')).category, 'primary');
});
