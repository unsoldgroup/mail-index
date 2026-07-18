/**
 * Curate wizard tests (SCOPE 3.3, PLAN §11, D14).
 *
 * The wizard is the no-agent FALLBACK curation path: it walks the same
 * `await propose()` shortlist by hand and persists via `await set()`. The agent-mediated
 * MCP loop is primary (D14), so these tests cover the DECISION-APPLICATION CORE
 * (`runCurate` driven by an injected scripted Prompter) — the readline glue is
 * thin and untested by design. Asserts: a scripted walk persists the right
 * contact/domain curation + keywords; Enter accepts the index suggestion; quit
 * aborts the remaining walk but still applies prior decisions; the helper
 * parsers (parseDecision / parseKeywords) behave. Tests import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { aggregateAccount } from '../dist/intelligence/aggregate.js';
import { interestPass } from '../dist/intelligence/interest.js';
import { get } from '../dist/curation/index.js';
import { runCurate, parseDecision, parseKeywords } from '../dist/cli/curate.js';

const ACCOUNT = 'test-acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15));
const RECENT = NOW.getTime() - 86_400_000;

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
    bodyState: 'meta',
  });
}

/** Seed two contacts (Jordan = engaged, Digest = bulk) + their domains. */
async function seedMailbox(repo) {
  await seed(repo, {
    id: 'j1', threadId: 't-j', internalDate: RECENT - 2000,
    from: 'Jordan <jordan@partner.example.com>', to: ME, subject: 'logistics', direction: 'received',
  });
  await seed(repo, {
    id: 'j2', threadId: 't-j', internalDate: RECENT - 1000,
    from: ME, to: 'jordan@partner.example.com', subject: 're: logistics', direction: 'sent',
  });
  for (let i = 0; i < 3; i += 1) {
    await seed(repo, {
      id: `n${i}`, threadId: `t-n${i}`, internalDate: RECENT - i * 1000,
      from: 'Digest <digest@news.example.com>', to: ME, subject: `weekly ${i}`,
      direction: 'received', isList: true, category: 'promotions', unread: true,
    });
  }
  await aggregateAccount(repo, ACCOUNT);
  await interestPass(repo, ACCOUNT, { now: NOW });
}

/**
 * A scripted {@link Prompter}: returns the queued answers in order (throws if
 * the wizard asks more questions than scripted), and records every line written
 * so a test can assert on the walk output.
 */
function scriptedPrompter(answers) {
  const queue = [...answers];
  const lines = [];
  return {
    prompter: {
      ask(_q) {
        if (queue.length === 0) throw new Error('scripted prompter ran out of answers');
        return Promise.resolve(queue.shift());
      },
      write(line) {
        lines.push(line);
      },
    },
    lines,
    remaining: () => queue.length,
  };
}

test('parseDecision: explicit answers map to decisions', async () => {
  assert.equal(parseDecision('k', 'none'), 'keep');
  assert.equal(parseDecision('mute', 'none'), 'mute');
  assert.equal(parseDecision('I', 'none'), 'important');
  assert.equal(parseDecision('s', 'important'), 'skip');
  assert.equal(parseDecision('quit', 'none'), 'quit');
  assert.equal(parseDecision('garbage', 'none'), 'skip', 'unrecognised → skip');
});

test('parseDecision: empty line accepts the index suggestion', async () => {
  assert.equal(parseDecision('', 'important'), 'important');
  assert.equal(parseDecision('  ', 'muted'), 'mute');
  assert.equal(parseDecision('', 'none'), 'skip');
});

test('parseKeywords: splits, trims, drops empties, de-dupes', async () => {
  assert.deepEqual(parseKeywords('antarctica, charter ,  , Antarctica'), ['antarctica', 'charter']);
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords('  solo  '), ['solo']);
});

test('runCurate: a scripted walk persists contact + domain curation + keywords', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);

  // Shortlist order: contacts by engagement desc (Jordan first, Digest second),
  // then domains. Answers: Jordan→important, Digest→mute, then each domain
  // accept-suggestion (Enter), then keywords.
  const proposal = await repo.curationContacts(ACCOUNT, 20);
  assert.ok(proposal.length >= 2, 'two contacts proposed');

  const domainCount = (await repo.curationDomains(ACCOUNT, 20)).length;
  const answers = [
    'important', // Jordan
    'mute', // Digest
    ...Array(domainCount).fill(''), // accept each domain's suggestion
    'antarctica, charter', // keywords
  ];
  const { prompter } = scriptedPrompter(answers);

  const result = await runCurate(repo, ACCOUNT, prompter, { at: NOW.toISOString() });

  assert.equal(result.contactsDecided, 2);
  assert.deepEqual(result.keywords, ['antarctica', 'charter']);
  assert.equal(result.quit, false);

  // Round-trip via await get(): Jordan important, Digest muted, keywords persisted.
  const profile = await get(repo, ACCOUNT);
  const jordan = profile.contacts.find((c) => c.address === 'jordan@partner.example.com');
  const digest = profile.contacts.find((c) => c.address === 'digest@news.example.com');
  assert.equal(jordan?.curation, 'important');
  assert.equal(digest?.curation, 'muted');
  assert.deepEqual(profile.keywords, ['antarctica', 'charter']);
  assert.equal(profile.updatedAt, NOW.toISOString());
});

test('runCurate: Enter accepts the index-suggested action', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);

  // Accept every suggestion via Enter; supply a blank keyword line (unchanged).
  const contactCount = (await repo.curationContacts(ACCOUNT, 20)).length;
  const domainCount = (await repo.curationDomains(ACCOUNT, 20)).length;
  const answers = [...Array(contactCount + domainCount).fill(''), ''];
  const { prompter } = scriptedPrompter(answers);

  await runCurate(repo, ACCOUNT, prompter, { at: NOW.toISOString() });

  const profile = await get(repo, ACCOUNT);
  // Jordan's score suggests important; Digest (bulk, never-opened) suggests muted.
  const jordan = profile.contacts.find((c) => c.address === 'jordan@partner.example.com');
  const digest = profile.contacts.find((c) => c.address === 'digest@news.example.com');
  assert.equal(jordan?.curation, 'important', 'Enter accepted the important suggestion');
  assert.equal(digest?.curation, 'muted', 'Enter accepted the muted suggestion');
  // Blank keyword line leaves the (empty) keyword set untouched.
  assert.deepEqual(profile.keywords, []);
});

test('runCurate: quit aborts the remaining walk but applies prior decisions', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);

  // First contact (Jordan) → important, then quit before the rest.
  const { prompter } = scriptedPrompter(['important', 'quit']);
  const result = await runCurate(repo, ACCOUNT, prompter, { at: NOW.toISOString() });

  assert.equal(result.quit, true);
  assert.equal(result.contactsDecided, 1, 'only the pre-quit decision applied');
  assert.equal(result.domainsDecided, 0, 'never reached domains');

  const profile = await get(repo, ACCOUNT);
  assert.equal(profile.contacts.find((c) => c.address === 'jordan@partner.example.com')?.curation, 'important');
  // Quit before keywords → keyword set untouched, no keyword write happened.
  assert.equal(result.applied.keywordsSet, false);
});

test('runCurate: skip leaves an entity untouched', async () => {
  const repo = await freshRepo();
  await seedMailbox(repo);

  // Skip Jordan, mute Digest, accept domains, blank keywords.
  const domainCount = (await repo.curationDomains(ACCOUNT, 20)).length;
  const { prompter } = scriptedPrompter(['skip', 'mute', ...Array(domainCount).fill(''), '']);
  await runCurate(repo, ACCOUNT, prompter, { at: NOW.toISOString() });

  const profile = await get(repo, ACCOUNT);
  assert.equal(
    profile.contacts.find((c) => c.address === 'jordan@partner.example.com'),
    undefined,
    'skipped contact carries no curation',
  );
  assert.equal(profile.contacts.find((c) => c.address === 'digest@news.example.com')?.curation, 'muted');
});
