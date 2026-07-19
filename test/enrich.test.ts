/**
 * Enrich phase-2 tests (SCOPE 1.1, PLAN §7 phase 2, CONTEXT.md "Enrichment",
 * ADR-0003). Runs against a FakeMailSource with HTML + text bodies (no live
 * network). Asserts: meta → full promotion with a distilled body, the
 * selectors (rule direct / sender / match / limit), incremental + idempotent
 * re-runs, FTS body searchability after enrich, no-downgrade, and a sync_runs
 * audit row with phase='enrich'. Tests import the compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { syncMetadata } from '../dist/ingest/sync.js';
import { enrich, EnrichError } from '../dist/ingest/enrich.js';

const ACCOUNT = 'test-acct';

/** Fixtures with bodies the distiller should reshape. Newest-first. */
const FIXTURES = {
  address: 'al@example.com',
  messages: [
    {
      // Direct human mail with quoted history + signature in the body.
      id: 'm-direct',
      threadId: 't-direct',
      internalDate: 1_717_000_000_000,
      dateHeader: 'Wed, 29 May 2024 18:26:40 +0000',
      from: 'Jordan Partner <jordan@partner.example.com>',
      to: 'Al Operator <al@example.com>',
      cc: null,
      subject: 'Re: Deposit terms for the Antarctica charter',
      labels: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'],
      snippet: 'Confirming the 20% deposit is due Friday.',
      sizeEstimate: 4096,
      bodyText:
        'Hi Al,\n\nConfirming the 20% deposit is due Friday. Wire details below.\n\n' +
        '--\nJordan Partner\nVP Charters\n\n' +
        'On Tue, 28 May 2024 at 14:40, Al wrote:\n> Can you confirm the deposit schedule?',
      bodyHtml: null,
      mimeType: 'text/plain',
    },
    {
      // Newsletter (list) with HTML body, tracking pixel, unsubscribe footer.
      id: 'm-list',
      threadId: 't-list',
      internalDate: 1_716_900_000_000,
      dateHeader: 'Tue, 28 May 2024 14:40:00 +0000',
      from: 'Expedition Weekly <news@bulletin.example.org>',
      to: 'subscribers@bulletin.example.org',
      cc: null,
      subject: 'This week in polar logistics',
      labels: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
      snippet: 'Top stories: new zodiac schedules.',
      sizeEstimate: 28_672,
      headers: {
        'List-Id': 'Expedition Weekly <news.bulletin.example.org>',
        'List-Unsubscribe': '<https://bulletin.example.org/unsubscribe>',
      },
      bodyText: null,
      bodyHtml:
        '<html><head><style>.x{color:#999}</style></head><body>' +
        '<img src="https://bulletin.example.org/o/p.gif?open=1" width="1" height="1"/>' +
        '<h1>This week in polar logistics</h1>' +
        '<p>Top stories: new zodiac schedules are out and confirmed.</p>' +
        '<p>&copy; 2024 Expedition Weekly. All rights reserved.</p>' +
        '<a href="https://bulletin.example.org/unsubscribe">Unsubscribe</a>' +
        '</body></html>',
      mimeType: 'text/html',
    },
    {
      // Promotional mail — excluded by rule=direct.
      id: 'm-promo',
      threadId: 't-promo',
      internalDate: 1_716_850_000_000,
      dateHeader: 'Mon, 27 May 2024 22:00:00 +0000',
      from: 'Deals <deals@shop.example.org>',
      to: 'al@example.com',
      cc: null,
      subject: 'Half off parkas this weekend',
      labels: ['CATEGORY_PROMOTIONS'],
      snippet: 'Big savings on cold-weather gear.',
      sizeEstimate: 12_000,
      bodyText: 'Big savings on cold-weather gear this weekend only.',
      bodyHtml: null,
      mimeType: 'text/plain',
    },
  ],
};

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

function fakeSource(): FakeMailSource {
  return new FakeMailSource(FIXTURES as never);
}

/** Sync phase 1 so there are meta rows for enrich to promote. */
async function seed(repo: Repo): Promise<void> {
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
}

test('enrich promotes a meta row to full with a distilled body', async () => {
  const repo = await freshRepo();
  await seed(repo);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta');

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { sender: 'jordan@partner.example.com' } });
  assert.equal(result.enriched, 1);

  const row = await repo.getMessage(ACCOUNT, 'm-direct');
  assert.ok(row);
  assert.equal(row.body_state, 'full');
  assert.ok(row.body_text?.includes('Confirming the 20% deposit'), 'distilled body stored');
  assert.ok(!row.body_text?.includes('Can you confirm'), 'quoted history removed');
  assert.ok(!row.body_text?.includes('VP Charters'), 'signature removed');
  assert.ok(row.body_fetched_at, 'body_fetched_at recorded');
  // Metadata preserved (not nulled by the sparse-looking promotion upsert).
  assert.equal(row.subject, 'Re: Deposit terms for the Antarctica charter');
  assert.equal(row.is_list, 0);
  assert.equal(row.important, 1);
});

test('rule=direct enriches direct mail and skips list + promotions', async () => {
  const repo = await freshRepo();
  await seed(repo);

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'direct' } });
  assert.equal(result.enriched, 1, 'only the direct message');

  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'meta', 'list skipped');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-promo'))?.body_state, 'meta', 'promo skipped');
});

test('default selector is rule=direct', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo });
  assert.equal(result.enriched, 1);
  assert.match(result.selector ?? '', /rule=direct/);
});

test('rule=all enriches every meta row including list + promotions', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all' } });
  assert.equal(result.enriched, 3);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'full');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-promo'))?.body_state, 'full');
});

test('list HTML body is distilled (footer + tracking removed) on enrich', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { sender: 'news@bulletin.example.org' } });

  const row = await repo.getMessage(ACCOUNT, 'm-list');
  assert.ok(row?.body_text?.includes('new zodiac schedules'), 'real content kept');
  assert.ok(!/unsubscribe/i.test(row?.body_text ?? ''), 'unsubscribe footer gone');
  assert.ok(!/all rights reserved/i.test(row?.body_text ?? ''), 'copyright gone');
  assert.ok(!(row?.body_text ?? '').includes('p.gif'), 'tracking pixel gone');
});

test('match selector enriches only FTS-matching meta rows', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all', match: 'zodiac' } });
  assert.equal(result.enriched, 1);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'full');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta');
});

test('limit caps how many rows are enriched (newest first)', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all', limit: 1 } });
  assert.equal(result.enriched, 1);
  // Newest is m-direct (largest internal_date).
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');
});

test('enrich is incremental + idempotent — re-run promotes nothing new', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const first = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all' } });
  assert.equal(first.enriched, 3);

  const second = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all' } });
  assert.equal(second.enriched, 0, 'no meta rows left to promote');
  assert.equal(second.fetched, 0, 'no full bodies re-fetched');
});

test('after enrich the distilled body is FTS-searchable', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Before enrich, a body-only term does not match (snippet lacks it).
  const before = await repo.searchMessages('repositioning', { account: ACCOUNT });
  assert.equal(before.length, 0);

  await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { sender: 'jordan@partner.example.com' } });
  const after = await repo.searchMessages('Friday', { account: ACCOUNT });
  assert.ok(after.some((m) => m.gmail_message_id === 'm-direct'), 'body term now matches');
});

test('a phase-1 re-sync after enrich does not downgrade the full body', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'direct' } });
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');

  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
  const row = await repo.getMessage(ACCOUNT, 'm-direct');
  assert.equal(row?.body_state, 'full', 'no downgrade');
  assert.ok(row?.body_text?.includes('Confirming the 20% deposit'), 'body preserved');
});

test('enrich writes a sync_runs row with phase=enrich and the selector', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all', limit: 2 } });

  const row = await repo.driver
    .prepare('SELECT * FROM sync_runs WHERE id = ?')
    .get(result.runId) as Record<string, unknown>;
  assert.equal(row['phase'], 'enrich');
  assert.equal(row['account'], ACCOUNT);
  assert.ok(row['finished_at'], 'row closed → lock released');
  assert.match(String(row['selector']), /rule=all/);
  assert.match(String(row['selector']), /limit=2/);
});

test('enrich refuses to start while another run holds the account lock', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await repo.startSyncRun({ account: ACCOUNT, phase: 'sync', selector: null });

  await assert.rejects(
    () => enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { rule: 'all' } }),
    (err: unknown) => err instanceof EnrichError && /already in progress/.test((err as Error).message),
  );
});

test('enrich skips ids the provider can no longer return', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const src = fakeSource();
  // Provider returns null for the direct message (deleted upstream).
  (src as unknown as { getFull: (id: string) => Promise<unknown> }).getFull = (id: string) =>
    Promise.resolve(id === 'm-direct' ? null : FIXTURES.messages.find((m) => m.id === id) ?? null);

  const result = await enrich({ account: ACCOUNT, source: src, repo, selector: { rule: 'direct' } });
  assert.equal(result.enriched, 0, 'nothing enriched');
  assert.equal(result.fetched, 0, 'gone id not counted as fetched');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta', 'left as meta');
});

// ---- M3.2: profile-driven enrichment (SCOPE 3.2, PLAN §7 priority-1, D14) ----
//
// The curated interest_profile becomes the enrichment policy: important
// contacts/domains → always; muted/blocked → never; keyword FTS matches → yes.
// These tests curate the seeded fixtures then enrich with `{ profile: true }`.

test('profile enrich: an important contact promotes its meta rows', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Curate Jordan (sender of m-direct) as important.
  await repo.upsertContact({ account: ACCOUNT, address: 'jordan@partner.example.com', curation: 'important' });

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal(result.enriched, 1, 'only the important contact’s mail');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'meta', 'uncurated list untouched');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-promo'))?.body_state, 'meta', 'uncurated promo untouched');
  assert.match(result.selector ?? '', /profile/);
});

test('profile enrich: an important domain promotes mail from that domain', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Curate the newsletter's domain as important — matches `news@bulletin.example.org`.
  await repo.setDomainCuration(ACCOUNT, 'bulletin.example.org', 'important');

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal(result.enriched, 1);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'full', 'domain match enriched');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta');
});

test('profile enrich: a muted contact is never enriched, even on a keyword hit', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Mute the newsletter sender, but add a keyword that its snippet matches.
  await repo.upsertContact({ account: ACCOUNT, address: 'news@bulletin.example.org', curation: 'muted' });
  await repo.setInterestKeywords(ACCOUNT, ['zodiac']); // m-list snippet has "zodiac schedules"

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'meta', 'muted dominates the keyword match');
  assert.equal(result.enriched, 0);
});

test('profile enrich: a blocked domain is excluded like muted', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await repo.setInterestKeywords(ACCOUNT, ['zodiac']);
  await repo.setDomainCuration(ACCOUNT, 'bulletin.example.org', 'blocked');

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal(result.enriched, 0, 'blocked domain excluded despite keyword hit');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'meta');
});

test('profile enrich: keyword FTS matches are included', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // "deposit" is in m-direct's subject/snippet — pure keyword inclusion, no
  // curated entities at all.
  await repo.setInterestKeywords(ACCOUNT, ['deposit']);

  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal(result.enriched, 1);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full', 'keyword match enriched');
});

test('profile enrich: an empty profile enriches nothing (no bare match-all)', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true } });
  assert.equal(result.enriched, 0, 'no important entities + no keywords → empty candidate set');
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta');
});

test('profile enrich: limit caps the resolved candidate set (newest first)', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Make all three senders' mail eligible via keyword, then cap to 1.
  await repo.setInterestKeywords(ACCOUNT, ['deposit', 'zodiac', 'parkas']);
  const result = await enrich({ account: ACCOUNT, source: fakeSource(), repo, selector: { profile: true, limit: 1 } });
  assert.equal(result.enriched, 1);
  // Newest is m-direct (largest internal_date).
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');
});
