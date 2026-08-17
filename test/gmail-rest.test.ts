import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GmailRestAdapter } from '../dist/source/adapters/gmail-rest/index.js';
import { InsufficientScopeError } from '../dist/source/index.js';
import { runMailSourceContract } from '../dist/source/contract.js';
import { DEFAULT_FIXTURES } from '../dist/source/fixtures/index.js';
import { extractAttachments, extractInlineAttachment, buildGmailQuery } from '../dist/source/adapters/gmail-shared.js';

function gmailMessage(message: (typeof DEFAULT_FIXTURES.messages)[number]) {
  const encode = (text: string) => Buffer.from(text).toString('base64url');
  const headers = [
    ['Date', message.dateHeader],
    ['From', message.from],
    ['To', message.to],
    ['Cc', message.cc],
    ['Subject', message.subject],
    ['Message-ID', `<${message.id}@example.test>`],
    ...Object.entries(message.headers ?? {}),
  ]
    .filter((entry): entry is [string, string] => entry[1] != null)
    .map(([name, value]) => ({ name, value }));
  const mimeType = message.bodyText ? 'text/plain' : 'text/html';
  const text = message.bodyText ?? message.bodyHtml ?? '';
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: String(message.internalDate),
    labelIds: message.labels,
    snippet: message.snippet,
    sizeEstimate: message.sizeEstimate,
    payload: { mimeType, headers, body: { data: encode(text) } },
  };
}

function fixtureFetch(options: { readonly?: boolean; calls?: string[] } = {}): typeof fetch {
  const messages = new Map(DEFAULT_FIXTURES.messages.map((m) => [m.id, gmailMessage(m)]));
  return (async (input, init) => {
    const url = new URL(String(input));
    options.calls?.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/profile')) {
      return Response.json({ emailAddress: DEFAULT_FIXTURES.address });
    }
    if (url.pathname.endsWith('/messages')) {
      const all = DEFAULT_FIXTURES.messages.filter(
        (message) => !url.searchParams.get('q')?.includes('-in:sent') || !message.labels.includes('SENT'),
      );
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Number(url.searchParams.get('maxResults') ?? 100);
      const page = all.slice(start, start + size);
      return Response.json({
        messages: page.map(({ id, threadId }) => ({ id, threadId })),
        ...(start + page.length < all.length ? { nextPageToken: String(start + page.length) } : {}),
      });
    }
    if (url.pathname.endsWith('/labels')) {
      return Response.json({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    }
    if (url.pathname.endsWith('/attachments/att-pdf')) {
      return Response.json({ size: 8, data: Buffer.from('%PDFtest').toString('base64url') });
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (init?.method === 'POST') {
      return options.readonly
        ? Response.json({ error: { message: 'Request had insufficient authentication scopes.' } }, { status: 403 })
        : Response.json(messages.get(id));
    }
    const message = messages.get(id);
    return message ? Response.json(message) : Response.json({ error: { message: 'Not found' } }, { status: 404 });
  }) as typeof fetch;
}

const source = (fetchImpl = fixtureFetch(), pageSize = 2) =>
  new GmailRestAdapter({ fetchImpl, tokenProvider: async () => 'fixture-token', pageSize });

runMailSourceContract(test, () => source(), DEFAULT_FIXTURES);

test('Gmail REST uses the shared Gmail query shape and paginates lazily', async () => {
  const calls: string[] = [];
  const ids: string[] = [];
  for await (const id of source(fixtureFetch({ calls }), 1).listIds({
    since: '1mo',
    includeSent: false,
  })) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1', 'fixt-list-1']);
  assert.match(calls[0] ?? '', /q=newer_than%3A1m\+-in%3Asent/);
  assert.ok(calls.some((call) => call.includes('pageToken=1')));
});

test('Gmail REST lists labels and sends bearer auth through its injected fetch seam', async () => {
  const calls: string[] = [];
  const labels = await source(fixtureFetch({ calls })).listLabels();
  assert.deepEqual(labels, [{ id: 'INBOX', name: 'INBOX', type: 'system' }]);
  assert.ok(calls.some((call) => call.includes('/labels')));
});

test('Gmail REST lists attachment metadata and downloads base64 bytes', async () => {
  const calls: string[] = [];
  const fetchImpl = fixtureFetch({ calls });
  const original = DEFAULT_FIXTURES.messages[0];
  const adapter = source((async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/messages/${original.id}`)) {
      const message = gmailMessage(original);
      message.payload = {
        mimeType: 'multipart/mixed',
        headers: message.payload.headers,
        parts: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-pdf', size: 8 } }],
      };
      return Response.json(message);
    }
    return fetchImpl(input, init);
  }) as typeof fetch);
  assert.deepEqual(await adapter.listAttachments(original.id), [
    { id: 'att-pdf', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 8 },
  ]);
  assert.deepEqual(await adapter.getAttachment(original.id, 'att-pdf'), {
    data: Buffer.from('%PDFtest').toString('base64'),
    size: 8,
  });
  assert.ok(calls.some((call) => call.includes('/attachments/att-pdf')));
});

test('Gmail REST lists and downloads a named inline MIME attachment', async () => {
  const original = DEFAULT_FIXTURES.messages[0];
  const adapter = source((async () => Response.json({
    ...gmailMessage(original),
    payload: { mimeType: 'multipart/mixed', parts: [
      { filename: 'small.txt', mimeType: 'text/plain', body: { size: 5, data: Buffer.from('hello').toString('base64url') } },
    ] },
  })) as typeof fetch);
  assert.deepEqual(await adapter.listAttachments(original.id), [
    { id: 'inline:0', filename: 'small.txt', mimeType: 'text/plain', size: 5 },
  ]);
  assert.deepEqual(await adapter.getAttachment(original.id, 'inline:0'), {
    data: Buffer.from('hello').toString('base64'), size: 5,
  });
});

test('Gmail REST readonly grant surfaces InsufficientScopeError on modify', async () => {
  await assert.rejects(
    source(fixtureFetch({ readonly: true })).modify('fixt-direct-1', {
      removeLabelIds: ['INBOX'],
    }),
    (error: unknown) => error instanceof InsufficientScopeError && error.provider === 'gmail-rest',
  );
});

test('Gmail REST preserves RFC Message-ID for cross-mailbox identity', async () => {
  const message = await source().getFull('fixt-direct-1');
  assert.equal(message?.messageId, '<fixt-direct-1@example.test>');
});

test('extractAttachments preserves provider ids and inline metadata', () => {
  const attachments = extractAttachments({ mimeType: 'multipart/mixed', parts: [
    { partId: '1', filename: 'quote.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 42 } },
    { partId: '2', filename: 'logo.png', mimeType: 'image/png', body: { data: 'aGk=', size: 2 } },
  ] });
  assert.deepEqual(attachments, [
    { attachmentId: 'att-1', filename: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 42, inline: false },
    // Inline ids encode the part's PATH through the MIME tree (second child of
    // the root = "1"), not its provider partId — that is what
    // extractInlineAttachment walks back to find the bytes again.
    { attachmentId: 'inline:1', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 2, inline: true, inlineDataBase64: 'aGk=' },
  ]);
});

test('buildGmailQuery uses absolute date operators, not newer_than, for timestamps', () => {
  // Gmail's newer_than: takes a RELATIVE token only. Passing an ISO string
  // produces a term it does not honour, which silently unbounds the sweep.
  const absolute = buildGmailQuery({ since: '2025-08-17T00:00:00.000Z', until: '2026-08-17' });
  assert.match(absolute, /after:2025\/08\/17/);
  assert.match(absolute, /before:2026\/08\/17/);
  assert.ok(!absolute.includes('newer_than'), 'an absolute bound never becomes newer_than');

  const relative = buildGmailQuery({ since: '30d' });
  assert.match(relative, /newer_than:30d/, 'relative tokens still use newer_than');

  const scoped = buildGmailQuery({ since: '2025-01-01', until: '2026-01-01', query: 'in:sent' });
  assert.match(scoped, /^in:sent /, 'the caller query leads');
});

test('an inline attachment id round-trips back to its bytes', () => {
  // The listing and the fetch must agree, or an id the agent was offered
  // resolves to nothing. This is the invariant that one shared extractor buys.
  const payload = { mimeType: 'multipart/mixed', parts: [
    { partId: '1', filename: 'quote.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 42 } },
    { partId: '2', filename: 'logo.png', mimeType: 'image/png', body: { data: 'aGk=', size: 2 } },
  ] };
  const inline = extractAttachments(payload).find((a) => a.inline)!;
  const resolved = extractInlineAttachment(payload, inline.attachmentId);
  assert.equal(resolved?.data, 'aGk=');
  assert.equal(resolved?.size, 2);
});
