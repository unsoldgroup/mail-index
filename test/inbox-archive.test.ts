import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant, GMAIL_MODIFY, GMAIL_READONLY } from '../dist-worker/worker/google-oauth.js';
import { archiveInboxMessage } from '../dist-worker/worker/inbox-archive.js';

const MID = '<abc@example.com>';

/** One connected Account (acct-a / you@example.com) and a fake Gmail that only
 * knows `provider` messages for the `rfc822msgid:` fallback search. */
async function fixture(options: { allow?: string; writes?: boolean; provider?: { id: string; labels: string[] }[] } = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver);
  const env = { DB: driver.db, TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64'), GOOGLE_CLIENT_ID: 'fixture-google', GOOGLE_CLIENT_SECRET: 'fixture-secret', INBOX_ARCHIVE_ACCOUNTS: options.allow };
  const scopes = options.writes === false ? [GMAIL_READONLY] : [GMAIL_READONLY, GMAIL_MODIFY];
  await saveGrant(driver, { account: 'acct-a', address: 'you@example.com', scopes, refreshToken: 'fixture-refresh', key: env.TOKEN_ENC_KEY });
  const modified: string[] = []; const queries: string[] = [];
  const provider = options.provider ?? [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope: scopes.join(' ') });
    const modify = url.pathname.match(/\/messages\/([^/]+)\/modify$/);
    if (modify && init?.method === 'POST') { modified.push(decodeURIComponent(modify[1]!)); return Response.json({}); }
    const one = url.pathname.match(/\/messages\/([^/]+)$/);
    if (one) {
      const m = provider.find((p) => p.id === decodeURIComponent(one[1]!));
      return m ? Response.json({ id: m.id, threadId: 't', labelIds: m.labels, payload: { headers: [] } }) : Response.json({}, { status: 404 });
    }
    if (url.pathname.endsWith('/messages')) { queries.push(url.searchParams.get('q') ?? ''); return Response.json({ messages: provider.map((p) => ({ id: p.id })) }); }
    throw new Error(`Unexpected provider request ${url}`);
  }) as typeof fetch;
  const repo = new Repo(driver);
  const seed = (id: string, labels: string[]) => repo.upsertMessage({ account: 'acct-a', gmailMessageId: id, rfcMessageId: MID, threadId: 't', internalDate: Date.now(), labels, direction: 'received', snippet: 'x', bodyText: null, bodyState: 'meta' });
  const labelsOf = async (id: string) => JSON.parse(((await driver.prepare('SELECT labels_json FROM messages WHERE gmail_message_id=?').get(id)) as { labels_json: string }).labels_json) as string[];
  const archive = (input: unknown) => archiveInboxMessage(env as never, input, fetchImpl);
  return { mf, modified, queries, seed, labelsOf, archive };
}

test('disabled when INBOX_ARCHIVE_ACCOUNTS is unset or empty', async () => {
  for (const allow of [undefined, ' , ']) {
    const f = await fixture({ allow }); try {
      assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'disabled' });
      assert.equal(f.modified.length, 0);
    } finally { await f.mf.dispose(); }
  }
});

test('account_not_allowed for an unlisted or unconnected account', async () => {
  const f = await fixture({ allow: 'acct-b' }); try {
    assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'account_not_allowed' });
    assert.deepEqual(await f.archive({ account: 'acct-b', rfcMessageId: MID }), { status: 'account_not_allowed' });
    assert.equal(f.modified.length, 0);
  } finally { await f.mf.dispose(); }
});

test('invalid ids and inputs are rejected before any lookup', async () => {
  const f = await fixture({ allow: 'acct-a' }); try {
    for (const rfcMessageId of ['abc@example.com', '<abc@example.com>\r\nBcc: x', '<a\nb>', `<${'a'.repeat(997)}>`, '', 42]) {
      assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId }), { status: 'invalid' });
    }
    assert.deepEqual(await f.archive({ account: '', rfcMessageId: MID }), { status: 'invalid' });
    assert.deepEqual(await f.archive(null), { status: 'invalid' });
    assert.equal(f.queries.length + f.modified.length, 0);
  } finally { await f.mf.dispose(); }
});

test('not_found when neither the index nor the Gmail search has the id', async () => {
  const f = await fixture({ allow: 'acct-a' }); try {
    assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'not_found' });
    assert.deepEqual(f.queries, ['rfc822msgid:abc@example.com']);
  } finally { await f.mf.dispose(); }
});

test('already_archived when no match carries INBOX', async () => {
  const f = await fixture({ allow: 'acct-a' }); try {
    await f.seed('m1', ['UNREAD']);
    assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'already_archived', ref: 'acct-a:m1' });
    assert.equal(f.modified.length + f.queries.length, 0);
  } finally { await f.mf.dispose(); }
});

test('archived: every indexed INBOX copy, resolved by address, through the mutate path', async () => {
  const f = await fixture({ allow: 'you@example.com' }); try {
    await f.seed('m1', ['INBOX', 'UNREAD']); await f.seed('m2', ['INBOX']);
    const result = await f.archive({ account: 'You@Example.com', rfcMessageId: MID });
    assert.equal(result.status, 'archived'); assert.match(result.ref!, /^acct-a:m[12]$/);
    assert.deepEqual(f.modified.sort(), ['m1', 'm2']);
    assert.deepEqual(await f.labelsOf('m1'), ['UNREAD']);
    assert.equal(f.queries.length, 0);
  } finally { await f.mf.dispose(); }
});

test('archived via the Gmail rfc822msgid fallback when sync has not indexed it yet', async () => {
  const f = await fixture({ allow: 'acct-a', provider: [{ id: 'g1', labels: ['INBOX'] }, { id: 'g2', labels: ['SENT'] }] }); try {
    assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'archived', ref: 'acct-a:g1' });
    assert.deepEqual(f.modified, ['g1']);
  } finally { await f.mf.dispose(); }
});

test('insufficient_scope without a gmail.modify grant, and nothing is written', async () => {
  const f = await fixture({ allow: 'acct-a', writes: false }); try {
    await f.seed('m1', ['INBOX']);
    assert.deepEqual(await f.archive({ account: 'acct-a', rfcMessageId: MID }), { status: 'insufficient_scope' });
    assert.equal(f.modified.length, 0);
    assert.deepEqual(await f.labelsOf('m1'), ['INBOX']);
  } finally { await f.mf.dispose(); }
});
