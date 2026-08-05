/**
 * Label-name resolution tests (id ↔ human name). Covers the index catalogue
 * (setLabels/labelMap/labelNameToId/labelNames), the per-sync refresh
 * (syncLabels), and the write-path name→id resolution + display rendering in
 * ingest/mutate. No live provider — a fixture/spy adapter throughout. Tests
 * import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { syncLabels } from '../dist/ingest/sync-labels.js';
import { applyLabelChange, archiveChange } from '../dist/ingest/mutate.js';

const CATALOGUE = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'STARRED', name: 'STARRED', type: 'system' },
  { id: 'Label_99', name: 'Coverage Review', type: 'user' },
];

async function repoWith(labels) {
  const repo = new Repo(await openDb({ path: ':memory:' }));
  if (labels) await repo.setLabels('acct', labels);
  return repo;
}

test('Repo.setLabels + labelMap/labelNameToId round-trip', async () => {
  const repo = await repoWith(CATALOGUE);
  assert.equal((await repo.labelMap('acct')).get('Label_99'), 'Coverage Review');
  assert.equal((await repo.labelNameToId('acct')).get('coverage review'), 'Label_99'); // case-insensitive
  assert.equal((await repo.labelNameToId('acct')).get('inbox'), 'INBOX');
});

test('Repo.labelNames renders ids → names, passing unknown ids through', async () => {
  const repo = await repoWith(CATALOGUE);
  assert.deepEqual(await repo.labelNames('acct', ['INBOX', 'Label_99', 'Label_UNKNOWN']), [
    'INBOX',
    'Coverage Review',
    'Label_UNKNOWN',
  ]);
});

test('Repo.setLabels is a full replace (a provider-deleted label disappears)', async () => {
  const repo = await repoWith(CATALOGUE);
  await repo.setLabels('acct', [{ id: 'INBOX', name: 'INBOX', type: 'system' }]);
  assert.equal((await repo.labelMap('acct')).has('Label_99'), false);
});

test('Repo.labelMap is empty for an account with no cached catalogue (raw-id fallback)', async () => {
  const repo = await repoWith(null);
  assert.equal((await repo.labelMap('acct')).size, 0);
  assert.deepEqual(await repo.labelNames('acct', ['Label_99']), ['Label_99']); // passthrough
});

test('syncLabels stores the adapter catalogue; returns 0 for a read-only-ish adapter', async () => {
  const repo = await repoWith(null);
  const n = await syncLabels({ account: 'acct', source: new FakeMailSource(), repo });
  assert.ok(n >= 2);
  assert.equal((await repo.labelMap('acct')).get('Label_1'), 'Coverage Review');

  // An adapter without listLabels() is a no-op (0), never throws.
  const bare = { provider: 'bare' };
  assert.equal(await syncLabels({ account: 'acct', source: bare, repo }), 0);
});

test('mutate resolves a friendly NAME → id for the provider, and renders names back', async () => {
  const repo = await repoWith(CATALOGUE);
  // Seed the target message so the local index update has a row.
  await repo.upsertMessage({ account: 'acct', gmailMessageId: 'm1', subject: 'x', labels: ['INBOX'] });

  const calls = [];
  const source = {
    provider: 'fake',
    modify: (id, change) => {
      calls.push(change);
      return Promise.resolve();
    },
  };
  const res = await applyLabelChange({
    account: 'acct',
    id: 'm1',
    source,
    repo,
    change: { addLabelIds: ['Coverage Review'] }, // a NAME
  });
  // Provider received the resolved ID, not the name.
  assert.deepEqual(calls[0], { addLabelIds: ['Label_99'] });
  // Result renders ids back to names for display.
  assert.ok(res.labelNames.includes('Coverage Review'));
  assert.ok(!res.labelNames.includes('Label_99'));
});

test('mutate passes system labels + unknown strings through unchanged', async () => {
  const repo = await repoWith(CATALOGUE);
  await repo.upsertMessage({ account: 'acct', gmailMessageId: 'm1', subject: 'x', labels: ['INBOX'] });
  const calls = [];
  const source = { provider: 'fake', modify: (_id, c) => (calls.push(c), Promise.resolve()) };
  await applyLabelChange({ account: 'acct', id: 'm1', source, repo, change: archiveChange() });
  assert.deepEqual(calls[0], { removeLabelIds: ['INBOX'] }); // system label, minimal payload
});
