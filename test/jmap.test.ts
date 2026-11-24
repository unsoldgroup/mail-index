import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runMailSourceContract } from '../dist/source/contract.js';
import { JmapAdapter, createJmapRunner, jmapDate } from '../dist/source/adapters/jmap/index.js';
import { JMAP_CONTRACT_FIXTURES, JMAP_SESSION_URL, makeJmapFixtureFetch } from '../dist/source/adapters/jmap/fixtures.js';

const source = (fetchImpl = makeJmapFixtureFetch(), password = 'app-password') =>
  new JmapAdapter({ fetchImpl, sessionUrl: JMAP_SESSION_URL, credentials: async () => ({ username: 'you@example.com', password }), pageSize: 2 });

runMailSourceContract(test, () => source(), JMAP_CONTRACT_FIXTURES);

test('JMAP maps mailbox roles and $seen to Gmail-style labels', async () => {
  const [direct, list, sent] = await source().getMetadata(['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1']);
  assert.deepEqual(direct?.labels, ['INBOX']);
  assert.deepEqual(list?.labels, ['INBOX', 'UNREAD']);
  assert.deepEqual(sent?.labels, ['SENT']);
});

test('JMAP metadata carries addresses, RFC Message-ID, thread and the full header bag', async () => {
  const [direct, list, sent] = await source().getMetadata(['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1']);
  assert.equal(direct?.from, 'Alex Rivera <alex@example.org>');
  assert.equal(direct?.to, 'you@example.com');
  assert.equal(direct?.messageId, '<direct-1@example.org>');
  assert.equal(direct?.threadId, 'thr-direct');
  assert.equal(direct?.internalDate, Date.parse('2026-11-20T15:04:05Z'));
  assert.equal(direct?.dateHeader, 'Thu, 20 Nov 2026 15:04:05 +0000');
  assert.equal(list?.from, '"News, Weekly" <news@example.org>');
  assert.equal(list?.headers?.['List-Id'], '<weekly.example.org>');
  assert.equal(sent?.cc, 'ops@example.org');
});

test('JMAP getFull returns raw text and html bodies', async () => {
  const direct = await source().getFull('fixt-direct-1');
  assert.equal(direct?.bodyText, 'Hi, the deposit is due Friday.');
  assert.equal(direct?.bodyHtml, null);
  assert.equal(direct?.mimeType, 'text/plain');
  const list = await source().getFull('fixt-list-1');
  assert.equal(list?.bodyText, null);
  assert.equal(list?.bodyHtml, '<p>This week in travel</p>');
  assert.equal(list?.mimeType, 'text/html');
});

test('JMAP listIds builds the filter, sorts newest-first and pages by position', async () => {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const ids: string[] = [];
  for await (const id of source(makeJmapFixtureFetch({ calls })).listIds({ includeSent: false, since: '2026-01-01', until: '2026-12-01', query: 'deposit' })) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1', 'fixt-list-1']);
  const queries = calls.filter((c) => c.method === 'Email/query');
  assert.deepEqual(queries[0]?.args['filter'], { text: 'deposit', after: '2026-01-01T00:00:00Z', before: '2026-12-01T00:00:00Z', inMailboxOtherThan: ['mb-sent'] });
  assert.deepEqual(queries[0]?.args['sort'], [{ property: 'receivedAt', isAscending: false }]);
  assert.deepEqual(queries.map((q) => q.args['position']), [0, 2]);
});

test('JMAP check reports a failed login instead of throwing', async () => {
  const identity = await source(makeJmapFixtureFetch(), 'wrong').check();
  assert.equal(identity.ok, false);
  assert.match(identity.reason ?? '', /401/);
});

test('JMAP adapter is read-only: no modify or createDraft', () => {
  const adapter = source();
  assert.equal('modify' in adapter, false);
  assert.equal('createDraft' in adapter, false);
});

test('the JMAP runner refuses every write method before any request', async () => {
  let requests = 0;
  const run = createJmapRunner((async () => { requests += 1; return Response.json({}); }) as typeof fetch, async () => 'Basic x');
  for (const method of ['Email/set', 'EmailSubmission/set', 'Email/import', 'Mailbox/set']) {
    await assert.rejects(run('https://mail.example.com/jmap/', { using: [], methodCalls: [[method, {}, '0']] }), /read-only/);
  }
  assert.equal(requests, 0);
});

test('jmapDate handles relative tokens and strips fractional seconds', () => {
  const now = Date.parse('2026-11-24T12:00:00.500Z');
  assert.equal(jmapDate('30d', now), '2026-10-25T12:00:00Z');
  assert.equal(jmapDate('1mo', now), '2026-10-25T12:00:00Z');
  assert.equal(jmapDate('2026-11-01T10:20:30.999Z'), '2026-11-01T10:20:30Z');
  assert.throws(() => jmapDate('soon'));
});
