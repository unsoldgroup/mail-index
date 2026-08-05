/**
 * Contact / domain / thread aggregation tests (SCOPE 2.1, PLAN §6, D11,
 * CONTEXT.md "Correspondent"). Seeds a tmp in-memory DB with messages
 * (including Sent mail), runs the INDEX-ONLY aggregation pass, and asserts
 * contact counts, Correspondent detection (msgs_sent > 0), domain rollups,
 * thread user_participated, and the replied/initiated signals derived from sent
 * mail. No network — pure index work. Also drives the full phase-1 sync to
 * prove aggregation runs as part of sync (and indexes Sent mail, part a).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { DEFAULT_FIXTURES } from '../dist/source/fixtures/index.js';
import { syncMetadata } from '../dist/ingest/sync.js';
import { aggregateAccount, computeAggregates } from '../dist/intelligence/aggregate.js';

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
    starred: m.starred ?? false,
    important: m.important ?? false,
    snippet: m.snippet ?? null,
    bodyState: 'meta',
  });
}

/**
 * A conversation: Jordan (partner.example.com) initiates a received thread, the
 * user replies. A second thread the user initiates to Casey (vendor.example.com).
 * One newsletter (no Sent involvement). Times are oldest → newest within thread.
 */
async function seedConversation(repo) {
  // Thread A — Jordan writes first (t=1000), user replies (t=2000).
  await seed(repo, {
    id: 'a-recv',
    threadId: 'thread-a',
    internalDate: 1000,
    from: 'Jordan Partner <jordan@partner.example.com>',
    to: `Al Operator <${ME}>`,
    subject: 'Deposit terms',
    direction: 'received',
    important: true,
  });
  await seed(repo, {
    id: 'a-sent',
    threadId: 'thread-a',
    internalDate: 2000,
    from: `Al Operator <${ME}>`,
    to: 'Jordan Partner <jordan@partner.example.com>',
    subject: 'Re: Deposit terms',
    direction: 'sent',
  });

  // Thread B — user initiates to Casey (t=1500), no prior received message.
  await seed(repo, {
    id: 'b-sent',
    threadId: 'thread-b',
    internalDate: 1500,
    from: `Al Operator <${ME}>`,
    to: 'Casey Vendor <casey@vendor.example.com>',
    subject: 'Quote request',
    direction: 'sent',
  });

  // A newsletter — received, list, never replied to. Sender on its own domain.
  await seed(repo, {
    id: 'n-1',
    threadId: 'thread-n',
    internalDate: 900,
    from: 'Expedition Weekly <news@bulletin.example.org>',
    to: 'subscribers@bulletin.example.org',
    subject: 'This week in polar logistics',
    direction: 'received',
    isList: true,
    category: 'updates',
    unread: true,
  });
}

test('aggregation builds contacts from received + sent mail', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const jordan = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');
  assert.ok(jordan, 'received sender becomes a contact');
  assert.equal(jordan.msgs_received, 1);
  assert.equal(jordan.msgs_sent, 1, 'user sent one message to Jordan');
  assert.equal(jordan.display_name, 'Jordan Partner');
  assert.equal(jordan.domain, 'partner.example.com');
  assert.equal(jordan.important_count, 1, 'IMPORTANT snapshot rolled up');

  const casey = await repo.getContact(ACCOUNT, 'casey@vendor.example.com');
  assert.ok(casey, 'sent-only recipient becomes a contact');
  assert.equal(casey.msgs_received, 0);
  assert.equal(casey.msgs_sent, 1);

  const news = await repo.getContact(ACCOUNT, 'news@bulletin.example.org');
  assert.ok(news);
  assert.equal(news.msgs_received, 1);
  assert.equal(news.read_count, 0, 'unread newsletter is not a read');
});

test('the user is never aggregated as their own contact', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  assert.equal(await repo.getContact(ACCOUNT, ME), undefined, 'own address excluded');
});

test('Correspondent detection: msgs_sent > 0 (CONTEXT.md)', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const correspondents = await repo.listCorrespondents(ACCOUNT);
  const addrs = correspondents.map((c) => c.address).sort();
  assert.deepEqual(
    addrs,
    ['casey@vendor.example.com', 'jordan@partner.example.com'],
    'only contacts the user wrote to are Correspondents',
  );
  // The newsletter sender is received-only → never a Correspondent.
  assert.ok(
    !addrs.includes('news@bulletin.example.org'),
    'received-only sender is not a Correspondent',
  );
  for (const c of correspondents) assert.ok(c.msgs_sent > 0);
});

test('replied vs initiated derive from sent mail relative to the thread', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  // Jordan wrote first, then the user replied → a reply, not an initiation.
  const jordan = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');
  assert.equal(jordan.replied_count, 1, 'user replied to Jordan');
  assert.equal(jordan.initiated_count, 0);

  // The user started thread B to Casey → initiated, not a reply.
  const casey = await repo.getContact(ACCOUNT, 'casey@vendor.example.com');
  assert.equal(casey.initiated_count, 1, 'user initiated with Casey');
  assert.equal(casey.replied_count, 0);
});

test('domains roll contacts up: msgs + distinct_contacts', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  // Add a second contact on partner.example.com so distinct_contacts > 1.
  await seed(repo, {
    id: 'a-recv-2',
    threadId: 'thread-c',
    internalDate: 1200,
    from: 'Robin Partner <robin@partner.example.com>',
    to: `Al Operator <${ME}>`,
    subject: 'Logistics',
    direction: 'received',
  });
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const partner = await repo.getDomain(ACCOUNT, 'partner.example.com');
  assert.ok(partner);
  assert.equal(partner.distinct_contacts, 2, 'Jordan + Robin');
  // Jordan: 1 received + 1 sent; Robin: 1 received → 3 total.
  assert.equal(partner.msgs, 3);

  const vendor = await repo.getDomain(ACCOUNT, 'vendor.example.com');
  assert.ok(vendor);
  assert.equal(vendor.distinct_contacts, 1);
  assert.equal(vendor.msgs, 1);
});

test('threads: user_participated reflects whether the user sent into the thread', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  const threadA = await repo.getThread(ACCOUNT, 'thread-a');
  assert.ok(threadA);
  assert.equal(threadA.msg_count, 2);
  assert.equal(threadA.user_participated, 1, 'user replied into thread A');
  assert.equal(threadA.subject, 'Re: Deposit terms', 'newest subject wins');
  const participantsA = JSON.parse(threadA.participants_json);
  assert.ok(participantsA.includes('jordan@partner.example.com'));

  const threadB = await repo.getThread(ACCOUNT, 'thread-b');
  assert.equal(threadB.user_participated, 1, 'user initiated thread B');

  // The newsletter thread has no user-sent message.
  const threadN = await repo.getThread(ACCOUNT, 'thread-n');
  assert.ok(threadN);
  assert.equal(threadN.user_participated, 0, 'no user mail in the list thread');
  assert.equal(threadN.unread_count, 1, 'unread snapshot rolled into the thread');
});

test('aggregation is idempotent + re-runnable (no duplicates, stable counts)', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  const first = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');

  await aggregateAccount(repo, ACCOUNT, [ME]);
  const second = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');

  assert.deepEqual(second, first, 're-running aggregation converges');
  const count = (await repo.driver
    .prepare('SELECT count(*) c FROM contacts WHERE account = ?')
    .get(ACCOUNT)) as { c: number };
  assert.equal(count.c, 3, 'Jordan, Casey, newsletter — no duplicates');
});

test('aggregation preserves user-owned curation across a rebuild', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);

  // The user curates Jordan as important and tags the partner domain.
  await repo.upsertContact({ account: ACCOUNT, address: 'jordan@partner.example.com', curation: 'important' });
  await repo.setDomainCategory({ account: ACCOUNT, domain: 'partner.example.com', category: 'travel operator' });

  // A later sync re-aggregates — curation must survive.
  await aggregateAccount(repo, ACCOUNT, [ME]);
  assert.equal((await repo.getContact(ACCOUNT, 'jordan@partner.example.com'))?.curation, 'important');
  assert.equal((await repo.getDomain(ACCOUNT, 'partner.example.com'))?.category, 'travel operator');
});

test('aggregation drops contacts whose mail no longer aggregates', async () => {
  const repo = await freshRepo();
  await seedConversation(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  assert.ok(await repo.getContact(ACCOUNT, 'casey@vendor.example.com'));

  // Delete Casey's only message, then re-aggregate.
  await repo.driver.prepare(`DELETE FROM messages WHERE account = ? AND gmail_message_id = 'b-sent'`).run(ACCOUNT);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  assert.equal(
    await repo.getContact(ACCOUNT, 'casey@vendor.example.com'),
    undefined,
    'a contact with no remaining mail is removed',
  );
});

test('computeAggregates is pure and order-tolerant on equal timestamps', async () => {
  // Two sent messages to the same fresh recipient in one thread, same time —
  // exactly one should count as initiated (the thread is started once).
  const rows = [
    {
      account: ACCOUNT, gmail_message_id: 's1', thread_id: 't', internal_date: 100,
      date_header: null, from_addr: `<${ME}>`, to_addr: '<x@d.com>', cc_addr: null,
      subject: 'hi', category: null, is_list: 0, direction: 'sent',
      unread: 0, starred: 0, important: 0,
    },
    {
      account: ACCOUNT, gmail_message_id: 's2', thread_id: 't', internal_date: 100,
      date_header: null, from_addr: `<${ME}>`, to_addr: '<x@d.com>', cc_addr: null,
      subject: 'hi again', category: null, is_list: 0, direction: 'sent',
      unread: 0, starred: 0, important: 0,
    },
  ];
  const agg = computeAggregates(rows, [ME]);
  const x = agg.contacts.find((c) => c.address === 'x@d.com');
  assert.ok(x);
  assert.equal(x.msgsSent, 2);
  assert.equal(x.initiatedCount, 1, 'thread initiated exactly once');
});

// ---- part (a): Sent-mail coverage via the full sync ----------------------

test('full sync indexes Sent mail (direction=sent) and aggregates it', async () => {
  const repo = await freshRepo();
  const source = new FakeMailSource(DEFAULT_FIXTURES);
  await syncMetadata({ account: ACCOUNT, source, repo });

  // The Sent fixture landed with direction=sent (part a).
  const sent = await repo.getMessage(ACCOUNT, 'fixt-sent-1');
  assert.ok(sent);
  assert.equal(sent.direction, 'sent');

  // Sync ran the aggregation pass: Jordan is a Correspondent (the user sent to
  // him), and the fixture thread is user_participated.
  const jordan = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');
  assert.ok(jordan, 'aggregation ran as part of sync');
  assert.equal(jordan.msgs_sent, 1, 'Sent fixture credited as a sent message');
  assert.ok((await repo.listCorrespondents(ACCOUNT)).some((c) => c.address === 'jordan@partner.example.com'));

  const thread = await repo.getThread(ACCOUNT, 'thread-direct-1');
  assert.ok(thread);
  assert.equal(thread.user_participated, 1, 'the user sent into this thread');
});

test('sync --include-sent=false still aggregates received-only mail', async () => {
  const repo = await freshRepo();
  const source = new FakeMailSource(DEFAULT_FIXTURES);
  await syncMetadata({ account: ACCOUNT, source, repo, scope: { includeSent: false } });

  // No Sent message indexed → Jordan has no sent credit, is not a Correspondent.
  assert.equal(await repo.getMessage(ACCOUNT, 'fixt-sent-1'), undefined);
  const jordan = await repo.getContact(ACCOUNT, 'jordan@partner.example.com');
  assert.ok(jordan, 'still a contact from the received message');
  assert.equal(jordan.msgs_sent, 0);
  assert.equal((await repo.listCorrespondents(ACCOUNT)).length, 0, 'no Correspondents without Sent mail');
});

test('sync with aggregate:false leaves derived tables empty', async () => {
  const repo = await freshRepo();
  const source = new FakeMailSource(DEFAULT_FIXTURES);
  await syncMetadata({ account: ACCOUNT, source, repo, aggregate: false });
  assert.ok(await repo.countMessages(ACCOUNT) > 0, 'messages still indexed');
  const count = (await repo.driver.prepare('SELECT count(*) c FROM contacts WHERE account = ?').get(ACCOUNT)) as { c: number };
  assert.equal(count.c, 0, 'aggregation skipped on request');
});
