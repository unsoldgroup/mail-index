/**
 * Recorded JMAP fixtures: a direct, a list, and a sent message in the shape a
 * Stalwart server returns them, plus a fetch stub that replays a JMAP session
 * and the `Mailbox/get` / `Email/query` / `Email/get` methods over them.
 * Synthetic data only (example.com / example.org).
 */
import type { MailSourceFixtures } from '../../fixtures/index.js';
import type { MessageFull } from '../../index.js';
import type { JmapEmail } from './index.js';

const ADDRESS = 'you@example.com';
const MAILBOXES = [
  { id: 'mb-inbox', role: 'inbox' },
  { id: 'mb-sent', role: 'sent' },
  { id: 'mb-junk', role: 'junk' },
  { id: 'mb-projects', role: null },
];

const h = (name: string, value: string) => ({ name, value: ` ${value}` });

/** Newest first, as Email/query sorted by receivedAt desc returns them. */
export const JMAP_EMAILS: JmapEmail[] = [
  {
    id: 'fixt-direct-1', threadId: 'thr-direct', mailboxIds: { 'mb-inbox': true, 'mb-projects': true }, keywords: { $seen: true },
    receivedAt: '2026-11-20T15:04:05Z', size: 2048, preview: 'The deposit is due Friday.', subject: 'Deposit for the March trip',
    from: [{ name: 'Alex Rivera', email: 'alex@example.org' }], to: [{ name: null, email: ADDRESS }], cc: null, replyTo: null,
    messageId: ['direct-1@example.org'],
    headers: [h('Date', 'Thu, 20 Nov 2026 15:04:05 +0000'), h('From', 'Alex Rivera <alex@example.org>'), h('To', ADDRESS), h('Subject', 'Deposit for the March trip')],
    bodyValues: { '1': { value: 'Hi, the deposit is due Friday.' } }, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
  },
  {
    id: 'fixt-list-1', threadId: 'thr-list', mailboxIds: { 'mb-inbox': true }, keywords: {},
    receivedAt: '2026-11-19T08:00:00Z', size: 9000, preview: 'This week in travel', subject: 'Weekly digest',
    from: [{ name: 'News, Weekly', email: 'news@example.org' }], to: [{ email: ADDRESS }], cc: null, replyTo: null,
    messageId: ['list-1@example.org'],
    headers: [h('Date', 'Wed, 19 Nov 2026 08:00:00 +0000'), h('List-Id', '<weekly.example.org>'), h('List-Unsubscribe', '<https://example.org/u>')],
    bodyValues: { '2': { value: '<p>This week in travel</p>' } }, textBody: [{ partId: '2', type: 'text/html' }], htmlBody: [{ partId: '2', type: 'text/html' }],
  },
  {
    id: 'fixt-sent-1', threadId: 'thr-direct', mailboxIds: { 'mb-sent': true }, keywords: { $seen: true },
    receivedAt: '2026-11-18T10:00:00Z', size: 1024, preview: 'Thanks, will pay Friday.', subject: 'Re: Deposit for the March trip',
    from: [{ email: ADDRESS }], to: [{ name: 'Alex Rivera', email: 'alex@example.org' }], cc: [{ email: 'ops@example.org' }], replyTo: null,
    messageId: ['sent-1@example.com'],
    headers: [h('Date', 'Tue, 18 Nov 2026 10:00:00 +0000'), h('In-Reply-To', '<direct-1@example.org>')],
    bodyValues: { '1': { value: 'Thanks, will pay Friday.' } }, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [],
  },
];

/** The contract suite reads only `address` and the message ids. */
export const JMAP_CONTRACT_FIXTURES: MailSourceFixtures = {
  address: ADDRESS,
  messages: JMAP_EMAILS.map((e) => ({ id: e.id }) as MessageFull),
};

export const JMAP_SESSION_URL = 'https://mail.example.com/.well-known/jmap';

/** A fetch stub that serves the fixtures as a JMAP server would. `calls` records each method call. */
export function makeJmapFixtureFetch(options: { calls?: { method: string; args: Record<string, unknown> }[]; password?: string } = {}): typeof fetch {
  const expected = `Basic ${Buffer.from(`${ADDRESS}:${options.password ?? 'app-password'}`).toString('base64')}`;
  return (async (input, init) => {
    if (new Headers(init?.headers).get('authorization') !== expected) return new Response('Unauthorized', { status: 401 });
    const url = String(input);
    if (url === JMAP_SESSION_URL) {
      return Response.json({ apiUrl: '/jmap/', username: ADDRESS, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' }, accounts: { acc1: { name: ADDRESS } } });
    }
    const request = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    const [method, args, tag] = request.methodCalls[0]!;
    options.calls?.push({ method, args });
    let result: unknown;
    if (method === 'Mailbox/get') result = { list: MAILBOXES };
    else if (method === 'Email/query') {
      const filter = (args['filter'] ?? {}) as { inMailboxOtherThan?: string[] };
      const ids = JMAP_EMAILS.filter((e) => !filter.inMailboxOtherThan?.some((m) => e.mailboxIds?.[m])).map((e) => e.id);
      const position = Number(args['position'] ?? 0);
      result = { ids: ids.slice(position, position + Number(args['limit'])), position };
    } else if (method === 'Email/get') {
      const ids = args['ids'] as string[];
      const props = args['properties'] as string[];
      const found = JMAP_EMAILS.filter((e) => ids.includes(e.id));
      result = {
        list: found.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => props.includes(k)))),
        notFound: ids.filter((id) => !found.some((e) => e.id === id)),
      };
    } else return Response.json({ methodResponses: [['error', { type: 'unknownMethod' }, tag]] });
    return Response.json({ methodResponses: [[method, result, tag]] });
  }) as typeof fetch;
}
