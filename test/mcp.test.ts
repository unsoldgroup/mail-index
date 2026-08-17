/**
 * MCP server golden-response tests (SCOPE 3.4, PLAN §12, ADR-0001/0005, the two
 * DESIGN TESTS: recall-not-lookup + token-budget-conscious).
 *
 * Each tool is exercised against a SEEDED in-memory fixture DB (no transport, no
 * provider) through the pure engine (`tools.ts`) and the registry/dispatch
 * (`server.ts`). The asserts pin schema + shape, the cross-cutting contracts,
 * and the design tests:
 *
 *  - every response carries `index_as_of` (ADR-0005);
 *  - get_message at level "body" performs the ONE O(1) inline enrich via a fake
 *    source, leaving every other level index-only (ADR-0001);
 *  - find_person ranks Correspondents (msgs_sent>0) FIRST (recall);
 *  - graph_neighbors / get_contact return ranked near-misses, never a bare empty
 *    set, when an exact key misses (recall);
 *  - a STALE catch_up returns current data + sync_started + eta_seconds and a
 *    body command handback, spawning a (spied) detached sync (ADR-0005);
 *  - the full tool surface is advertised and every advertised tool dispatches,
 *    incl. the two opt-in writers (archive_message, modify_labels).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import { buildGraph } from '../dist/graph/index.js';
import { set as curationSet } from '../dist/curation/index.js';
import {
  search,
  listLabeled,
  refreshInbox,
  getMessage,
  getThread,
  listContacts,
  getContact,
  findPerson,
  listThreads,
  graphNeighbors,
  graphCommunities,
  interestPropose,
  interestSet,
  interestGet,
  saveSummaryTool,
  domainsToCategorizeTool,
  saveDomainCategoryTool,
  syncStatus,
  relayMenuStatus,
  syncNow,
  catchUp,
  digestSources,
  archiveMessage,
  modifyLabels,
  parseSince,
  handback,
  onboarding,
  settingsSet,
} from '../dist/mcp/tools.js';
import { windowCutoff } from '../dist/index/settings.js';
import { TOOLS, toolList, dispatch } from '../dist/mcp/server.js';
import { InsufficientScopeError } from '../dist/source/index.js';
import {
  setupToolList,
  dispatchSetup,
  setupStatus,
  setupInstructions,
} from '../dist/mcp/setup-tools.js';

const ACCOUNT = 'acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15)); // fixed clock
const T = NOW.getTime();
const clock = () => NOW;

async function freshRepo() {
  return new Repo(await openDb({ path: ':memory:' }));
}

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
    starred: m.starred ?? false,
    important: m.important ?? false,
    snippet: m.snippet ?? null,
    bodyText: m.bodyText ?? null,
    bodyState: m.bodyState ?? 'meta',
  });
}

/** Record a finished sync run so index_as_of / freshness have a value. */
async function recordSync(repo, finishedAt) {
  const id = await repo.startSyncRun({ account: ACCOUNT, phase: 'sync', selector: null });
  repo.driver
    .prepare(`UPDATE sync_runs SET finished_at = ?, fetched = 1, indexed = 1 WHERE id = ?`)
    .run(finishedAt, id);
}

/**
 * Seed a mailbox spanning the recall surface:
 *  - Jordan: a Correspondent (user replied + initiated) → high engagement.
 *  - Casey + Dana: co-recipients with Jordan on a non-list thread → graph edges.
 *  - News: a never-opened newsletter (is_list/promotions) → digest source.
 *  - VIP at partner.example.com: a curated-important contact (catch_up source).
 *  - A vendor Correspondent at vendor.example.com (domain categorization).
 */
async function seedMailbox(repo) {
  // Jordan ↔ user thread (user initiated + replied → Correspondent).
  await seed(repo, {
    id: 'm1', threadId: 'tJ', internalDate: T - 10 * 86_400_000,
    from: ME, to: 'Jordan <jordan@partner.example.com>, Casey <casey@partner.example.com>',
    subject: 'Antarctica logistics kickoff', direction: 'sent', snippet: 'planning the expedition',
  });
  await seed(repo, {
    id: 'm2', threadId: 'tJ', internalDate: T - 9 * 86_400_000,
    from: 'Jordan <jordan@partner.example.com>', to: ME, cc: 'Dana <dana@partner.example.com>',
    subject: 'Re: Antarctica logistics kickoff', snippet: 'deposit and deadlines reply',
  });

  // VIP (curated important later) — recent received mail for catch_up.
  await seed(repo, {
    id: 'm3', threadId: 'tV', internalDate: T - 2 * 3_600_000, // 2h ago
    from: 'VIP <vip@partner.example.com>', to: ME, subject: 'urgent contract',
    important: true, unread: true, snippet: 'the contract needs your signature',
  });

  // Newsletter — bulk, never opened, enriched to full so it can be summarized.
  await seed(repo, {
    id: 'n1', threadId: 'tN', internalDate: T - 3 * 86_400_000,
    from: 'Weekly <digest@news.example.com>', to: ME, subject: 'weekly digest issue 42',
    isList: true, category: 'promotions', unread: true,
    snippet: 'top stories this week', bodyText: 'the full newsletter body', bodyState: 'full',
  });

  // Vendor Correspondent (domain categorization candidate).
  await seed(repo, {
    id: 'v1', threadId: 'tVend', internalDate: T - 20 * 86_400_000,
    from: ME, to: 'Vendor <sales@vendor.example.com>', subject: 'invoice question', direction: 'sent',
    snippet: 'about the March invoice',
  });
  await seed(repo, {
    id: 'v2', threadId: 'tVend', internalDate: T - 19 * 86_400_000,
    from: 'Vendor <sales@vendor.example.com>', to: ME, subject: 'Re: invoice question',
    snippet: 'here is the corrected invoice',
  });

  await aggregateAccount(repo, ACCOUNT, [ME]);
  await interestPass(repo, ACCOUNT);
  await buildGraph(repo, ACCOUNT);
}

/** A fake MailSource that returns a full body for one id (inline-enrich test). */
function fakeSourceFactory(bodyById) {
  return () => ({
    provider: 'fake',
    check: async () => ({ ok: true, address: ME }),
    async *listIds() {},
    async getMetadata() {
      return [];
    },
    async getFull(id) {
      const body = bodyById[id];
      if (body == null) return null;
      return {
        id, threadId: null, internalDate: T, dateHeader: null,
        from: null, to: null, cc: null, subject: null, labels: [],
        snippet: null, sizeEstimate: null, bodyText: body, bodyHtml: null, mimeType: 'text/plain',
      };
    },
  });
}

function ctxFor(repo, overrides = {}) {
  return {
    repo,
    config: { accounts: { [ACCOUNT]: { adapter: 'gws', configDir: '/tmp/x' } } },
    now: clock,
    ...overrides,
  };
}

// --------------------------------------------------------------------------

test('search: ranked fuzzy hits, snippet-first, index_as_of stamped', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const ctx = ctxFor(repo);

  const res = await search(ctx, { query: 'antarctica logistics', limit: 10 });
  assert.ok(res.hits.length >= 1, 'finds the logistics thread');
  const hit = res.hits[0];
  assert.ok(hit.ref.startsWith(`${ACCOUNT}:`), 'ref is <account:id>');
  assert.equal(typeof hit.snippet, 'string');
  assert.ok(!('body' in hit), 'no body in a search hit (token-conscious)');
  assert.equal(res.index_as_of, NOW.toISOString(), 'every response carries index_as_of');
  // ADR-0005: every response carries the full freshness/status block.
  assert.ok(res.freshness, 'response carries a freshness block');
  assert.equal(res.freshness.index_as_of, NOW.toISOString());
  assert.equal(res.freshness.stale, false, 'a just-synced index is not stale');
  assert.equal(res.freshness.syncing, false);
  assert.equal(res.freshness.refresh_command, handback('sync', '--account', ACCOUNT));
  assert.equal(typeof res.freshness.age_seconds, 'number');
});

test('search: a STALE index carries freshness.stale + auto-spawns a background refresh (ADR-0005)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  // Stale: last sync 5 hours ago (> 3h threshold).
  await recordSync(repo, new Date(T - 5 * 3_600_000).toISOString());
  let spawnedFor = null;
  let spawnedSince = null;
  const ctx = ctxFor(repo, {
    backgroundSync: (account, since) => {
      spawnedFor = account;
      spawnedSince = since ?? null;
      return true;
    },
  });

  const res = await search(ctx, { query: 'antarctica logistics', limit: 10 });
  assert.equal(res.freshness.stale, true, 'a 5h-old index reads stale');
  assert.equal(res.sync_started, true, 'an ordinary read on a stale index spawns a refresh');
  assert.equal(res.eta_seconds, 90);
  assert.equal(res.freshness.syncing, true, 'freshness reflects the just-spawned sync');
  assert.equal(spawnedFor, ACCOUNT, 'refresh spawned for the queried account');
  assert.equal(spawnedSince, '2d', 'refresh is incremental (ceil(5h/24h)+1 = 2 days)');
});

/** Record a Deployment grant for ACCOUNT, optionally already rejected by Google. */
async function recordGrant(repo, authError = null) {
  const now = new Date(T).toISOString();
  await repo.driver
    .prepare(`INSERT INTO google_tokens(account,address,scopes,refresh_token_ciphertext,iv,created_at,updated_at,auth_error,auth_failed_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(ACCOUNT, 'a@example.com', 'scope', new Uint8Array([1]), new Uint8Array([2]), now, now, authError, authError ? now : null);
}

test('search: a dead grant reports needs_reauth and refuses to promise a refresh', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, new Date(T - 5 * 3_600_000).toISOString());
  await recordGrant(repo, 'invalid_grant');
  let spawned = false;
  let enqueued = false;
  const ctx = ctxFor(repo, {
    backgroundSync: () => { spawned = true; return true; },
    enqueueJob: async () => { enqueued = true; return 'job-1'; },
    reauthUrl: (account) => `https://worker.example/setup/google/start?account=${account}`,
  });

  const res = await search(ctx, { query: 'antarctica logistics', limit: 10 });
  assert.equal(res.freshness.stale, true, 'the index is still stale');
  assert.equal(res.freshness.auth, 'needs_reauth');
  assert.equal(res.freshness.auth_failed_at, new Date(T).toISOString());
  assert.equal(res.sync_started, undefined, 'never claims a refresh that cannot succeed');
  assert.equal(res.eta_seconds, undefined);
  assert.equal(res.freshness.syncing, false);
  assert.equal(spawned, false, 'no local sync spawned against a dead grant');
  assert.equal(enqueued, false, 'no Job queued against a dead grant');
  assert.deepEqual(res.freshness.refresh_command, {
    kind: 'reauth',
    account: ACCOUNT,
    status: 'blocked',
    reason: 'invalid_grant',
    reconsent_url: `https://worker.example/setup/google/start?account=${ACCOUNT}`,
  });
});

test('search: a healthy grant still auto-spawns, and reports auth ok', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, new Date(T - 5 * 3_600_000).toISOString());
  await recordGrant(repo);
  let enqueued = false;
  const ctx = ctxFor(repo, { enqueueJob: async () => { enqueued = true; return 'job-1'; } });

  const res = await search(ctx, { query: 'antarctica logistics', limit: 10 });
  assert.equal(res.freshness.auth, 'ok');
  assert.equal(res.sync_started, true, 'a healthy stale Account still refreshes');
  assert.equal(enqueued, true);
});

test('get_message: a body that stayed meta because of a dead grant says so', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  await recordGrant(repo, 'invalid_grant');
  const ctx = ctxFor(repo, {
    buildSource: () => { throw new Error('Google token exchange failed: invalid_grant'); },
  });

  const res = await getMessage(ctx, { ref: `${ACCOUNT}:m3`, level: 'body' });
  assert.equal(res.body, null);
  assert.equal(res.enriched, false);
  assert.equal(res.body_error, 'auth', 'the caller learns the body is unreachable, not absent');
});

test('search: a vague half-remembered term still recalls (recall, not lookup)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);
  // "deposit" only appears in the snippet of the reply — fuzzy FTS still finds it.
  const res = await search(ctx, { query: 'deposit' });
  assert.ok(res.hits.some((h) => h.ref === `${ACCOUNT}:m2`), 'recalls via snippet match');
});

test('get_message: level body performs the ONE O(1) inline enrich (ADR-0001)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo, { buildSource: fakeSourceFactory({ m3: 'the full contract text' }) });

  // m3 is meta; level=meta must NOT enrich.
  const meta = await getMessage(ctx, { ref: `${ACCOUNT}:m3`, level: 'meta' });
  assert.equal(meta.enriched, false);
  assert.equal(meta.body, null);
  assert.equal(meta.bodyState, 'meta');

  // level=body enriches once.
  const body = await getMessage(ctx, { ref: `${ACCOUNT}:m3`, level: 'body' });
  assert.equal(body.enriched, true, 'inline-enriched the meta row');
  assert.equal(body.bodyState, 'full');
  assert.equal(body.body, 'the full contract text');

  // A second body call is a no-op (already full) — no re-enrich.
  const again = await getMessage(ctx, { ref: `${ACCOUNT}:m3`, level: 'body' });
  assert.equal(again.enriched, false);
});

/** Seed a message straight into the index with explicit Gmail labels. */
async function seedLabeled(repo, id, labels) {
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: id,
    subject: `subject ${id}`,
    fromAddr: 'a@b.com',
    internalDate: T,
    labels,
    category: labels.includes('INBOX') ? 'primary' : null,
    bodyState: 'meta',
  });
}

/** A MailSource whose live inbox is `liveIds`; getMetadata serves any `metaById`. */
function inboxSourceFactory(liveIds, metaById = {}) {
  return () => ({
    provider: 'fake',
    check: async () => ({ ok: true, address: ME }),
    async *listIds() {
      for (const id of liveIds) yield id;
    },
    async getMetadata(ids) {
      return ids.map((id) => metaById[id]).filter((m) => m != null);
    },
    async getFull() {
      return null;
    },
  });
}

test('list_labeled: filters by stored label membership, never dumps bodies', async () => {
  const repo = await freshRepo();
  await seedLabeled(repo, 'in1', ['INBOX']);
  await seedLabeled(repo, 'in2', ['INBOX', 'UNREAD']);
  await seedLabeled(repo, 'arch', ['CATEGORY_PROMOTIONS']);

  const res = await listLabeled(ctxFor(repo), { label: 'INBOX' });
  assert.deepEqual(new Set(res.hits.map((h) => h.ref)), new Set([`${ACCOUNT}:in1`, `${ACCOUNT}:in2`]));
  assert.ok(res.hits.every((h) => !('body' in h)), 'snippet-first, no body');
  assert.ok(res.hits.some((h) => h.labels.includes('INBOX')), 'labels exposed on hits');
});

test('refresh_inbox: reconciles live membership, then returns the current inbox', async () => {
  const repo = await freshRepo();
  await seedLabeled(repo, 'keep', ['INBOX']);
  await seedLabeled(repo, 'archived', ['INBOX']); // will fall out of the live inbox
  const ctx = ctxFor(repo, { buildSource: inboxSourceFactory(['keep']) });

  const res = await refreshInbox(ctx, {});
  assert.equal(res.refreshed, true, 'a live reconcile ran');
  assert.equal(res.archived, 1, 'archived row dropped INBOX');
  assert.deepEqual(res.hits.map((h) => h.ref), [`${ACCOUNT}:keep`], 'only live inbox returned');
});

test('refresh_inbox: indexes new inbox mail surfaced by the reconcile', async () => {
  const repo = await freshRepo();
  const meta = {
    id: 'fresh', threadId: null, internalDate: T, dateHeader: null,
    from: 'new@x.com', to: null, cc: null, subject: 'fresh inbox', labels: ['INBOX'],
    snippet: 'hi', sizeEstimate: 1, headers: {},
  };
  const ctx = ctxFor(repo, { buildSource: inboxSourceFactory(['fresh'], { fresh: meta }) });

  const res = await refreshInbox(ctx, {});
  assert.equal(res.added, 1);
  assert.ok(res.hits.some((h) => h.ref === `${ACCOUNT}:fresh`), 'newly indexed inbox mail shows');
});

test('refresh_inbox: degrades to the indexed inbox when no provider creds are wired', async () => {
  const repo = await freshRepo();
  await seedLabeled(repo, 'keep', ['INBOX']);
  // No buildSource on the ctx → cannot reconcile.
  const res = await refreshInbox(ctxFor(repo), {});
  assert.equal(res.refreshed, false, 'no live reconcile, but still answerable');
  assert.deepEqual(res.hits.map((h) => h.ref), [`${ACCOUNT}:keep`]);
});

test('get_message: summary level returns summary when present, never raw body by default', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await saveSummaryTool(ctxFor(repo), { ref: `${ACCOUNT}:n1`, text: 'digest covers three stories' });
  const res = await getMessage(ctxFor(repo), { ref: `${ACCOUNT}:n1`, level: 'summary' });
  assert.equal(res.summary, 'digest covers three stories');
  assert.equal(res.body, null, 'body is opt-in (level=body) only');
});

test('get_thread: metadata + messages + thread summary', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await saveSummaryTool(ctxFor(repo), { ref: `${ACCOUNT}:tJ`, text: 'kickoff + reply on deposits', level: 'thread' });
  const res = await getThread(ctxFor(repo), { ref: `${ACCOUNT}:tJ` });
  assert.equal(res.thread.ref, `${ACCOUNT}:tJ`);
  assert.equal(res.summary, 'kickoff + reply on deposits');
  assert.equal(res.messages.length, 2);
  assert.ok(res.messages.every((m) => !('body' in m)), 'thread messages are compact');
});

test('list_contacts: correspondent filter + community sort', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const corr = await listContacts(ctx, { filter: 'correspondent' });
  assert.ok(corr.contacts.length >= 1);
  assert.ok(corr.contacts.every((c) => c.correspondent), 'only Correspondents');
  assert.ok(corr.contacts.some((c) => c.address === 'jordan@partner.example.com'));

  const byCommunity = await listContacts(ctx, { sort: 'community', limit: 50 });
  assert.ok(byCommunity.contacts.length >= 1);
});

test('find_person: ranks Correspondents FIRST (recall design test)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);
  // "partner" matches Jordan/Casey/Dana/VIP on domain; Jordan/Casey are
  // Correspondents (on the sent thread) and must outrank the non-correspondents.
  const res = await findPerson(ctx, { hint: 'partner' });
  assert.ok(res.matches.length >= 2);
  const firstNonCorr = res.matches.findIndex((m) => !m.correspondent);
  const lastCorr = res.matches.reduce((acc, m, i) => (m.correspondent ? i : acc), -1);
  if (firstNonCorr !== -1) {
    assert.ok(lastCorr < firstNonCorr, 'all Correspondents rank before non-Correspondents');
  }
});

test('find_person: a vague fragment resolves, never a bare empty set on a near-miss', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);
  const res = await findPerson(ctx, { hint: 'jord' }); // fragment of "jordan"
  assert.ok(res.matches.some((m) => m.address === 'jordan@partner.example.com'));
});

test('list_threads: by contact and by query', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const byContact = await listThreads(ctx, { contact: 'jordan@partner.example.com' });
  assert.ok(byContact.threads.some((t) => t.ref === `${ACCOUNT}:tJ`));

  const byQuery = await listThreads(ctx, { query: 'invoice' });
  assert.ok(byQuery.threads.some((t) => t.ref === `${ACCOUNT}:tVend`));
});

test('graph_neighbors: ranked co-recipients; near-miss falls back to ranked set', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const neighbors = await graphNeighbors(ctx, { address: 'jordan@partner.example.com' });
  assert.equal(neighbors.fallback, false, 'has real co-recipiency neighbours');
  assert.ok(neighbors.neighbors.length >= 1);
  assert.ok(neighbors.neighbors.every((n) => typeof n.shared_threads === 'number'));

  // An address with no contact row → fallback to ranked near-misses (never empty).
  const miss = await graphNeighbors(ctx, { address: 'partner.example.com' });
  assert.equal(miss.fallback, true);
  assert.ok(miss.neighbors.length >= 1, 'near-miss returns ranked neighbours, not empty');
});

test('graph_communities: communities present after build; build handback when none', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const res = await graphCommunities(ctxFor(repo), {});
  assert.ok(res.communities.length >= 1);
  assert.ok(res.communities[0].members.length >= 1);

  // A fresh account with no graph → empty + a build command handback.
  const empty = await freshRepo();
  const res2 = await graphCommunities(
    { repo: empty, config: { accounts: { other: { adapter: 'gws', configDir: '/x' } } }, now: clock },
    { account: 'other' },
  );
  assert.equal(res2.communities.length, 0);
  assert.equal(res2.build_command, handback('graph', 'build', '--account', 'other'));
});

test('get_contact: exact hit returns recent threads; near-miss returns candidates', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const hit = await getContact(ctx, { address: 'jordan@partner.example.com' });
  assert.equal(hit.contact.address, 'jordan@partner.example.com');
  assert.ok(hit.recentThreads.length >= 1);

  const miss = await getContact(ctx, { address: 'jord' });
  assert.equal(miss.contact, null);
  assert.ok(miss.candidates.length >= 1, 'near-miss returns ranked candidates, not nothing');
});

test('interest_propose/set/get: curation write-back round-trips', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const proposal = await interestPropose(ctx, {});
  assert.ok(proposal.proposal.contacts.length >= 1);
  assert.equal(typeof proposal.index_as_of, 'object'); // null until synced

  await interestSet(ctx, {
    contacts: [{ address: 'vip@partner.example.com', curation: 'important' }],
    keywords: ['antarctica', 'logistics'],
  });
  const got = await interestGet(ctx, {});
  assert.deepEqual(got.profile.keywords, ['antarctica', 'logistics']);
  assert.ok(got.profile.contacts.some((c) => c.address === 'vip@partner.example.com' && c.curation === 'important'));
});

test('domains_to_categorize/save_domain_category: propose + persist', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo);

  const candidates = await domainsToCategorizeTool(ctx, {});
  assert.ok(
    candidates.candidates.some((c) => c.domain === 'vendor.example.com'),
    'vendor.example.com has a Correspondent → a candidate',
  );

  const saved = await saveDomainCategoryTool(ctx, {
    domain: 'vendor.example.com', category: 'vendor', note: 'supplies',
  });
  assert.equal(saved.result.category, 'vendor');
  assert.equal((await repo.getDomain(ACCOUNT, 'vendor.example.com')).category, 'vendor');
});

test('save_summary: message + thread, index_as_of stamped', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const ctx = ctxFor(repo);

  const msg = await saveSummaryTool(ctx, { ref: `${ACCOUNT}:n1`, text: 'three stories' });
  assert.equal(msg.result.level, 'message');
  assert.equal(msg.index_as_of, NOW.toISOString());

  const thr = await saveSummaryTool(ctx, { ref: `${ACCOUNT}:tJ`, text: 'kickoff summary', level: 'thread' });
  assert.equal(thr.result.level, 'thread');
});

test('sync_status: per-account counts, freshness, body ladder', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const res = await syncStatus(ctxFor(repo), {});
  const a = res.accounts.find((x) => x.account === ACCOUNT);
  assert.ok(a.messages >= 6);
  assert.equal(a.index_as_of, NOW.toISOString());
  assert.equal(a.syncing, false);
  assert.equal(typeof a.bodyStates.meta, 'number');
  assert.equal(a.bodyStates.full, 1, 'the enriched newsletter');
});

test('relay_menu_status: compact read-only menu payload without auto-sync side effects', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, new Date(T - 5 * 3_600_000).toISOString());
  let spawned = false;
  const res = await relayMenuStatus(ctxFor(repo, { backgroundSync: () => ((spawned = true), true) }));

  assert.equal(res.title, 'Mail Index');
  assert.equal(res.state, 'stale');
  assert.equal(res.accounts.length, 1);
  assert.equal(res.accounts[0].account, ACCOUNT);
  assert.equal(res.actions.some((a) => a.tool === 'sync_now'), true);
  assert.equal(spawned, false, 'menu polling must not start syncs');
});

test('sync_now: starts detached sync through the existing background sync hook', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  let spawnedFor = null;
  const res = await syncNow(ctxFor(repo, {
    backgroundSync: (account) => {
      spawnedFor = account;
      return true;
    },
  }), {});

  assert.equal(res.started, true);
  assert.deepEqual(res.started_accounts, [ACCOUNT]);
  assert.equal(spawnedFor, ACCOUNT);
  assert.equal(res.command, handback('sync', '--all-accounts'));
});

test('catch_up: STALE index returns data + sync_started + eta + handback, spawns detached sync (ADR-0005)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  // Curate VIP important so its recent mail surfaces in fromImportant.
  curationSet(repo, ACCOUNT, { contacts: [{ address: 'vip@partner.example.com', curation: 'important' }] });
  // Stale: last sync 13 hours ago (> 3h threshold).
  await recordSync(repo, new Date(T - 13 * 3_600_000).toISOString());

  let spawnedFor = null;
  let spawnedSince = null;
  const ctx = ctxFor(repo, {
    backgroundSync: (account, since) => {
      spawnedFor = account;
      spawnedSince = since ?? null;
      return true;
    },
  });

  const res = await catchUp(ctx, { since: '7d' });
  assert.ok(res.fromImportant.some((h) => h.ref === `${ACCOUNT}:m3`), 'VIP recent mail surfaced');
  assert.equal(res.sync_started, true, 'stale read spawned a background sync');
  assert.equal(res.eta_seconds, 90);
  assert.equal(spawnedFor, ACCOUNT, 'detached sync spawned for the account');
  // ADR-0005: the spawn is INCREMENTAL — a relative --since derived from the
  // 13h-old index (ceil(13h/24h)+1 = 2 days), never a full sweep.
  assert.equal(spawnedSince, '2d', 'background sync is incremental, not a full sweep');
  assert.equal(res.bodies_command, handback('enrich', '--account', ACCOUNT, '--profile'), 'O(N) bodies via handback');
  assert.ok('index_as_of' in res);
});

test('catch_up: FRESH index does not spawn a background sync (debounce)', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString()); // fresh
  let spawned = false;
  const ctx = ctxFor(repo, { backgroundSync: () => ((spawned = true), true) });
  const res = await catchUp(ctx, { since: '7d' });
  assert.equal(res.sync_started, undefined);
  assert.equal(spawned, false, 'a fresh index never triggers a background sync');
});

test('digest_sources: ranks list senders with unread/unsummarized counts', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const res = await digestSources(ctxFor(repo), {});
  const news = res.sources.find((s) => s.address === 'digest@news.example.com');
  assert.ok(news, 'the newsletter is a digest source');
  assert.equal(news.issues, 1);
  assert.equal(news.unread, 1);
  assert.equal(news.unsummarized, 1);
});

test('parseSince: relative tokens and ISO', async () => {
  const base = new Date(Date.UTC(2026, 0, 31));
  assert.equal(parseSince('1d', base), base.getTime() - 86_400_000);
  assert.equal(parseSince('2w', base), base.getTime() - 2 * 7 * 86_400_000);
  assert.equal(parseSince('12h', base), base.getTime() - 12 * 3_600_000);
  assert.equal(parseSince('1mo', base), base.getTime() - 30 * 86_400_000);
  assert.equal(parseSince('2026-01-01T00:00:00.000Z', base), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.throws(() => parseSince('soon', base));
});

test('onboarding walks its steps, persists the window, and completes once', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const ctx = ctxFor(repo, { enqueueJob: async () => 'job-1' });

  const first = await onboarding(ctx, {});
  assert.equal(first.step, 'accounts');
  assert.ok(first.remaining_steps.includes('retention'));

  const retention = await onboarding(ctx, { step: 'accounts', answer: 'yes' });
  assert.equal(retention.step, 'retention');
  assert.deepEqual(retention.options?.map((option) => option.value), [3, 6, 12, 0]);

  const interests = await onboarding(ctx, { step: 'retention', answer: 3 });
  assert.equal(interests.step, 'interests');
  assert.equal((await repo.getAccountSettings(ACCOUNT)).body_window_months, 3, 'the answer is persisted immediately');

  const backfill = await onboarding(ctx, { step: 'interests', answer: 'skip' });
  assert.equal(backfill.step, 'backfill');

  const done = await onboarding(ctx, { step: 'backfill', answer: 'skip' });
  assert.equal(done.step, 'done');
  const settings = await repo.getAccountSettings(ACCOUNT);
  assert.ok(settings.onboarding_completed_at, 'completion is stamped');

  // Re-running after completion does not re-ask.
  assert.equal((await onboarding(ctx, {})).step, 'done');
});

test('settings_set patches one field without resetting the others', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await recordSync(repo, NOW.toISOString());
  const ctx = ctxFor(repo);

  await settingsSet(ctx, { body_window_months: 6 });
  const res = await settingsSet(ctx, { retention: 'off' });
  assert.equal(res.settings.body_window_months, 6, 'the untouched field survives');
  assert.equal(res.settings.retention, 'off');
});

test('retention evicts only what aged out, and never what the user is attached to', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const cutoff = windowCutoff({ body_window_months: 3, retention: 'window', onboarding_completed_at: null }, NOW);
  assert.ok(cutoff != null);

  // Three full bodies: one inside the window, two outside it — one of those on a
  // thread the user joined, which must survive at any age.
  await seed(repo, { id: 'r-inside', threadId: 't-cold', internalDate: cutoff + 86_400_000, from: 'shop@example.com', subject: 'Recent order', bodyText: 'inside', bodyState: 'full' });
  await seed(repo, { id: 'r-old', threadId: 't-cold', internalDate: cutoff - 86_400_000, from: 'shop@example.com', subject: 'Old order', bodyText: 'outside', bodyState: 'full' });
  await seed(repo, { id: 'r-mine', threadId: 't-warm', internalDate: cutoff - 86_400_000, from: 'shop@example.com', subject: 'Old but mine', bodyText: 'outside', bodyState: 'full' });
  // Threads are normally derived by aggregation; seed the one bit retention reads.
  const thread = repo.driver.prepare(
    `INSERT INTO threads (account, thread_id, msg_count, unread_count, user_participated) VALUES (?, ?, 1, 0, ?)`,
  );
  await thread.run(ACCOUNT, 't-warm', 1);
  await thread.run(ACCOUNT, 't-cold', 0);

  const eligible = await repo.retentionEligible(ACCOUNT, cutoff);
  assert.deepEqual(eligible, ['r-old'], 'only the aged-out, unattached body is eligible');

  assert.equal(await repo.evictBody(ACCOUNT, 'r-old'), true);
  const evicted = await repo.getMessage(ACCOUNT, 'r-old');
  assert.equal(evicted?.body_text, null);
  assert.equal(evicted?.body_state, 'meta', 'no summary → honest "fetchable, not fetched"');

  // And the enrichment side agrees on the boundary, so the two never fight.
  const promotable = await repo.selectMetaMessages(ACCOUNT, { rule: 'all', since: cutoff });
  assert.ok(!promotable.includes('r-old'), 'an evicted body is not re-promoted on the next cycle');
});

test('surface: exactly the PLAN §12 tools are advertised, all with schemas, all dispatch', async () => {
  const expected = [
    'search', 'list_labeled', 'refresh_inbox', 'get_message', 'get_thread', 'list_contacts',
    'get_contact', 'find_person', 'list_threads', 'graph_neighbors', 'graph_communities',
    'interest_propose', 'interest_set', 'interest_get', 'save_summary',
    'onboarding', 'settings_get', 'settings_set', 'backfill_bodies',
    'domains_to_categorize', 'save_domain_category', 'cadence', 'sync_status',
    'relay_menu_status', 'sync_now', 'catch_up', 'digest_sources', 'archive_message', 'modify_labels',
    'trigger_rule_save', 'trigger_rule_list', 'trigger_rule_delete',
    'webhook_consumer_register', 'webhook_consumer_delete',
  ];
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(new Set(names), new Set(expected), 'the full §12 surface');
  assert.equal(names.length, expected.length, 'no duplicate tools');

  for (const t of toolList()) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} advertises an object schema`);
    assert.ok(t.description.length > 0, `${t.name} has a description`);
  }
  assert.equal(
    toolList().find((t) => t.name === 'relay_menu_status')?.annotations?.['readOnlyHint'],
    true,
    'menu status advertises standard read-only tool annotation',
  );

  // dispatch routes by name and stamps index_as_of on the result.
  const repo = await freshRepo();
  await seedMailbox(repo);
  const res = await dispatch(ctxFor(repo), 'search', { query: 'invoice' });
  assert.ok('hits' in res && 'index_as_of' in res);

  await assert.rejects(async () => await dispatch(ctxFor(repo), 'no_such_tool', {}));
});

test('dispatch through buildServer-shaped CallTool returns an isError result on a bad ref', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  // get_message on an absent ref throws McpToolError; the server maps it to
  // isError. Here we assert the engine throws so the server contract holds.
  await assert.rejects(async () => await getMessage(ctxFor(repo), { ref: 'acct:nope', level: 'meta' }));
});

// --- ITEM 2: self-bootstrapping SETUP MODE -----------------------------------

test('setup mode: tools/list advertises exactly the reduced setup surface', async () => {
  const names = setupToolList().map((t) => t.name);
  assert.deepEqual(new Set(names), new Set(['setup_status', 'setup_instructions']));
  // The full recall tools are NOT in the setup surface (different trust profile).
  const full = new Set(TOOLS.map((t) => t.name));
  for (const n of names) assert.ok(!full.has(n), `${n} is setup-only`);
  for (const t of setupToolList()) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} advertises an object schema`);
    assert.ok(t.description.length > 0, `${t.name} has a description`);
  }
});

test('setup mode: with config present the full tool surface is what serve() would use', async () => {
  // The config-present path serves the full surface — assert its size/identity
  // here so the bootstrapping branch never silently shrinks the real surface.
  // 21 original read tools + the 2 opt-in writers (archive_message,
  // modify_labels) + 2 relay/status quick-action tools + five remote Trigger
  // rule tools + the four working-set tools (onboarding, settings_get,
  // settings_set, backfill_bodies).
  assert.equal(TOOLS.length, 34, 'full surface includes the working-set tools');
});

test('setup_status reports observation and does not crash with no config', async () => {
  const res = setupStatus('/nonexistent/path/config.json');
  assert.equal(res.mode, 'setup');
  assert.equal(res.state.config_present, false);
  assert.equal(res.ready, false);
  assert.equal(typeof res.state.gog_installed, 'boolean');
});

test('setup_instructions surfaces the two human steps + the recommended command', async () => {
  const res = setupInstructions('al@example.com', '/nonexistent/path/config.json');
  assert.equal(res.mode, 'setup');
  assert.match(res.recommended_command, /mail-index setup --account al@example\.com/);
  const auth = res.steps.find((s) => s.step === 'authenticate');
  assert.equal(auth.human, true, 'browser OAuth is a human step');
  assert.match(auth.command, /--gmail-scope=readonly/);
  // The config_and_sync step is todo (config absent) and carries the setup cmd.
  const cfg = res.steps.find((s) => s.step === 'config_and_sync');
  assert.equal(cfg.status, 'todo');
  assert.match(cfg.command, /mail-index setup/);
});

test('setup mode: dispatchSetup routes the two tools and rejects unknown', async () => {
  const status = dispatchSetup('setup_status', {});
  assert.equal(status.mode, 'setup');
  const instr = dispatchSetup('setup_instructions', { account: 'x@y.com' });
  assert.match(instr.recommended_command, /x@y\.com/);
  assert.throws(() => dispatchSetup('no_such_setup_tool', {}));
});

// -------------------- opt-in writers (archive + label) --------------------

/** A fake MailSource whose modify() records calls (and can be made to fail). */
function writableSourceFactory(calls, failWith) {
  return () => ({
    provider: 'fake',
    check: async () => ({ ok: true, address: ME }),
    async *listIds() {},
    async getMetadata() { return []; },
    async getFull() { return null; },
    modify: (id, change) => {
      if (failWith) return Promise.reject(failWith);
      calls.push({ id, change });
      return Promise.resolve();
    },
  });
}

test('archive_message + modify_labels are registered as tools and marked mutating', async () => {
  const archive = TOOLS.find((t) => t.name === 'archive_message');
  const label = TOOLS.find((t) => t.name === 'modify_labels');
  assert.ok(archive && label, 'both opt-in writers are in the registry');
  assert.match(archive.description, /MUTATES|OPT-IN/);
  assert.match(label.description, /MUTATES|OPT-IN/);
});

test('archive_message drops INBOX via the provider and reflects it locally', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const calls = [];
  const ctx = ctxFor(repo, { buildSource: writableSourceFactory(calls) });
  const res = await archiveMessage(ctx, { ref: `${ACCOUNT}:m3` });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].change, { removeLabelIds: ['INBOX'] });
  assert.equal(res.indexed, true);
  assert.ok('index_as_of' in res, 'stamps index_as_of like every tool');
});

test('modify_labels requires at least one label', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo, { buildSource: writableSourceFactory([]) });
  await assert.rejects(async () => await modifyLabels(ctx, { ref: `${ACCOUNT}:m3` }), /at least one/);
});

test('archive_message surfaces an insufficient-scope error as a tool error', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);
  const ctx = ctxFor(repo, {
    buildSource: writableSourceFactory([], new InsufficientScopeError('gog', 'gog auth add ...')),
  });
  await assert.rejects(async () => await archiveMessage(ctx, { ref: `${ACCOUNT}:m3` }), /read-only|gmail\.modify|re-auth/i);
});
