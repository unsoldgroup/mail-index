/**
 * Interest engine tests (SCOPE 2.2, PLAN §10 weight table, D12, D13,
 * CONTEXT.md "Engagement score").
 *
 * Two layers:
 *  - PURE scoring math ({@link scoreContact}) — ordering + weight behaviour,
 *    isolated from the DB. The headline property: a replied-to Correspondent
 *    outranks a never-opened newsletter.
 *  - DB pass ({@link interestPass}) — score persisted onto contacts, one
 *    snapshot row appended per contact each run, idempotent recompute, and the
 *    score is never an autonomous fetch trigger (D13).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import {
  scoreContact,
  interestPass,
  W_NEVER_OPENED,
  W_BULK,
} from '../dist/intelligence/interest.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';
const NOW = Date.UTC(2026, 5, 15); // fixed clock for deterministic recency

async function freshRepo() {
  return new Repo(await openDb({ path: ':memory:' }));
}

/** A baseline feature record (a single read received message, nothing else). */
function baseFeatures(over = {}) {
  return {
    msgsReceived: 1,
    msgsSent: 0,
    readCount: 1,
    repliedCount: 0,
    initiatedCount: 0,
    starredCount: 0,
    importantCount: 0,
    bulkCount: 0,
    lastSeenMs: NOW,
    nowMs: NOW,
    ...over,
  };
}

// ---- pure scoring math ----------------------------------------------------

test('a replied-to Correspondent outranks a never-opened newsletter', async () => {
  // The headline ordering property (CONTEXT.md, PLAN §10).
  const correspondent = scoreContact(
    baseFeatures({
      msgsReceived: 8,
      msgsSent: 5,
      readCount: 8,
      repliedCount: 4,
      initiatedCount: 1,
      importantCount: 2,
    }),
  );
  const newsletter = scoreContact(
    baseFeatures({
      msgsReceived: 40,
      msgsSent: 0,
      readCount: 0, // never opened
      bulkCount: 40, // pure list/promotions
    }),
  );

  assert.ok(correspondent > 0, 'engaged correspondent scores positive');
  assert.ok(newsletter < 0, 'never-opened newsletter scores negative');
  assert.ok(correspondent > newsletter, 'correspondent ranks above newsletter');
});

test('replied + initiated are strong positive signals', async () => {
  const none = scoreContact(baseFeatures());
  const replied = scoreContact(baseFeatures({ msgsSent: 3, repliedCount: 3 }));
  const initiated = scoreContact(baseFeatures({ msgsSent: 3, initiatedCount: 3 }));
  assert.ok(replied > none, 'replying lifts the score');
  assert.ok(initiated > none, 'initiating lifts the score');
});

test('starred and important lift the score; important outweighs starred', async () => {
  const none = scoreContact(baseFeatures({ msgsReceived: 4, readCount: 4 }));
  const starred = scoreContact(baseFeatures({ msgsReceived: 4, readCount: 4, starredCount: 4 }));
  const important = scoreContact(baseFeatures({ msgsReceived: 4, readCount: 4, importantCount: 4 }));
  assert.ok(starred > none);
  assert.ok(important > none);
  assert.ok(important > starred, 'IMPORTANT (medium+) outweighs STARRED (+)');
});

test('read-rate raises the score; a fully-unread contact scores lower', async () => {
  const read = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 10 }));
  const halfRead = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 5 }));
  const unread = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 0 }));
  assert.ok(read > halfRead, 'higher read-rate scores higher');
  assert.ok(halfRead > unread, 'partial read beats never-opened');
});

test('the bulk penalty scales with the fraction of bulk mail', async () => {
  const clean = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 10, bulkCount: 0 }));
  const halfBulk = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 10, bulkCount: 5 }));
  const allBulk = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 10, bulkCount: 10 }));
  assert.ok(clean > halfBulk, 'some bulk mail penalizes');
  assert.ok(halfBulk > allBulk, 'all-bulk penalizes most');
  // A full bulk fraction applies the whole W_BULK weight.
  assert.ok(Math.abs((clean - allBulk) - Math.abs(W_BULK)) < 1e-9, 'full bulk = full W_BULK delta');
});

test('never-opened (all unread, never written back) stacks an extra penalty', async () => {
  // Same received volume, all unread, all non-bulk: the never-opened penalty
  // applies on top.
  const neverOpened = scoreContact(baseFeatures({ msgsReceived: 5, readCount: 0, bulkCount: 0 }));
  const openedOnce = scoreContact(baseFeatures({ msgsReceived: 5, readCount: 1, bulkCount: 0 }));
  assert.ok(openedOnce > neverOpened, 'reading even one lifts above never-opened');
  // The never-opened term is exactly W_NEVER_OPENED below the read-rate=0/no-penalty baseline.
  const baseline = scoreContact(baseFeatures({ msgsReceived: 5, readCount: 0, repliedCount: 1, bulkCount: 0 }));
  // baseline has replied>0 so never-opened does NOT fire; difference isolates the term.
  assert.ok(baseline - neverOpened >= Math.abs(W_NEVER_OPENED) - 1e-9, 'replying suppresses never-opened penalty');
});

test('recency: a recent contact outscores an identical stale one', async () => {
  const recent = scoreContact(baseFeatures({ msgsReceived: 10, readCount: 10, lastSeenMs: NOW }));
  const stale = scoreContact(
    baseFeatures({ msgsReceived: 10, readCount: 10, lastSeenMs: NOW - 365 * 86_400_000 }),
  );
  assert.ok(recent > stale, 'recent correspondence ranks higher');
});

test('scoreContact is pure: same input → same output, no clock read', async () => {
  const f = baseFeatures({ msgsSent: 2, repliedCount: 2 });
  assert.equal(scoreContact(f), scoreContact({ ...f }));
});

// ---- DB pass --------------------------------------------------------------

/**
 * Seed a correspondent (Jordan: replied-to, read, important), a vendor the user
 * initiated with, and a never-opened newsletter — then aggregate so the
 * interest pass has contacts to score.
 */
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
    starred: m.starred ?? false,
    important: m.important ?? false,
    bodyState: 'meta',
  });
}

async function seedWorld(repo) {
  await seed(repo, {
    id: 'a-recv', threadId: 'thread-a', internalDate: NOW - 1000,
    from: 'Jordan Partner <jordan@partner.example.com>', to: `Al <${ME}>`,
    subject: 'Deposit terms', direction: 'received', important: true,
  });
  await seed(repo, {
    id: 'a-sent', threadId: 'thread-a', internalDate: NOW - 500,
    from: `Al <${ME}>`, to: 'Jordan Partner <jordan@partner.example.com>',
    subject: 'Re: Deposit terms', direction: 'sent',
  });
  // Newsletter: many received, all unread, list/updates → never-opened + bulk.
  for (let i = 0; i < 5; i++) {
    await seed(repo, {
      id: `n-${i}`, threadId: `thread-n-${i}`, internalDate: NOW - 10_000 - i,
      from: 'Expedition Weekly <news@bulletin.example.org>',
      to: 'subscribers@bulletin.example.org',
      subject: `Issue ${i}`, direction: 'received', isList: true,
      category: 'promotions', unread: true,
    });
  }
  await aggregateAccount(repo, ACCOUNT, [ME]);
}

test('interestPass persists engagement_score and ranks correspondent over newsletter', async () => {
  const repo = await freshRepo();
  await seedWorld(repo);
  const result = await interestPass(repo, ACCOUNT, { now: new Date(NOW) });

  const jordan = await repo.getEngagementScore(ACCOUNT, 'jordan@partner.example.com');
  const news = await repo.getEngagementScore(ACCOUNT, 'news@bulletin.example.org');
  assert.equal(typeof jordan, 'number', 'score persisted onto contacts');
  assert.ok(jordan > news, 'correspondent outranks newsletter in the DB');
  assert.ok(news < 0, 'never-opened bulk newsletter is negative');

  // The result mirrors what was persisted.
  const scoredJordan = result.scored.find((s) => s.address === 'jordan@partner.example.com');
  assert.equal(scoredJordan.engagementScore, jordan);
});

test('interestPass appends exactly one snapshot row per contact each run', async () => {
  const repo = await freshRepo();
  await seedWorld(repo);

  await interestPass(repo, ACCOUNT, { now: new Date(NOW) });
  assert.equal(await repo.countSnapshots(ACCOUNT, 'jordan@partner.example.com'), 1, 'one snapshot after first run');

  // A later run (distinct taken_at) appends a second snapshot generation.
  await interestPass(repo, ACCOUNT, { now: new Date(NOW + 86_400_000) });
  assert.equal(await repo.countSnapshots(ACCOUNT, 'jordan@partner.example.com'), 2, 'second run appends, never overwrites');

  // The snapshot mirrors the score's source aggregates.
  const snap = await repo.driver
    .prepare(
      `SELECT msgs_received, read_count, replied_count, engagement_score
         FROM contact_stats_snapshot
        WHERE account = ? AND address = ? ORDER BY taken_at LIMIT 1`,
    )
    .get(ACCOUNT, 'jordan@partner.example.com');
  assert.equal(snap.msgs_received, 1);
  assert.equal(snap.replied_count, 1);
  assert.equal(typeof snap.engagement_score, 'number');
});

test('recompute is idempotent: same index state → same score', async () => {
  const repo = await freshRepo();
  await seedWorld(repo);
  const first = await interestPass(repo, ACCOUNT, { now: new Date(NOW) });
  const second = await interestPass(repo, ACCOUNT, { now: new Date(NOW) });
  const byAddr = (r) => Object.fromEntries(r.scored.map((s) => [s.address, s.engagementScore]));
  assert.deepEqual(byAddr(second), byAddr(first), 're-running with same clock + state converges');
});

test('the score is a SEED, not a fetch trigger: no body is enriched (D13)', async () => {
  const repo = await freshRepo();
  await seedWorld(repo);
  await interestPass(repo, ACCOUNT, { now: new Date(NOW) });
  // Every message remains at meta — scoring never promoted a body.
  const fullCount = await repo.driver
    .prepare(`SELECT count(*) c FROM messages WHERE account = ? AND body_state != 'meta'`)
    .get(ACCOUNT);
  assert.equal(fullCount.c, 0, 'scoring enriched nothing');
});

test('contactScoringRows computes bulk_count from received bulk mail', async () => {
  const repo = await freshRepo();
  await seedWorld(repo);
  const rows = await repo.contactScoringRows(ACCOUNT);
  const news = rows.find((r) => r.address === 'news@bulletin.example.org');
  assert.equal(news.bulk_count, 5, 'all five newsletter issues are bulk');
  const jordan = rows.find((r) => r.address === 'jordan@partner.example.com');
  assert.equal(jordan.bulk_count, 0, 'a real correspondent has no bulk received mail');
});
