/**
 * Integration test (SCOPE 1.4, PLAN §19 "Index integration: sync→enrich→search
 * over a synthetic fixture mailbox; assert counts, FTS hits"). Drives a
 * synthetic fixture mailbox through the FULL phase-1 → enrich → search pipeline
 * on a real on-disk tmp DB (not `:memory:`, to exercise the file-backed path),
 * with no live network — a {@link FakeMailSource} stands in for the provider.
 *
 * Coverage end-to-end:
 *  - sync (phase 1): meta counts, classification (category / is_list /
 *    direction incl. a Sent message), FTS hits on snippets while still `meta`;
 *  - enrich (`--rule direct`): body_state transitions to `full` for the direct
 *    rows ONLY — the list/newsletter and promotions rows stay `meta`; the
 *    distilled body becomes FTS-searchable;
 *  - no-downgrade: a phase-1 re-sync after enrich keeps `full` rows `full`;
 *  - search returns ranked hits;
 *  - sync_runs holds an audit row for BOTH phases (`sync` and `enrich`).
 *
 * Tests import the compiled `dist/` output (the pretest:tsc hook builds first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { syncMetadata } from '../dist/ingest/sync.js';
import { enrich } from '../dist/ingest/enrich.js';

const ACCOUNT = 'integration-acct';

/**
 * A synthetic mailbox spanning the message shapes the pipeline must handle:
 * a direct human reply (text), a list/newsletter (HTML body with tracking
 * pixel + unsubscribe footer), a promotional message, and a Sent message.
 * Newest-first, as `listIds` yields.
 */
const FIXTURES = {
  address: 'al@example.com',
  messages: [
    {
      // Direct human mail — text body with a signature + quoted history.
      id: 'm-direct',
      threadId: 't-charter',
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
      // List/newsletter — HTML body with tracking pixel + unsubscribe footer.
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
      // Promotional mail — excluded by rule=direct (CATEGORY_PROMOTIONS).
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
    {
      // Sent message (D11) — own address from_addr + SENT label → direction sent.
      id: 'm-sent',
      threadId: 't-charter',
      internalDate: 1_716_800_000_000,
      dateHeader: 'Mon, 27 May 2024 10:53:20 +0000',
      from: 'Al Operator <al@example.com>',
      to: 'Jordan Partner <jordan@partner.example.com>',
      cc: null,
      subject: 'Re: Deposit terms for the Antarctica charter',
      labels: ['SENT', 'CATEGORY_PERSONAL'],
      snippet: 'Can you confirm the deposit schedule?',
      sizeEstimate: 2048,
      bodyText: 'Can you confirm the deposit schedule?\n\nThanks,\nAl',
      bodyHtml: null,
      mimeType: 'text/plain',
    },
  ],
};

const MESSAGE_COUNT = FIXTURES.messages.length;

function fakeSource(): FakeMailSource {
  return new FakeMailSource(FIXTURES as never);
}

/**
 * Open a fresh on-disk DB in a throwaway tmp dir, run `body` against a Repo over
 * it, then clean up. Uses a file-backed DB (not `:memory:`) so the integration
 * path exercises real persistence, WAL sidecars, and migrations on disk.
 */
async function withTmpRepo(body: (repo: Repo) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mail-index-int-'));
  const path = join(dir, 'mail.sqlite');
  const db = await openDb({ path });
  try {
    await body(new Repo(db));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('full pipeline: sync → await enrich(rule=direct) → search over a synthetic mailbox', async () => {
  await withTmpRepo(async (repo) => {
    // ----- Phase 1: metadata sweep -------------------------------------------
    const syncResult = await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });

    // Meta counts: every fixture message indexed, none missed.
    assert.equal(syncResult.fetched, MESSAGE_COUNT);
    assert.equal(syncResult.indexed, MESSAGE_COUNT);
    assert.equal(await repo.countMessages(ACCOUNT), MESSAGE_COUNT);

    // Everything starts at body_state='meta' with no body_text.
    for (const m of FIXTURES.messages) {
      const row = await repo.getMessage(ACCOUNT, m.id);
      assert.ok(row, `${m.id} indexed`);
      assert.equal(row.body_state, 'meta', `${m.id} starts meta`);
      assert.equal(row.body_text, null, `${m.id} has no body yet`);
    }

    // Classification: category / is_list / direction.
    const direct = await repo.getMessage(ACCOUNT, 'm-direct');
    assert.equal(direct?.category, 'personal');
    assert.equal(direct?.is_list, 0);
    assert.equal(direct?.direction, 'received');
    assert.equal(direct?.important, 1); // IMPORTANT label snapshotted (D12)

    const list = await repo.getMessage(ACCOUNT, 'm-list');
    assert.equal(list?.category, 'updates');
    assert.equal(list?.is_list, 1, 'List-* headers → is_list');
    assert.equal(list?.unread, 1); // UNREAD label snapshotted (D12)

    const promo = await repo.getMessage(ACCOUNT, 'm-promo');
    assert.equal(promo?.category, 'promotions');
    assert.equal(promo?.is_list, 0);

    const sent = await repo.getMessage(ACCOUNT, 'm-sent');
    assert.equal(sent?.direction, 'sent', 'own-address sender + SENT → sent');

    // FTS hits on snippets while still meta (body not yet fetched).
    assert.ok(
      (await repo.searchMessages('Antarctica', { account: ACCOUNT })).some((m) => m.gmail_message_id === 'm-direct'),
      'subject term matches at meta',
    );
    assert.ok(
      (await repo.searchMessages('zodiac', { account: ACCOUNT })).some((m) => m.gmail_message_id === 'm-list'),
      'snippet term matches at meta',
    );
    // A body-only term does NOT match before enrich (only snippet is indexed).
    // "Wire" lives in m-direct's body but not its subject/snippet/sender.
    assert.equal(
      (await repo.searchMessages('Wire', { account: ACCOUNT })).length,
      0,
      'body-only term absent until enrich',
    );

    // ----- Phase 2: enrich --rule direct -------------------------------------
    const enrichResult = await enrich({
      account: ACCOUNT,
      source: fakeSource(),
      repo,
      selector: { rule: 'direct' },
    });
    // Only the direct received human mail is promoted. The list (is_list=1),
    // the promotions row (category=promotions), AND the Sent row are excluded
    // by rule=direct's predicate (is_list=0 AND category NOT IN promotions/social).
    // m-sent is personal+received-by-predicate but here it carries SENT — it is
    // still direct (is_list=0, personal) so it is promoted too. Assert exactly
    // which rows flipped rather than a bare count.
    const states = await Promise.all(
      FIXTURES.messages.map(async (m) => ({
        id: m.id,
        state: (await repo.getMessage(ACCOUNT, m.id))?.body_state,
      })),
    );
    const fullAfterDirect = states.filter((m) => m.state === 'full').map((m) => m.id);
    assert.deepEqual(
      [...fullAfterDirect].sort(),
      ['m-direct', 'm-sent'].sort(),
      'rule=direct promotes the two direct (non-list, non-promo) rows only',
    );
    assert.equal(enrichResult.enriched, 2);

    // The list/newsletter and promotions rows stay meta — never promoted.
    assert.equal((await repo.getMessage(ACCOUNT, 'm-list'))?.body_state, 'meta', 'list excluded');
    assert.equal((await repo.getMessage(ACCOUNT, 'm-promo'))?.body_state, 'meta', 'promotions excluded');

    // Distilled body stored (quoted history + signature stripped), not raw bytes.
    const enrichedDirect = await repo.getMessage(ACCOUNT, 'm-direct');
    assert.ok(enrichedDirect?.body_text?.includes('Confirming the 20% deposit'), 'real content kept');
    assert.ok(!enrichedDirect?.body_text?.includes('Can you confirm'), 'quoted history removed');
    assert.ok(!enrichedDirect?.body_text?.includes('VP Charters'), 'signature removed');
    assert.ok(enrichedDirect?.body_fetched_at, 'body_fetched_at recorded');

    // Distilled body is now FTS-searchable — the same body-only term that was
    // absent at meta now matches the enriched row.
    assert.ok(
      (await repo.searchMessages('Wire', { account: ACCOUNT })).some((m) => m.gmail_message_id === 'm-direct'),
      'distilled body term now matches via FTS after enrich',
    );

    // ----- No-downgrade on re-sync -------------------------------------------
    await syncMetadata({ account: ACCOUNT, source: fakeSource(), repo });
    const afterResync = await repo.getMessage(ACCOUNT, 'm-direct');
    assert.equal(afterResync?.body_state, 'full', 'no downgrade full→meta on re-sync');
    assert.ok(afterResync?.body_text?.includes('Confirming the 20% deposit'), 'body preserved');
    // Re-sync is idempotent — still no duplicate rows.
    assert.equal(await repo.countMessages(ACCOUNT), MESSAGE_COUNT, 'no duplicate rows on re-sync');

    // ----- Search returns ranked hits ----------------------------------------
    const hits = await repo.searchMessages('deposit', { account: ACCOUNT });
    assert.ok(hits.length >= 1, 'ranked search returns hits');
    // bm25 ordering is stable; the charter thread mail is the relevant match.
    assert.ok(
      hits.some((m) => m.gmail_message_id === 'm-direct'),
      'the enriched direct mail ranks among the hits',
    );

    // ----- sync_runs audit rows for BOTH phases ------------------------------
    const phases = await repo.driver
      .prepare('SELECT phase, count(*) AS c FROM sync_runs WHERE account = ? GROUP BY phase')
      .all(ACCOUNT) as { phase: string; c: number }[];
    const byPhase = new Map(phases.map((p) => [p.phase, p.c]));
    assert.equal(byPhase.get('sync'), 2, 'two phase-1 sync runs (initial + re-sync)');
    assert.equal(byPhase.get('enrich'), 1, 'one enrich run recorded');

    // Both phases left closed (lock-released) rows, and the enrich row records
    // its selector.
    const open = await repo.driver
      .prepare('SELECT count(*) AS c FROM sync_runs WHERE account = ? AND finished_at IS NULL')
      .get(ACCOUNT) as { c: number };
    assert.equal(open.c, 0, 'every run closed → no held locks');

    const enrichRow = await repo.driver
      .prepare('SELECT phase, selector FROM sync_runs WHERE id = ?')
      .get(enrichResult.runId) as { phase: string; selector: string | null };
    assert.equal(enrichRow.phase, 'enrich');
    assert.match(String(enrichRow.selector), /rule=direct/);
  });
});
