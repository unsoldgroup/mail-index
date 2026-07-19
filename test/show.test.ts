/**
 * Lazy-enrichment tests (SCOPE 1.2, UNS-1217, ADR-0001). Cover:
 *
 *  - `parseRef` of the <account>:<id> handle (and its error cases).
 *  - `runShow` auto-enriches a still-`meta` row (one getFull → distil → upsert)
 *    and prints the distilled body — the O(1) inline pattern.
 *  - `runShow` on an already-`full` row does NOT re-fetch (idempotent / O(0)).
 *  - `runShow` errors clearly for an unknown account / un-indexed message.
 *  - `runSearchEnriching` with `--enrich` promotes the returned hits so a
 *    body-only term then matches; without `--enrich` it is a plain search.
 *
 * Runs against a FakeMailSource (no network). Imports the compiled output, like
 * the other suites, so it runs after the `pretest` compile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { syncMetadata } from '../dist/ingest/sync.js';
import { parseRef, runShow, formatShow, RefError } from '../dist/cli/show.js';
import { runSearchEnriching } from '../dist/cli/search.js';

const ACCOUNT = 'test-acct';

const FIXTURES = {
  address: 'al@example.com',
  messages: [
    {
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
        'Hi Al,\n\nConfirming the 20% deposit is due Friday. The repositioning leg is booked.\n\n' +
        '--\nJordan Partner\nVP Charters\n\n' +
        'On Tue, 28 May 2024 at 14:40, Al wrote:\n> Can you confirm the deposit schedule?',
      bodyHtml: null,
      mimeType: 'text/plain',
    },
    {
      id: 'm-list',
      threadId: 't-list',
      internalDate: 1_716_900_000_000,
      dateHeader: 'Tue, 28 May 2024 14:40:00 +0000',
      from: 'Expedition Weekly <news@bulletin.example.org>',
      to: 'subscribers@bulletin.example.org',
      cc: null,
      subject: 'This week in polar logistics',
      labels: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
      snippet: 'Top stories.',
      sizeEstimate: 28_672,
      headers: {
        'List-Id': 'Expedition Weekly <news.bulletin.example.org>',
      },
      bodyText: null,
      bodyHtml:
        '<html><body><h1>This week in polar logistics</h1>' +
        '<p>Top stories: new zodiac schedules are out.</p></body></html>',
      mimeType: 'text/html',
    },
  ],
};

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

function fakeSource(): FakeMailSource {
  return new FakeMailSource(FIXTURES as never);
}

/** An operator config whose one account builds the fake source. */
const CONFIG = { accounts: { [ACCOUNT]: { adapter: 'gws', configDir: '/x' } } } as never;
const buildFake = () => fakeSource();

async function seed(repo: Repo): Promise<void> {
  await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
}

// ---- parseRef ------------------------------------------------------------

test('parseRef splits <account>:<id> on the first colon', async () => {
  assert.deepEqual(parseRef('personal:18f0a1b2c3'), { account: 'personal', id: '18f0a1b2c3' });
  // Id keeps any later colon intact.
  assert.deepEqual(parseRef('acct:a:b'), { account: 'acct', id: 'a:b' });
});

test('parseRef rejects refs missing an account or id', async () => {
  for (const bad of ['', 'noColon', ':id', 'acct:']) {
    assert.throws(() => parseRef(bad), (e: unknown) => e instanceof RefError);
  }
});

// ---- show / lazy enrichment ----------------------------------------------

test('runShow auto-enriches a meta message, then prints the distilled body', async () => {
  const repo = await freshRepo();
  await seed(repo);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta');

  const result = await runShow(CONFIG, repo, { account: ACCOUNT, id: 'm-direct' }, buildFake);
  assert.equal(result.enriched, true);
  assert.equal(result.row.body_state, 'full');

  // Persisted: the row is now full in the index (not just in the returned copy).
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');

  const out = formatShow(result);
  assert.match(out, /Confirming the 20% deposit/);
  assert.match(out, /just enriched/);
  // Distillation applied: quoted history + signature gone.
  assert.doesNotMatch(out, /Can you confirm/);
  assert.doesNotMatch(out, /VP Charters/);
  // Header fields rendered.
  assert.match(out, /subject:.*Antarctica charter/);
  assert.match(out, new RegExp(`ref:\\s+${ACCOUNT}:m-direct`));
});

test('runShow on an already-full message does not re-fetch', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // First show enriches it.
  await runShow(CONFIG, repo, { account: ACCOUNT, id: 'm-direct' }, buildFake);

  // A source that explodes if getFull is called — proving the second show is O(0).
  const exploding = {
    provider: 'fake',
    check: () => Promise.resolve({ ok: true, address: null }),
    listIds: async function* () {},
    getMetadata: () => Promise.resolve([]),
    getFull: () => {
      throw new Error('getFull must not be called for an already-full row');
    },
  };
  const result = await runShow(CONFIG, repo, { account: ACCOUNT, id: 'm-direct' }, () => exploding as never);
  assert.equal(result.enriched, false);
  assert.equal(result.row.body_state, 'full');
});

test('runShow errors clearly for an unknown account', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await assert.rejects(
    () => runShow(CONFIG, repo, { account: 'nope', id: 'm-direct' }, buildFake),
    // Unknown account surfaces as the config error (resolveAccount).
    (e: unknown) => e instanceof Error && /unknown account/.test(e.message),
  );
});

test('runShow errors when the message is not in the index', async () => {
  const repo = await freshRepo();
  await seed(repo);
  await assert.rejects(
    () => runShow(CONFIG, repo, { account: ACCOUNT, id: 'ghost' }, buildFake),
    (e: unknown) => e instanceof RefError && /not in the index/.test(e.message),
  );
});

// ---- search --enrich -----------------------------------------------------

test('search --enrich promotes the returned hits so a body-only term then matches', async () => {
  const repo = await freshRepo();
  await seed(repo);

  // "repositioning" lives only in the body — before enrich it is not indexed.
  const cold = await runSearchEnriching(CONFIG, repo, ['repositioning'], { enrich: false }, buildFake);
  assert.equal(cold.length, 0);

  // A term that matches the meta row's subject/snippet surfaces the hit, and
  // --enrich then promotes that hit's body.
  const enriched = await runSearchEnriching(CONFIG, repo, ['deposit'], { enrich: true }, buildFake);
  assert.ok(enriched.some((m) => m.gmail_message_id === 'm-direct'));
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'full');

  // Now the body-only term matches because the hit was enriched + re-indexed.
  const warm = await runSearchEnriching(CONFIG, repo, ['repositioning'], { enrich: false }, buildFake);
  assert.ok(warm.some((m) => m.gmail_message_id === 'm-direct'));
});

test('search without --enrich does not promote anything', async () => {
  const repo = await freshRepo();
  await seed(repo);
  const hits = await runSearchEnriching(CONFIG, repo, ['deposit'], { enrich: false }, buildFake);
  assert.ok(hits.length > 0);
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta', 'still meta');
});

test('search --enrich skips hits whose account is unconfigured (best-effort)', async () => {
  const repo = await freshRepo();
  await seed(repo);
  // Empty config → the hit account is unconfigured; enrich is skipped but the
  // ranked hit is still returned.
  const hits = await runSearchEnriching({ accounts: {} } as never, repo, ['deposit'], { enrich: true }, buildFake);
  assert.ok(hits.some((m) => m.gmail_message_id === 'm-direct'));
  assert.equal((await repo.getMessage(ACCOUNT, 'm-direct'))?.body_state, 'meta', 'not enriched');
});
