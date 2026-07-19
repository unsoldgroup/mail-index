/**
 * Curation core tests (SCOPE 3.1, PLAN §11, D13/D14, CONTEXT.md "Interest
 * profile").
 *
 * The curation loop is the index half of the v1.0 thesis: the index RANKS
 * (propose — the seed, D13) and the human DISPOSES (set), round-trippable via
 * get. The tests seed a tmp DB, aggregate + score it, then assert:
 *
 *  - await propose() ranks contacts by engagement_score with a suggested action that
 *    tracks the score (Correspondent → important, never-opened bulk → muted),
 *    and is token-conscious (compact shapes, default + explicit limits);
 *  - await set() persists contact/domain curation + keywords, bumps updated_at, is
 *    atomic and idempotent; a missing contact is a no-op, a domain upserts;
 *  - await get() reflects exactly what await set() wrote and round-trips it;
 *  - INDEX-ONLY: propose/set/get touch no provider (the tmp DB has none).
 *
 * Tests import the compiled output; `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import {
  propose,
  set,
  get,
  suggestAction,
  SUGGEST_IMPORTANT_AT,
  SUGGEST_MUTED_AT,
} from '../dist/curation/index.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15)); // fixed clock for deterministic recency

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
    starred: m.starred ?? false,
    important: m.important ?? false,
    snippet: m.snippet ?? null,
    bodyState: 'meta',
  });
}

const RECENT = NOW.getTime() - 86_400_000; // yesterday

/**
 * Seed a mailbox with three contacts that span the score range:
 *  - Jordan: an engaged Correspondent (user replied + initiated, all read).
 *  - News: a never-opened newsletter (all unread, is_list) — net-negative.
 *  - Casey: a middling read-but-quiet contact (read, no reply).
 * Plus two domains via the contacts' addresses.
 */
async function seedMailbox(repo) {
  // Jordan thread: Jordan writes first, user replies (Correspondent).
  await seed(repo, {
    id: 'j1', threadId: 't-j', internalDate: RECENT - 2000,
    from: 'Jordan <jordan@partner.example.com>', to: ME,
    subject: 'logistics', direction: 'received', important: true,
  });
  await seed(repo, {
    id: 'j2', threadId: 't-j', internalDate: RECENT - 1000,
    from: ME, to: 'jordan@partner.example.com',
    subject: 're: logistics', direction: 'sent',
  });
  await seed(repo, {
    id: 'j3', threadId: 't-j2', internalDate: RECENT,
    from: ME, to: 'jordan@partner.example.com',
    subject: 'new plan', direction: 'sent',
  });

  // Newsletter: three received, all unread, is_list (never-opened bulk).
  for (let i = 0; i < 3; i += 1) {
    await seed(repo, {
      id: `n${i}`, threadId: `t-n${i}`, internalDate: RECENT - i * 1000,
      from: 'Digest <digest@news.example.com>', to: ME,
      subject: `weekly ${i}`, direction: 'received',
      isList: true, category: 'promotions', unread: true,
    });
  }

  // Casey: two received, read, no reply (middling).
  await seed(repo, {
    id: 'c1', threadId: 't-c', internalDate: RECENT - 500,
    from: 'Casey <casey@vendor.example.com>', to: ME,
    subject: 'invoice', direction: 'received',
  });
  await seed(repo, {
    id: 'c2', threadId: 't-c2', internalDate: RECENT - 400,
    from: 'Casey <casey@vendor.example.com>', to: ME,
    subject: 'reminder', direction: 'received',
  });
}

async function scoredRepo() {
  const repo = await freshRepo();
  await seedMailbox(repo);
  await aggregateAccount(repo, ACCOUNT, [ME]);
  await interestPass(repo, ACCOUNT, { now: NOW });
  return repo;
}

// ---- suggestAction (pure) -------------------------------------------------

test('suggestAction maps the score range to actions (D13)', async () => {
  assert.equal(suggestAction(SUGGEST_IMPORTANT_AT + 1), 'important');
  assert.equal(suggestAction(SUGGEST_MUTED_AT - 1), 'muted');
  assert.equal(suggestAction(0), 'none', 'a middling score defers to the human');
  assert.equal(suggestAction(null), 'none', 'an unscored row has no prior');
  assert.equal(suggestAction(0, true), 'muted', 'predominantly-bulk nudges to muted');
});

// ---- propose --------------------------------------------------------------

test('propose ranks contacts by engagement_score with suggested actions', async () => {
  const repo = await scoredRepo();
  const { contacts } = await propose(repo, ACCOUNT);

  const jordan = contacts.find((c) => c.address === 'jordan@partner.example.com');
  const news = contacts.find((c) => c.address === 'digest@news.example.com');
  const casey = contacts.find((c) => c.address === 'casey@vendor.example.com');
  assert.ok(jordan && news && casey, 'all three contacts present');

  // Score ordering: engaged Correspondent > middling > never-opened bulk.
  assert.ok(jordan.engagementScore > casey.engagementScore);
  assert.ok(casey.engagementScore > news.engagementScore);

  // The shortlist is ordered by score descending.
  const idxJordan = contacts.indexOf(jordan);
  const idxNews = contacts.indexOf(news);
  assert.ok(idxJordan < idxNews, 'Jordan ranks above the newsletter');

  // Suggested actions track the score (D13).
  assert.equal(jordan.suggested, 'important', 'engaged Correspondent → important');
  assert.equal(news.suggested, 'muted', 'never-opened bulk → muted');
  assert.equal(jordan.curation, null, 'no prior curation yet');

  // The newsletter is flagged predominantly-bulk.
  assert.equal(news.isList, true);
  assert.equal(jordan.isList, false);
});

test('propose carries compact, token-conscious stats and respects limits', async () => {
  const repo = await scoredRepo();
  const full = await propose(repo, ACCOUNT);
  assert.ok(full.contacts.length >= 3);

  // Read-rate is a rounded rate; Jordan (no received-from in this fixture is
  // read) — assert shape, not exact value.
  const jordan = full.contacts.find((c) => c.address === 'jordan@partner.example.com');
  assert.equal(typeof jordan.msgsReceived, 'number');
  assert.equal(typeof jordan.msgsSent, 'number');
  assert.ok(jordan.readRate === null || (jordan.readRate >= 0 && jordan.readRate <= 1));
  // Scores are rounded to 2 decimals (compact).
  assert.ok(Number.isFinite(jordan.engagementScore));
  assert.equal(Math.round(jordan.engagementScore * 100) / 100, jordan.engagementScore);

  // Explicit limit shrinks the shortlist.
  const capped = await propose(repo, ACCOUNT, { contactLimit: 1, domainLimit: 1 });
  assert.equal(capped.contacts.length, 1);
  assert.ok(capped.domains.length <= 1);
  // The single contact is the top-ranked one.
  assert.equal(capped.contacts[0].address, 'jordan@partner.example.com');
});

test('propose ranks domains and never returns a bare empty set when data exists', async () => {
  const repo = await scoredRepo();
  const { domains } = await propose(repo, ACCOUNT);
  assert.ok(domains.length >= 3, 'all sender domains surface');
  const names = domains.map((d) => d.domain);
  assert.ok(names.includes('partner.example.com'));
  assert.ok(names.includes('news.example.com'));
  assert.ok(names.includes('vendor.example.com'));
  // Each domain carries its volume + a suggested action.
  for (const d of domains) {
    assert.equal(typeof d.msgs, 'number');
    assert.ok(['important', 'muted', 'none'].includes(d.suggested));
  }
});

test('propose on an empty account returns empty arrays (no throw)', async () => {
  const repo = await freshRepo();
  const p = await propose(repo, ACCOUNT);
  assert.deepEqual(p.contacts, []);
  assert.deepEqual(p.domains, []);
});

// ---- set ------------------------------------------------------------------

test('set persists contact + domain curation and keywords, bumping updated_at', async () => {
  const repo = await scoredRepo();
  const at = '2026-06-15T00:00:00.000Z';
  const result = await set(
    repo,
    ACCOUNT,
    {
      contacts: [
        { address: 'jordan@partner.example.com', curation: 'important' },
        { address: 'digest@news.example.com', curation: 'muted' },
      ],
      domains: [{ domain: 'news.example.com', curation: 'muted' }],
      keywords: ['antarctica logistics', 'expedition insurance'],
    },
    { at },
  );

  assert.equal(result.contactsSet, 2);
  assert.equal(result.domainsSet, 1);
  assert.equal(result.keywordsSet, true);
  assert.equal(result.updatedAt, at);

  // Persisted onto the durable rows.
  assert.equal((await repo.getContact(ACCOUNT, 'jordan@partner.example.com')).curation, 'important');
  assert.equal((await repo.getDomain(ACCOUNT, 'news.example.com')).curation, 'muted');
  const profile = await repo.getInterestProfile(ACCOUNT);
  assert.deepEqual(profile.keywords, ['antarctica logistics', 'expedition insurance']);
  assert.equal(profile.updated_at, at);
});

test('set on a missing contact is a no-op; a domain upserts a fresh row', async () => {
  const repo = await scoredRepo();
  const result = await set(repo, ACCOUNT, {
    contacts: [{ address: 'ghost@nobody.example.com', curation: 'important' }],
    domains: [{ domain: 'brandnew.example.com', curation: 'blocked' }],
  });
  assert.equal(result.contactsSet, 0, 'missing contact is skipped');
  assert.equal(result.domainsSet, 1);
  // The domain row now exists with the curation, even though no mail aggregated.
  assert.equal((await repo.getDomain(ACCOUNT, 'brandnew.example.com')).curation, 'blocked');
});

test('set is idempotent and a null curation clears a prior label', async () => {
  const repo = await scoredRepo();
  await set(repo, ACCOUNT, {
    contacts: [{ address: 'jordan@partner.example.com', curation: 'important' }],
  });
  // Re-apply: same state.
  await set(repo, ACCOUNT, {
    contacts: [{ address: 'jordan@partner.example.com', curation: 'important' }],
  });
  assert.equal((await repo.getContact(ACCOUNT, 'jordan@partner.example.com')).curation, 'important');
  // Clear it.
  await set(repo, ACCOUNT, {
    contacts: [{ address: 'jordan@partner.example.com', curation: null }],
  });
  assert.equal((await repo.getContact(ACCOUNT, 'jordan@partner.example.com')).curation, null);
});

test('set without keywords leaves the stored keywords untouched', async () => {
  const repo = await scoredRepo();
  const at = '2026-06-15T00:00:00.000Z';
  await set(repo, ACCOUNT, { keywords: ['kept'] }, { at });
  const result = await set(repo, ACCOUNT, {
    contacts: [{ address: 'jordan@partner.example.com', curation: 'important' }],
  });
  assert.equal(result.keywordsSet, false);
  assert.equal(result.updatedAt, at, 'updated_at unchanged when keywords not written');
  assert.deepEqual((await repo.getInterestProfile(ACCOUNT)).keywords, ['kept']);
});

// ---- get (round-trips set) ------------------------------------------------

test('get reflects exactly what set wrote', async () => {
  const repo = await scoredRepo();
  const at = '2026-06-15T00:00:00.000Z';
  await set(
    repo,
    ACCOUNT,
    {
      contacts: [
        { address: 'jordan@partner.example.com', curation: 'important' },
        { address: 'digest@news.example.com', curation: 'muted' },
      ],
      domains: [{ domain: 'news.example.com', curation: 'muted' }],
      keywords: ['antarctica'],
    },
    { at },
  );

  const profile = await get(repo, ACCOUNT);
  assert.equal(profile.account, ACCOUNT);
  assert.deepEqual(profile.keywords, ['antarctica']);
  assert.equal(profile.updatedAt, at);
  assert.deepEqual(
    profile.contacts,
    [
      { address: 'digest@news.example.com', curation: 'muted' },
      { address: 'jordan@partner.example.com', curation: 'important' },
    ],
    'curated contacts ordered by address',
  );
  assert.deepEqual(profile.domains, [{ domain: 'news.example.com', curation: 'muted' }]);
});

test('get on a never-curated account returns an empty profile', async () => {
  const repo = await scoredRepo();
  const profile = await get(repo, ACCOUNT);
  assert.deepEqual(profile.contacts, []);
  assert.deepEqual(profile.domains, []);
  assert.deepEqual(profile.keywords, []);
  assert.equal(profile.updatedAt, null);
});

test('set rejects an invalid curation label', async () => {
  const repo = await scoredRepo();
  await assert.rejects(
    async () =>
      await set(repo, ACCOUNT, {
        contacts: [{ address: 'jordan@partner.example.com', curation: 'bogus' }],
      }),
    /invalid curation/,
  );
});
