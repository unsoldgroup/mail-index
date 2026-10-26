/**
 * create_draft (ADR-0011): opt-in, drafts.create only, `from` limited to the
 * account's verified send-as addresses, and no send endpoint reachable.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { dispatch } from '../dist/mcp/server.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { buildRawDraft } from '../dist/source/adapters/gmail-shared.js';
import { createGmailRestRunner } from '../dist/source/adapters/gmail-rest/runner.js';
import { saveGrant, signPayload, GMAIL_COMPOSE, GMAIL_READONLY } from '../dist-worker/worker/google-oauth.js';
import { buildWorkerToolContext, handlePublicRequest } from '../dist-worker/worker/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const key = Buffer.alloc(32, 5).toString('base64');
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

test('buildRawDraft writes RFC 2822 headers and refuses header injection', () => {
  const mime = decode(buildRawDraft({ from: 'me@example.com', to: ['a@example.com', 'b@example.com'], subject: 'Café', body: 'hello', inReplyTo: '<x@y>', references: '<w@y> <x@y>' }));
  assert.match(mime, /^From: me@example\.com\r\nTo: a@example\.com, b@example\.com\r\n/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /In-Reply-To: <x@y>\r\nReferences: <w@y> <x@y>\r\n/);
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1]!, 'base64').toString(), 'hello');
  assert.throws(() => buildRawDraft({ from: 'me@example.com', to: ['a@example.com\r\nBcc: evil@example.com'], subject: 's', body: '' }), /line breaks/);
});

test('the Gmail seam refuses messages.send and drafts.send before any network call', async () => {
  let calls = 0;
  const run = createGmailRestRunner((async () => { calls += 1; return Response.json({}); }) as typeof fetch, async () => 't');
  for (const path of ['messages/send', 'drafts/send', 'drafts/send?x=1']) {
    await assert.rejects(() => run({ path, method: 'POST', body: {} }), /never sends/);
  }
  assert.equal(calls, 0);
});

const GUARD = "if (path.split(/[/?#]/).includes('send')) throw new Error('mail-index never sends mail');";

test('no code path names a Gmail send endpoint', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
  const hits: string[] = [];
  for (const file of [...files(join(ROOT, 'src')), ...files(join(ROOT, 'worker'))]) {
    let code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (file.endsWith('gmail-rest/runner.ts')) {
      assert.ok(code.includes(GUARD), 'the runner send guard is in place');
      code = code.replace(GUARD, '');
    }
    // REST paths, discovery method names, upload endpoint, gog/gws CLI verbs.
    if (/(?:messages|drafts)\s*[/.]\s*send|['"`]send['"`]|upload\/gmail/.test(code)) hits.push(relative(ROOT, file));
  }
  assert.deepEqual(hits, []);
});

async function harness() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined }, SWEEP_QUEUE: { send: async () => undefined }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const driver = new D1Driver(env.DB); await runMigrations(driver);
  const requests: { url: string; method: string; body: unknown }[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/settings/sendAs')) return Response.json({ sendAs: [
      { sendAsEmail: 'Owner@example.com', isPrimary: true },
      { sendAsEmail: 'alias@example.com', verificationStatus: 'accepted' },
      { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' },
    ] });
    if (url.includes('/messages/orig')) return Response.json({ id: 'orig', threadId: 'thread-1', payload: { headers: [
      { name: 'Message-ID', value: '<orig@mail>' }, { name: 'References', value: '<root@mail>' }, { name: 'Subject', value: 'Trip plan' },
    ] } });
    if (url.endsWith('/drafts')) return Response.json({ id: 'draft-1', message: { id: 'm2', threadId: 'thread-1' } });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { mf, env, driver, requests, fakeFetch };
}

test('create_draft is gated on a gmail.compose grant and limits from to verified send-as', async () => {
  const { mf, env, driver, requests, fakeFetch } = await harness();
  try {
    await saveGrant(driver, { account: 'acct-a', address: 'owner@example.com', scopes: [GMAIL_READONLY], refreshToken: 'r', key });
    const args = { account: 'acct-a', from: 'alias@example.com', to: ['friend@example.com'], subject: 'Hi', body: 'Draft body' };
    const readonly = await buildWorkerToolContext(env, fakeFetch);
    await assert.rejects(() => dispatch(readonly, 'create_draft', args), /\/setup\/google\/start\?account=acct-a&drafts=1/);
    assert.ok(!requests.some((r) => r.url.endsWith('/drafts')));

    await driver.prepare('UPDATE google_tokens SET scopes=? WHERE account=?').run(`${GMAIL_READONLY} ${GMAIL_COMPOSE}`, 'acct-a');
    const compose = await buildWorkerToolContext(env, fakeFetch);
    await assert.rejects(() => dispatch(compose, 'create_draft', { ...args, from: 'pending@example.com' }), /not a verified send-as address.*owner@example\.com, alias@example\.com/);
    await assert.rejects(() => dispatch(compose, 'create_draft', { ...args, from: 'stranger@example.com' }), /not a verified send-as/);

    const created = await dispatch(compose, 'create_draft', { ...args, account: undefined, subject: undefined, reply_to_ref: 'acct-a:orig' }) as Record<string, unknown>;
    assert.equal(created['draft_id'], 'draft-1');
    assert.equal(created['thread_id'], 'thread-1');
    assert.equal(created['sent'], false);
    const post = requests.find((r) => r.url.endsWith('/drafts'))!;
    assert.equal(post.method, 'POST');
    const message = (post.body as { message: { raw: string; threadId: string } }).message;
    assert.equal(message.threadId, 'thread-1');
    const mime = decode(message.raw);
    assert.match(mime, /From: alias@example\.com/);
    assert.match(mime, /Subject: Re: Trip plan/);
    assert.match(mime, /In-Reply-To: <orig@mail>\r\nReferences: <root@mail> <orig@mail>/);
    assert.equal(requests.filter((r) => r.url.includes('/settings/sendAs')).length, 1, 'send-as list is cached');
    assert.ok(requests.every((r) => !/\/send(\?|$)/.test(new URL(r.url).pathname)));
  } finally { await mf.dispose(); }
});

test('setup consent with drafts=1 requests gmail.compose alongside readonly', async () => {
  const { mf, env, fakeFetch } = await harness();
  try {
    const session = await signPayload({ email: 'operator@example.com', expiresAt: Date.now() + 60_000 }, key);
    const start = await handlePublicRequest(new Request('https://worker.example/setup/google/start?account=acct-a&drafts=1', { headers: { cookie: `mail_index_operator=${session}` } }), env, {} as never, { fetchImpl: fakeFetch });
    const scope = new URL(start.headers.get('location')!).searchParams.get('scope')!.split(' ');
    assert.ok(scope.includes(GMAIL_COMPOSE) && scope.includes(GMAIL_READONLY));
    assert.ok(!scope.includes('https://www.googleapis.com/auth/gmail.send'));
  } finally { await mf.dispose(); }
});
