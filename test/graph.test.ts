/**
 * Graph engine tests (SCOPE 2.3, PLAN §9, D8/D9/D10, CONTEXT.md
 * "Correspondent").
 *
 * Seeds a tmp in-memory DB with threads — some `is_list = 1` to prove the D9
 * bulk-mail exclusion — runs the aggregation pass (which populates
 * `threads.participants_json`, the graph's input) and then {@link buildGraph},
 * asserting:
 *
 *  - centrality ORDERING: a hub contact (on every thread of a cluster) ranks
 *    above its leaf neighbours;
 *  - community ASSIGNMENT: two disjoint co-recipiency clusters resolve to two
 *    distinct Louvain communities;
 *  - the bulk (`is_list = 1`) thread that would otherwise BRIDGE the two
 *    clusters into one is excluded, so the clusters stay separate (D9);
 *  - centrality + community_id are PERSISTED back onto `contacts`;
 *  - the build is idempotent (re-running reproduces the same metrics);
 *  - the build is a no-op on an empty index and never breaks core search/sync —
 *    a fresh search works without graphology being loaded by the index layer.
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { buildGraph } from '../dist/graph/index.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { runSyncOne } from '../dist/cli/sync.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';

async function freshRepo() {
  return new Repo(await openDb({ path: ':memory:' }));
}

/** Seed one message row directly through the repo (phase-1 shape). */
async function seed(repo, m) {
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: m.id,
    threadId: m.threadId ?? null,
    internalDate: m.internalDate ?? null,
    fromAddr: m.from ?? null,
    toAddr: m.to ?? null,
    ccAddr: m.cc ?? null,
    subject: m.subject ?? null,
    direction: m.direction ?? 'received',
    isList: m.isList ?? false,
    category: m.category ?? null,
    unread: m.unread ?? false,
    snippet: m.snippet ?? null,
    bodyState: 'meta',
  });
}

/**
 * Seed two disjoint social circles via co-recipiency, plus a bulk list thread
 * that would bridge them if not excluded (D9):
 *
 *  Cluster 1 ("work"): the user sends three threads, each addressed to the hub
 *    `hub@work.example.com` together with one leaf, so the hub co-occurs with
 *    every leaf (degree 3) while leaves co-occur only with the hub (degree 1) →
 *    the hub is the central node.
 *
 *  Cluster 2 ("family"): the user sends one thread to three family addresses,
 *    forming a small clique disjoint from cluster 1.
 *
 *  Bulk thread: a single `is_list = 1` newsletter thread whose participant set
 *    spans BOTH clusters. Co-recipiency over it would merge the two communities
 *    and lift everyone's centrality; D9 drops it, so it must NOT affect the
 *    graph.
 */
async function seedTwoCircles(repo) {
  const HUB = 'hub@work.example.com';
  const W1 = 'w1@work.example.com';
  const W2 = 'w2@work.example.com';
  const W3 = 'w3@work.example.com';
  const F1 = 'f1@family.example.com';
  const F2 = 'f2@family.example.com';
  const F3 = 'f3@family.example.com';

  // Cluster 1: hub on every thread, each with a distinct leaf.
  await seed(repo, {
    id: 'w-a',
    threadId: 'thread-w-a',
    internalDate: 1000,
    from: `Al <${ME}>`,
    to: `Hub <${HUB}>, W1 <${W1}>`,
    subject: 'work a',
    direction: 'sent',
  });
  await seed(repo, {
    id: 'w-b',
    threadId: 'thread-w-b',
    internalDate: 2000,
    from: `Al <${ME}>`,
    to: `Hub <${HUB}>, W2 <${W2}>`,
    subject: 'work b',
    direction: 'sent',
  });
  await seed(repo, {
    id: 'w-c',
    threadId: 'thread-w-c',
    internalDate: 3000,
    from: `Al <${ME}>`,
    to: `Hub <${HUB}>, W3 <${W3}>`,
    subject: 'work c',
    direction: 'sent',
  });

  // Cluster 2: one thread to a family clique (disjoint from cluster 1).
  await seed(repo, {
    id: 'f-a',
    threadId: 'thread-f-a',
    internalDate: 4000,
    from: `Al <${ME}>`,
    to: `F1 <${F1}>, F2 <${F2}>, F3 <${F3}>`,
    subject: 'family a',
    direction: 'sent',
  });

  // Bulk list thread spanning BOTH clusters — must be excluded (D9). Modelled as
  // a sent message to everyone tagged is_list so the thread is a list thread.
  await seed(repo, {
    id: 'bulk',
    threadId: 'thread-bulk',
    internalDate: 5000,
    from: `Al <${ME}>`,
    to: `Hub <${HUB}>, W1 <${W1}>, F1 <${F1}>, F2 <${F2}>`,
    subject: 'announce all',
    direction: 'sent',
    isList: true,
    category: 'updates',
  });

  return { HUB, W1, W2, W3, F1, F2, F3 };
}

test('graphThreads excludes is_list threads (D9)', async () => {
  const repo = await freshRepo();
  await seedTwoCircles(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const threads = await repo.graphThreads(ACCOUNT);
  const ids = threads.map((t) => t.threadId).sort();
  // The four non-list threads survive; the bulk thread is dropped.
  assert.deepEqual(ids, ['thread-f-a', 'thread-w-a', 'thread-w-b', 'thread-w-c']);
  assert.ok(!ids.includes('thread-bulk'), 'the is_list thread must be excluded');
});

test('hub contact ranks highest in centrality', async () => {
  const repo = await freshRepo();
  const { HUB, W1, W2, W3 } = await seedTwoCircles(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const result = await buildGraph(repo, ACCOUNT);
  const byAddr = new Map(result.metrics.map((m) => [m.address, m]));

  const hub = byAddr.get(HUB);
  assert.ok(hub, 'hub must be in the graph');
  // The hub co-occurs with three leaves; each leaf with only the hub.
  for (const leaf of [W1, W2, W3]) {
    const m = byAddr.get(leaf);
    assert.ok(m, `${leaf} must be in the graph`);
    assert.ok(
      hub.centrality > m.centrality,
      `hub centrality (${hub.centrality}) should exceed leaf ${leaf} (${m.centrality})`,
    );
  }

  // The hub is the single most central node overall.
  const top = [...result.metrics].sort((a, b) => b.centrality - a.centrality)[0];
  assert.equal(top.address, HUB, 'the hub should be the most central contact');
});

test('two disjoint clusters resolve to two communities (D9 exclusion holds)', async () => {
  const repo = await freshRepo();
  const { HUB, W1, W2, W3, F1, F2, F3 } = await seedTwoCircles(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const result = await buildGraph(repo, ACCOUNT);
  const community = new Map(result.metrics.map((m) => [m.address, m.communityId]));

  // Every work node shares one community; every family node shares another.
  const workCommunity = community.get(HUB);
  for (const a of [W1, W2, W3]) {
    assert.equal(community.get(a), workCommunity, `${a} should join the hub's community`);
  }
  const familyCommunity = community.get(F1);
  for (const a of [F2, F3]) {
    assert.equal(community.get(a), familyCommunity, `${a} should join the family community`);
  }
  // The two clusters must be distinct: the bulk bridge was excluded (D9).
  assert.notEqual(
    workCommunity,
    familyCommunity,
    'work and family must be separate communities (bulk bridge excluded)',
  );
  assert.equal(result.communities, 2, 'exactly two communities expected');
});

test('centrality + community_id are persisted back onto contacts', async () => {
  const repo = await freshRepo();
  const { HUB } = await seedTwoCircles(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  // Before the build, contacts carry no derived graph metrics.
  const before = await repo.getGraphMetrics(ACCOUNT, HUB);
  assert.ok(before, 'hub contact row should exist after aggregation');
  assert.equal(before.centrality, null);
  assert.equal(before.community_id, null);

  await buildGraph(repo, ACCOUNT);

  const after = await repo.getGraphMetrics(ACCOUNT, HUB);
  assert.ok(after, 'hub contact row should still exist');
  assert.ok(typeof after.centrality === 'number' && after.centrality > 0, 'centrality persisted');
  assert.ok(typeof after.community_id === 'number', 'community_id persisted');
});

test('build is idempotent — re-running reproduces the same metrics', async () => {
  const repo = await freshRepo();
  await seedTwoCircles(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const first = await buildGraph(repo, ACCOUNT);
  const second = await buildGraph(repo, ACCOUNT);

  const norm = (r) =>
    [...r.metrics]
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((m) => `${m.address}:${m.centrality.toFixed(6)}:${m.communityId}`);

  assert.deepEqual(norm(first), norm(second), 'a re-build over an unchanged index is identical');
  assert.equal(first.communities, second.communities);
});

test('build is a no-op on an empty index and search still works without graphology', async () => {
  const repo = await freshRepo();

  // No messages → no threads → empty graph, nothing persisted.
  const result = await buildGraph(repo, ACCOUNT);
  assert.deepEqual(result, {
    account: ACCOUNT,
    nodes: 0,
    edges: 0,
    communities: 0,
    metrics: [],
  });

  // Seed a single searchable message WITHOUT ever building a graph; core search
  // (which never imports graphology — D8) must work fully.
  await seed(repo, {
    id: 'solo',
    threadId: 'thread-solo',
    internalDate: 9000,
    from: 'Sender <sender@example.com>',
    to: `Al <${ME}>`,
    subject: 'standalone invoice',
    snippet: 'your invoice is attached',
    direction: 'received',
  });
  const hits = await repo.searchMessages('invoice', { account: ACCOUNT });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gmail_message_id, 'solo');
});

// ---- D10: auto graph build after a full/initial sync only -----------------

/**
 * Fixtures with a multi-recipient sent thread so the metadata sweep produces a
 * co-recipiency edge the auto graph build can act on. `address` is the
 * authenticated mailbox (so the user is excluded from contacts/nodes).
 */
function autoFixtures() {
  return {
    address: ME,
    messages: [
      {
        id: 'sent-1',
        threadId: 't-1',
        internalDate: 1_000,
        dateHeader: null,
        from: `Al <${ME}>`,
        to: `Pat <pat@team.example.com>, Sam <sam@team.example.com>`,
        cc: null,
        subject: 'kickoff',
        labels: ['SENT'],
        snippet: 'kickoff',
        sizeEstimate: 1024,
        bodyText: 'kickoff',
        bodyHtml: null,
        mimeType: 'text/plain',
      },
    ],
  };
}

const AUTO_CONFIG = {
  accounts: { solo: { adapter: 'gws', configDir: '/x' } },
};

test('an initial sync auto-runs the graph build (D10)', async () => {
  const repo = await freshRepo();
  const build = () => new FakeMailSource(autoFixtures());

  // No prior sync → this is the initial sync → graph build should run.
  await runSyncOne(AUTO_CONFIG, 'solo', {}, repo, build);

  // The two co-recipients now carry persisted graph metrics.
  const pat = await repo.getGraphMetrics('solo', 'pat@team.example.com');
  assert.ok(pat, 'contact row exists');
  assert.ok(typeof pat.centrality === 'number' && pat.centrality > 0, 'centrality persisted by auto build');
  assert.ok(typeof pat.community_id === 'number', 'community_id persisted by auto build');
});

test('an incremental (bounded) sync over an already-synced account skips the graph build (D10)', async () => {
  const repo = await freshRepo();
  const build = () => new FakeMailSource(autoFixtures());

  // First sync (initial) builds the graph.
  await runSyncOne(AUTO_CONFIG, 'solo', {}, repo, build);
  // Clear the derived metrics to detect whether the next run rebuilds them.
  repo.driver.exec(`UPDATE contacts SET centrality = NULL, community_id = NULL WHERE account = 'solo'`);

  // A subsequent BOUNDED sweep (a `--since` token, not `--all`) over an already
  // synced account is incremental → must NOT auto-build the graph.
  await runSyncOne(AUTO_CONFIG, 'solo', { since: '30d' }, repo, build);

  const pat = await repo.getGraphMetrics('solo', 'pat@team.example.com');
  assert.ok(pat, 'contact row still exists');
  assert.equal(pat.centrality, null, 'incremental sync must not rebuild the graph');
  assert.equal(pat.community_id, null, 'incremental sync must not rebuild the graph');
});

test('a whole-mailbox (--all) sync auto-runs the graph build even when not initial (D10)', async () => {
  const repo = await freshRepo();
  const build = () => new FakeMailSource(autoFixtures());

  await runSyncOne(AUTO_CONFIG, 'solo', {}, repo, build); // initial
  repo.driver.exec(`UPDATE contacts SET centrality = NULL, community_id = NULL WHERE account = 'solo'`);

  // An explicit whole-mailbox sweep is a FULL sync → rebuild the graph.
  await runSyncOne(AUTO_CONFIG, 'solo', { all: true }, repo, build);

  const pat = await repo.getGraphMetrics('solo', 'pat@team.example.com');
  assert.ok(pat && typeof pat.centrality === 'number' && pat.centrality > 0, 'full sync rebuilds the graph');
});
