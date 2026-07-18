/**
 * Multi-account sweep tests (SCOPE 1.3, UNS-1218, PLAN §15). Drive
 * {@link runSyncAll} over a test operator config with several accounts, each
 * backed by its own fake source. Assert:
 *
 *  - every configured account is swept (in config order), indexing its own
 *    messages under its own account label;
 *  - each account's stored syncPolicy preset reaches the run (per-account limit
 *    bounds that account's sweep);
 *  - each account gets its own sync_runs audit row (per-account lock);
 *  - one account's failure is isolated — captured as an outcome error while the
 *    others still complete.
 *
 * Runs against FakeMailSource (no network); imports compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { runSyncAll } from '../dist/cli/sync.js';

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

/** A minimal fixtures bag with `n` messages, ids prefixed by the account label. */
function fixtures(label: string, n: number): never {
  const messages = Array.from({ length: n }, (_, i) => ({
    id: `${label}-m${i}`,
    threadId: `${label}-t${i}`,
    internalDate: 1_717_000_000_000 - i * 1000,
    dateHeader: null,
    from: `sender${i}@${label}.example.com`,
    to: `${label}@example.com`,
    cc: null,
    subject: `${label} message ${i}`,
    labels: ['INBOX'],
    snippet: `snippet ${i}`,
    sizeEstimate: 1024,
    bodyText: `body ${i}`,
    bodyHtml: null,
    mimeType: 'text/plain',
  }));
  return { address: `${label}@example.com`, messages } as never;
}

const CONFIG = {
  accounts: {
    alpha: { adapter: 'gws', configDir: '/a', syncPolicy: { limit: 2 } },
    beta: { adapter: 'gws', configDir: '/b' },
  },
} as never;

/** Build a fake source per account label from a fixtures map. */
function builderFor(byLabel: Record<string, number>) {
  // The account binding does not carry its label, so we key the fake on its
  // configDir (unique per account in CONFIG) to hand each account its own data.
  const byDir: Record<string, string> = { '/a': 'alpha', '/b': 'beta' };
  return (account: { configDir: string }) => {
    const label = byDir[account.configDir]!;
    return new FakeMailSource(fixtures(label, byLabel[label]!));
  };
}

test('runSyncAll sweeps every configured account under its own label', async () => {
  const repo = await freshRepo();
  const outcomes = await runSyncAll(CONFIG, {}, repo, builderFor({ alpha: 5, beta: 3 }));

  assert.deepEqual(
    outcomes.map((o) => o.account),
    ['alpha', 'beta'],
    'one outcome per account, in config order',
  );
  assert.ok(outcomes.every((o) => o.error == null), 'no failures');

  // alpha's policy limit=2 bounds its sweep; beta (no limit) takes all 3.
  assert.equal(outcomes[0]?.result?.indexed, 2);
  assert.equal(outcomes[1]?.result?.indexed, 3);
  assert.equal(await repo.countMessages('alpha'), 2);
  assert.equal(await repo.countMessages('beta'), 3);

  // Messages landed under the right account label (no cross-contamination).
  assert.ok(await repo.getMessage('alpha', 'alpha-m0'));
  assert.equal(await repo.getMessage('beta', 'alpha-m0'), undefined);
});

test('runSyncAll writes a per-account sync_runs audit row', async () => {
  const repo = await freshRepo();
  await runSyncAll(CONFIG, {}, repo, builderFor({ alpha: 1, beta: 1 }));

  for (const label of ['alpha', 'beta']) {
    const row = await repo.driver
      .prepare('SELECT account, phase, finished_at FROM sync_runs WHERE account = ?')
      .get(label) as { account: string; phase: string; finished_at: string | null };
    assert.equal(row.account, label);
    assert.equal(row.phase, 'sync');
    assert.ok(row.finished_at, 'run closed → per-account lock released');
  }
});

test('runSyncAll isolates a single account failure from the rest', async () => {
  const repo = await freshRepo();
  const builder = (account: { configDir: string }) => {
    if (account.configDir === '/a') {
      const boom = new FakeMailSource(fixtures('alpha', 1));
      (boom as unknown as { listIds: () => AsyncIterable<string> }).listIds = () => ({
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error('alpha provider exploded');
        },
      });
      return boom;
    }
    return new FakeMailSource(fixtures('beta', 4));
  };

  const outcomes = await runSyncAll(CONFIG, {}, repo, builder as never);

  assert.match(outcomes[0]?.error ?? '', /alpha provider exploded/);
  assert.equal(outcomes[0]?.result, undefined);
  // beta still synced despite alpha failing first.
  assert.equal(outcomes[1]?.result?.indexed, 4);
  assert.equal(await repo.countMessages('beta'), 4);
  // alpha's failed run released its lock (closed audit row).
  assert.equal(await repo.activeSyncRun('alpha'), undefined);
});
