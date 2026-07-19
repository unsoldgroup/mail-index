import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import { handleRequest } from '../dist-worker/worker/index.js';
import { decryptRefreshToken } from '../dist-worker/worker/google-oauth.js';

const key = Buffer.alloc(32, 7).toString('base64');
const bearer = 'development-secret-with-enough-entropy';

test('Google connect encrypts independent Accounts and write re-consent replaces scopes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const db = await mf.getD1Database('DB');
  const env = {
    DB: db, OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined },
    DEV_BEARER_TOKEN: bearer, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', SYNC_INTERVAL: '15m',
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
  const request = (path: string) => new Request(`https://worker.example${path}`);
  try {
    for (const [account, code, writes] of [['one', 'one', '0'], ['two', 'two', '0'], ['one', 'one-write', '1']]) {
      const start = await handleRequest(request(`/setup/google/start?token=${bearer}&account=${account}&writes=${writes}`), env, { fetchImpl: fakeFetch });
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state');
      const callback = await handleRequest(request(`/setup/google/callback?code=${code}&state=${encodeURIComponent(state!)}`), env, { fetchImpl: fakeFetch });
      assert.equal(callback.status, 200);
    }
    const rows = await db.prepare('SELECT account, address, scopes, refresh_token_ciphertext, iv FROM google_tokens ORDER BY account').all();
    assert.equal(rows.results.length, 2);
    assert.equal(rows.results[0].account, 'one');
    assert.match(String(rows.results[0].scopes), /gmail\.modify/);
    assert.equal(rows.results[1].address, 'two@example.com');
    assert.ok(!JSON.stringify(rows.results).includes('refresh-one'));
    await assert.rejects(() => decryptRefreshToken(rows.results[0].refresh_token_ciphertext as ArrayBuffer, rows.results[0].iv as ArrayBuffer, Buffer.alloc(32, 8).toString('base64')));

    const setup = await handleRequest(request(`/setup?token=${bearer}`), env, { fetchImpl: fakeFetch });
    const html = await setup.text();
    assert.match(html, /one@example\.com/);
    assert.match(html, /two@example\.com/);
  } finally { await mf.dispose(); }
});
