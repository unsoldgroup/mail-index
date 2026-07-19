/**
 * Write-back loop tests (SCOPE 3.5, ADR-0003/0004, CONTEXT.md "Write-back loop"
 * / "Demotion" / "Entity category").
 *
 * The index PROPOSES, the agent's LLM JUDGES, a write-back tool PERSISTS with
 * model provenance — the tool ships no intelligence (ADR-0002/0004). The tests
 * seed a tmp DB, aggregate it, then assert the engine over a seeded index:
 *
 *  - saveSummary persists a message/thread summary, provenance-marked,
 *    FTS-searchable, NEVER overwriting source fields;
 *  - compact demotes ONLY eligible bodies (summarized + bulk + past grace) and
 *    spares curated-important senders, user-participated threads, and direct
 *    human mail; --now collapses the grace window;
 *  - domainsToCategorize returns Correspondent-bearing candidates + context;
 *    saveDomainCategory persists onto domains.category (open vocabulary).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import {
  saveSummary,
  compact,
  domainsToCategorize,
  saveDomainCategory,
  DEFAULT_GRACE_MS,
} from '../dist/writeback/index.js';
import { set as curationSet } from '../dist/curation/index.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15));

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
    subject: m.subject ?? null,
    direction: m.direction ?? 'received',
    isList: m.isList ?? false,
    category: m.category ?? null,
    unread: m.unread ?? false,
    snippet: m.snippet ?? null,
    bodyText: m.bodyText ?? null,
    bodyState: m.bodyState ?? 'meta',
  });
}

const T0 = NOW.getTime();

/**
 * Seed:
 *  - a newsletter issue (is_list, enriched to full) — the demotion target;
 *  - a curated-important sender's bulk mail (full) — must be SPARED;
 *  - a user-participated thread message (full, is_list) — must be SPARED;
 *  - a direct human mail (full, not list) — must be SPARED (not bulk);
 *  - a Correspondent at vendor.example.com for the categorization loop.
 */
async function seedMailbox(repo) {
  // Newsletter — bulk, enriched.
  await seed(repo, {
    id: 'news1', threadId: 't-news', internalDate: T0 - 5000,
    from: 'Digest <digest@news.example.com>', to: ME, subject: 'weekly digest',
    isList: true, category: 'promotions', bodyState: 'full',
    snippet: 'newsletter snippet', bodyText: 'the full newsletter body verbatim',
  });

  // Curated-important sender, bulk mail (must be spared even when summarized).
  await seed(repo, {
    id: 'vip1', threadId: 't-vip', internalDate: T0 - 4000,
    from: 'VIP <vip@important.example.com>', to: ME, subject: 'promo from vip',
    isList: true, category: 'promotions', bodyState: 'full',
    snippet: 'vip snippet', bodyText: 'vip body',
  });

  // User-participated thread: bulk-classified but user replied → spared.
  await seed(repo, {
    id: 'part1', threadId: 't-part', internalDate: T0 - 3500,
    from: 'List <list@forum.example.com>', to: ME, subject: 'thread topic',
    isList: true, category: 'forums', bodyState: 'full',
    snippet: 'part snippet', bodyText: 'forum body',
  });
  await seed(repo, {
    id: 'part2', threadId: 't-part', internalDate: T0 - 3400,
    from: ME, to: 'list@forum.example.com', subject: 're: thread topic',
    direction: 'sent', bodyState: 'meta',
  });

  // Direct human mail, not bulk (must be spared by the bulk-only rule).
  await seed(repo, {
    id: 'direct1', threadId: 't-direct', internalDate: T0 - 3000,
    from: 'Pat <pat@human.example.com>', to: ME, subject: 'lunch?',
    bodyState: 'full', snippet: 'lunch snippet', bodyText: 'are you free for lunch',
  });

  // Correspondent at vendor — user has written to them (for categorization).
  await seed(repo, {
    id: 'v1', threadId: 't-v', internalDate: T0 - 2000,
    from: 'Casey <casey@vendor.example.com>', to: ME, subject: 'invoice 42',
  });
  await seed(repo, {
    id: 'v2', threadId: 't-v', internalDate: T0 - 1900,
    from: ME, to: 'casey@vendor.example.com', subject: 're: invoice 42',
    direction: 'sent',
  });
}

async function aggregated() {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  return repo;
}

const iso = (ms) => new Date(ms).toISOString();

// ---- saveSummary (message) ------------------------------------------------

test('saveSummary persists a message summary, FTS-searchable, source preserved', async () => {
  const repo = await aggregated();
  const at = iso(T0 - 5000);
  const result = await saveSummary(repo, ACCOUNT, 'message', 'news1', 'A weekly roundup of Antarctic logistics.', { at });

  assert.equal(result.level, 'message');
  assert.equal(result.ref, 'news1');
  assert.equal(result.summarizedAt, at);

  const row = await repo.getMessage(ACCOUNT, 'news1');
  // Summary persisted, provenance marked (model by default), eligibility stamped.
  assert.equal(row.summary_text, 'A weekly roundup of Antarctic logistics.');
  assert.equal(row.summary_is_model, 1);
  assert.equal(row.summarized_at, at);
  // Source fields untouched (ADR-0003: never overwrites source).
  assert.equal(row.subject, 'weekly digest');
  assert.equal(row.body_text, 'the full newsletter body verbatim');
  assert.equal(row.body_state, 'full');

  // The summary improves recall: a term ONLY in the summary now matches.
  const hits = await repo.searchMessages('Antarctic', { account: ACCOUNT });
  assert.ok(hits.some((h) => h.gmail_message_id === 'news1'), 'summary term is FTS-searchable');
  // The original body is still searchable too (summary is additive on a full row).
  const bodyHits = await repo.searchMessages('verbatim', { account: ACCOUNT });
  assert.ok(bodyHits.some((h) => h.gmail_message_id === 'news1'));
});

test('saveSummary rejects empty text and an unknown message', async () => {
  const repo = await aggregated();
  await assert.rejects(async () => await saveSummary(repo, ACCOUNT, 'message', 'news1', '   '), /non-empty/);
  await assert.rejects(async () => await saveSummary(repo, ACCOUNT, 'message', 'nope', 'x'), /unknown message/);
});

test('saveSummary can mark provenance as not-model', async () => {
  const repo = await aggregated();
  await saveSummary(repo, ACCOUNT, 'message', 'news1', 'hand-written', { isModel: false, at: iso(T0) });
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).summary_is_model, 0);
});

// ---- saveSummary (thread) -------------------------------------------------

test('saveSummary persists a thread summary; survives re-aggregation', async () => {
  const repo = await aggregated();
  const at = iso(T0 - 1000);
  const result = await saveSummary(repo, ACCOUNT, 'thread', 't-v', 'Invoice 42 discussion with Casey.', { at });
  assert.equal(result.level, 'thread');

  const thread = await repo.getThread(ACCOUNT, 't-v');
  assert.equal(thread.summary_text, 'Invoice 42 discussion with Casey.');
  assert.equal(thread.summary_is_model, 1);
  assert.equal(thread.summarized_at, at);
  // Source fields preserved (the aggregated thread subject is untouched by the
  // summary write — it lands in its own column).
  const subjectBefore = thread.subject;
  assert.equal(thread.msg_count, 2);

  // Re-aggregating must NOT wipe the thread summary (UPSERT, not clean replace),
  // and leaves the source subject as the aggregation computes it.
  await aggregateAccount(repo, ACCOUNT, [ME]);
  const after = await repo.getThread(ACCOUNT, 't-v');
  assert.equal(after.summary_text, 'Invoice 42 discussion with Casey.');
  assert.equal(after.subject, subjectBefore);
});

test('saveSummary rejects an unknown thread', async () => {
  const repo = await aggregated();
  await assert.rejects(async () => await saveSummary(repo, ACCOUNT, 'thread', 'no-thread', 'x'), /unknown thread/);
});

// ---- compact / demotion ---------------------------------------------------

test('compact demotes only eligible bodies past the grace window', async () => {
  const repo = await aggregated();
  // Summarize four full bodies, all stamped 10 days ago (past the 7-day grace).
  const old = iso(T0 - 10 * 24 * 60 * 60 * 1000);
  for (const id of ['news1', 'vip1', 'part1', 'direct1']) {
    await saveSummary(repo, ACCOUNT, 'message', id, `summary of ${id}`, { at: old });
  }
  // Curate the VIP domain important — its bulk mail must be spared.
  await curationSet(repo, ACCOUNT, { domains: [{ domain: 'important.example.com', curation: 'important' }] });

  const result = await compact(repo, ACCOUNT, { asOf: NOW });

  // Only the plain newsletter demotes. VIP (curated-important domain),
  // part1 (user-participated thread), and direct1 (not bulk) are spared.
  assert.equal(result.demoted, 1);
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'summary-only');
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_text, null, 'distilled body dropped');
  assert.equal((await repo.getMessage(ACCOUNT, 'vip1')).body_state, 'full', 'curated-important spared');
  assert.equal((await repo.getMessage(ACCOUNT, 'part1')).body_state, 'full', 'user-participated thread spared');
  assert.equal((await repo.getMessage(ACCOUNT, 'direct1')).body_state, 'full', 'non-bulk human mail spared');

  // After demotion the summary still feeds FTS; the dropped body does not.
  const summHits = await repo.searchMessages('summary', { account: ACCOUNT });
  assert.ok(summHits.some((h) => h.gmail_message_id === 'news1'));
  const goneBody = await repo.searchMessages('verbatim', { account: ACCOUNT });
  assert.ok(!goneBody.some((h) => h.gmail_message_id === 'news1'), 'demoted body no longer indexed');
});

test('compact respects the grace window; --now overrides it', async () => {
  const repo = await aggregated();
  // Summarized just now → inside the 7-day grace.
  await saveSummary(repo, ACCOUNT, 'message', 'news1', 'fresh summary', { at: iso(T0) });

  const held = await compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal(held.demoted, 0, 'within grace, nothing demotes');
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'full');

  const forced = await compact(repo, ACCOUNT, { asOf: NOW, now: true });
  assert.equal(forced.demoted, 1, '--now ignores the grace window');
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'summary-only');
});

test('compact never demotes a body without a summary', async () => {
  const repo = await aggregated();
  // news1 is full + bulk but never summarized → not eligible.
  const result = await compact(repo, ACCOUNT, { asOf: NOW, now: true });
  assert.equal(result.demoted, 0);
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'full');
});

test('compact cutoff is grace before asOf', async () => {
  const repo = await aggregated();
  const result = await compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal(result.cutoff, iso(T0 - DEFAULT_GRACE_MS));
});

test('a re-sync (meta upsert) never re-inflates a demoted body', async () => {
  const repo = await aggregated();
  await saveSummary(repo, ACCOUNT, 'message', 'news1', 'a summary', { at: iso(T0 - 10 * 86_400_000) });
  await compact(repo, ACCOUNT, { asOf: NOW });
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'summary-only');
  // A plain metadata re-sync arrives as meta — no-downgrade keeps summary-only.
  await seed(repo, {
    id: 'news1', threadId: 't-news', internalDate: T0 - 5000,
    from: 'Digest <digest@news.example.com>', to: ME, subject: 'weekly digest',
    isList: true, category: 'promotions', bodyState: 'meta', snippet: 'newsletter snippet',
  });
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).body_state, 'summary-only');
  assert.equal((await repo.getMessage(ACCOUNT, 'news1')).summary_text, 'a summary', 'summary survives re-sync');
});

// ---- domain categorization loop -------------------------------------------

test('domainsToCategorize returns Correspondent-bearing candidates + context', async () => {
  const repo = await aggregated();
  const candidates = await domainsToCategorize(repo, ACCOUNT);

  // vendor.example.com has a Correspondent (user replied to Casey); news/forum
  // domains have no Correspondent → excluded.
  const vendor = candidates.find((c) => c.domain === 'vendor.example.com');
  assert.ok(vendor, 'vendor domain (has a Correspondent) is a candidate');
  assert.ok(vendor.correspondentCount >= 1);
  assert.ok(!candidates.some((c) => c.domain === 'news.example.com'), 'no-Correspondent domain excluded');

  // Sample context: the sender + recent subjects the agent judges on.
  const casey = vendor.samples.find((s) => s.address === 'casey@vendor.example.com');
  assert.ok(casey, 'sample sender present');
  assert.ok(casey.subjects.includes('invoice 42'), 'recent subjects given as context');
});

test('saveDomainCategory persists onto domains.category (open vocabulary)', async () => {
  const repo = await aggregated();
  const result = await saveDomainCategory(repo, ACCOUNT, 'vendor.example.com', 'travel operator', 'books Antarctic charters');
  assert.equal(result.category, 'travel operator');

  const row = await repo.getDomain(ACCOUNT, 'vendor.example.com');
  assert.equal(row.category, 'travel operator');

  // Once categorized it drops out of the default (uncategorized-only) proposal,
  // and reappears when explicitly including categorized domains.
  assert.ok(!(await domainsToCategorize(repo, ACCOUNT)).some((c) => c.domain === 'vendor.example.com'));
  assert.ok(
    (await domainsToCategorize(repo, ACCOUNT, { includeCategorized: true })).some(
      (c) => c.domain === 'vendor.example.com' && c.category === 'travel operator',
    ),
  );
});

test('saveDomainCategory rejects empty domain/category', async () => {
  const repo = await aggregated();
  await assert.rejects(async () => await saveDomainCategory(repo, ACCOUNT, '  ', 'vendor'), /non-empty domain/);
  await assert.rejects(async () => await saveDomainCategory(repo, ACCOUNT, 'x.example.com', ''), /non-empty category/);
});

test('domainsToCategorize is token-conscious (respects limit)', async () => {
  const repo = await aggregated();
  const capped = await domainsToCategorize(repo, ACCOUNT, { limit: 1, includeCategorized: true });
  assert.ok(capped.length <= 1);
});
