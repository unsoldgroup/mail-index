import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { handlePublicRequest } from '../dist-worker/worker/index.js';

const key = Buffer.alloc(32, 6).toString('base64');

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, env, ctx };
}

test('OAuth provider challenges MCP, exposes health, protects setup, and supports dynamic registration', async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist-worker-bundle/index.js', modulesRoot: '.', compatibilityFlags: ['nodejs_compat'], compatibilityDate: '2026-07-18', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'], queueProducers: { SYNC_QUEUE: 'mail-index-jobs' }, bindings: { TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' } });
  try {
    const health = await mf.dispatchFetch('https://worker.example/healthz');
    assert.equal(health.status, 200);
    const setup = await mf.dispatchFetch('https://worker.example/setup');
    assert.equal(setup.status, 401);
    const denied = await mf.dispatchFetch('https://worker.example/mcp', { method: 'POST' });
    assert.equal(denied.status, 401); assert.ok(denied.headers.get('www-authenticate'));
    const a2aCard = await mf.dispatchFetch('https://worker.example/.well-known/agent-card.json');
    assert.equal(a2aCard.status, 200);
    const deniedA2a = await mf.dispatchFetch('https://worker.example/a2a', { method: 'POST' });
    assert.equal(deniedA2a.status, 401); assert.ok(deniedA2a.headers.get('www-authenticate'));
    const registered = await mf.dispatchFetch('https://worker.example/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude test', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(registered.status, 201); assert.ok(((await registered.json()) as { client_id?: string }).client_id);
  } finally { await mf.dispose(); }
});

test('Google identity allowlist grants operator and denies anyone else', async () => {
  const { mf, env, ctx } = await fixture();
  const auth = { responseType: 'code', clientId: 'client-id', redirectUri: 'https://client.example/callback', scope: ['mail-index'], state: 'client-state', codeChallenge: 'challenge', codeChallengeMethod: 'S256' };
  let completed = false;
  const helpers = { parseAuthRequest: async () => auth, completeAuthorization: async () => { completed = true; return { redirectTo: 'https://client.example/callback?code=issued' }; } };
  const fakeFetch = (email: string) => (async (input: RequestInfo | URL) => String(input).includes('/token') ? Response.json({ access_token: 'identity-access' }) : Response.json({ email, email_verified: true })) as typeof fetch;
  try {
    for (const [email, expected] of [['operator@example.com', 302], ['intruder@example.com', 403]] as const) {
      completed = false;
      const withHelpers = { ...env, OAUTH_PROVIDER: helpers };
      const start = await handlePublicRequest(new Request('https://worker.example/authorize'), withHelpers as never, ctx as never);
      const state = new URL(start.headers.get('location')!).searchParams.get('state');
      const callback = await handlePublicRequest(new Request(`https://worker.example/oauth/google/callback?code=x&state=${encodeURIComponent(state!)}`), withHelpers as never, ctx as never, { fetchImpl: fakeFetch(email) });
      assert.equal(callback.status, expected);
      assert.equal(completed, email === 'operator@example.com');
      if (email === 'operator@example.com') assert.match(callback.headers.get('set-cookie') ?? '', /HttpOnly.*SameSite=Lax/);
    }
  } finally { await mf.dispose(); }
});
