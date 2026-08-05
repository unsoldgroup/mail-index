import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import { handlePublicRequest } from '../dist-worker/worker/index.js';
import { accessTokenProvider, decryptRefreshToken, saveGrant, signPayload } from '../dist-worker/worker/google-oauth.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';

const key = Buffer.alloc(32, 7).toString('base64');

test('Google connect encrypts independent Accounts and write re-consent replaces scopes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const db = await mf.getD1Database('DB');
  const env = {
    DB: db, OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined },
    TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m',
  };
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) {
      const code = new URLSearchParams(String(init?.body)).get('code');
      return Response.json({ access_token: `access-${code}`, refresh_token: `refresh-${code}`, expires_in: 3600 });
    }
    if (url.endsWith('/profile')) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ emailAddress: auth.includes('two') ? 'two@example.com' : 'one@example.com' });
    }
    if (url.endsWith('/modify')) return Response.json({ error: { message: 'insufficient scopes' } }, { status: 403 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  const session = await signPayload({ email: 'operator@example.com', expiresAt: Date.now() + 60_000 }, key);
  const request = (path: string) => new Request(`https://worker.example${path}`, { headers: { cookie: `mail_index_operator=${session}` } });
  try {
    for (const [account, code, writes] of [['one', 'one', '0'], ['two', 'two', '0'], ['one', 'one-write', '1']]) {
      const start = await handlePublicRequest(request(`/setup/google/start?account=${account}&writes=${writes}`), env, {} as never, { fetchImpl: fakeFetch });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state');
      const callback = await handlePublicRequest(request(`/setup/google/callback?code=${code}&state=${encodeURIComponent(state!)}`), env, {} as never, { fetchImpl: fakeFetch });
      assert.equal(callback.status, 200);
    }
    const rows = await db.prepare('SELECT account, address, scopes, refresh_token_ciphertext, iv FROM google_tokens ORDER BY account').all();
    assert.equal(rows.results.length, 2);
    assert.equal(rows.results[0].account, 'one');
    assert.match(String(rows.results[0].scopes), /gmail\.modify/);
    assert.equal(rows.results[1].address, 'two@example.com');
    assert.ok(!JSON.stringify(rows.results).includes('refresh-one'));
    await assert.rejects(() => decryptRefreshToken(rows.results[0].refresh_token_ciphertext as ArrayBuffer, rows.results[0].iv as ArrayBuffer, Buffer.alloc(32, 8).toString('base64')));

    const setup = await handlePublicRequest(request('/setup'), env, {} as never, { fetchImpl: fakeFetch });
    const html = await setup.text();
    assert.match(html, /one@example\.com/);
    assert.match(html, /two@example\.com/);
  } finally { await mf.dispose(); }
});

test('re-consent invalidates the cached Google access token immediately', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver);
    const env = { TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' }; let exchanges = 0;
    const fetchImpl = (async () => Response.json({ access_token: `access-${++exchanges}`, expires_in: 3600 })) as typeof fetch;
    await saveGrant(driver, { account: 'acct', address: 'a@example.com', scopes: ['readonly'], refreshToken: 'one', key });
    const provider = accessTokenProvider(driver, 'acct', env, fetchImpl); assert.equal(await provider(), 'access-1'); assert.equal(await provider(), 'access-1');
    await saveGrant(driver, { account: 'acct', address: 'a@example.com', scopes: ['modify'], refreshToken: 'two', key });
    assert.equal(await provider(), 'access-2'); assert.equal(exchanges, 2);
  } finally { await mf.dispose(); }
});

test('/setup/login mints an operator session without the MCP authorize flow', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  try {
    const env = {
      DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined },
      TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m',
    };
    const identity = (email: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
      if (url.includes('openidconnect.googleapis.com/v1/userinfo')) return Response.json({ email, email_verified: true });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const call = (path: string, fetchImpl: typeof fetch, cookie?: string) =>
      handlePublicRequest(new Request(`https://worker.example${path}`, cookie ? { headers: { cookie } } : {}), env, {} as never, { fetchImpl });

    // A cookie-less browser is challenged, but pointed at the sign-in route.
    const cold = await call('/setup', identity('operator@example.com'));
    assert.equal(cold.status, 401);
    assert.match(await cold.text(), /\/setup\/login/);

    // Sign-in redirects to Google for identity only — no mailbox scope requested.
    const start = await call('/setup/login', identity('operator@example.com'));
    assert.equal(start.status, 302);
    const consent = new URL(start.headers.get('location')!);
    assert.equal(consent.searchParams.get('scope'), 'openid email');
    const state = consent.searchParams.get('state')!;

    // An off-allowlist identity is refused and gets no cookie.
    const denied = await call(`/setup/google/callback?code=x&state=${encodeURIComponent(state)}`, identity('stranger@example.com'));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('set-cookie'), null);

    // The allowlisted operator gets a session that opens /setup, and no grant was written.
    const ok = await call(`/setup/google/callback?code=x&state=${encodeURIComponent(state)}`, identity('operator@example.com'));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/setup');
    const cookie = ok.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    const warm = await call('/setup', identity('operator@example.com'), cookie.split(';')[0]);
    assert.equal(warm.status, 200);
    const grants = await (await mf.getD1Database('DB')).prepare('SELECT count(*) AS n FROM google_tokens').all();
    assert.equal(grants.results[0].n, 0);
  } finally { await mf.dispose(); }
});
