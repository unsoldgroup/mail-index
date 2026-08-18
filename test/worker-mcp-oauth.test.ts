import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { handleAuthorizedRequest, handlePublicRequest } from '../dist-worker/worker/index.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { Repo } from '../dist/index/repo.js';
import { runMigrations } from '../dist/index/migrations.js';
import { GMAIL_READONLY, saveGrant } from '../dist-worker/worker/google-oauth.js';

const key = Buffer.alloc(32, 6).toString('base64');

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined }, SWEEP_QUEUE: { send: async () => undefined }, TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, env, ctx };
}

test('OAuth provider challenges MCP, exposes health, protects setup, and supports dynamic registration', async () => {
  const mf = new Miniflare({ modules: true, scriptPath: 'dist-worker-bundle/index.js', modulesRoot: '.', compatibilityFlags: ['nodejs_compat'], compatibilityDate: '2026-07-18', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'], queueProducers: { SYNC_QUEUE: 'mail-index-jobs', SWEEP_QUEUE: 'mail-index-sweeps' }, bindings: { TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' } });
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
    const confidential = await mf.dispatchFetch('https://worker.example/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Twenty test', redirect_uris: ['https://ei.unsold.cloud/apps/oauth/callback'], token_endpoint_auth_method: 'client_secret_post' }) });
    assert.equal(confidential.status, 201);
    const confidentialBody = await confidential.json() as { client_secret?: string; client_secret_expires_at?: number };
    assert.ok(confidentialBody.client_secret);
    assert.equal(confidentialBody.client_secret_expires_at, 0, 'operator-managed CRM clients must not expire');
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

test('MCP is stateless: tools/list succeeds without any shared in-memory session', async () => {
  const { mf, env } = await fixture();
  try {
    const rpc = (body: object, headers: Record<string, string> = {}) =>
      handleAuthorizedRequest(new Request('https://worker.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }), env);

    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });
    assert.equal(init.status, 200);
    // Stateless mode must not hand out a session id for the client to echo back.
    assert.equal(init.headers.get('mcp-session-id'), null);

    // The regression: this is the call that used to 400 when it landed in an
    // isolate that never saw `initialize`. Nothing is shared between the two.
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    const body = await list.json() as { result?: { tools?: { name: string }[] }; error?: unknown };
    assert.equal(body.error, undefined);
    assert.ok((body.result?.tools?.length ?? 0) > 0, 'tools/list returned an empty surface');

    // A stale session id from a previous isolate must not break the call either.
    const stale = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'mcp-session-id': 'session-from-a-dead-isolate' });
    assert.equal(stale.status, 200);
  } finally { await mf.dispose(); }
});

test('Worker HTTP MCP advertises and returns attachment bytes as an embedded resource', async () => {
  const { mf, env } = await fixture();
  const driver = new D1Driver(env.DB); await runMigrations(driver); const repo = new Repo(driver);
  await saveGrant(driver, { account: 'personal', address: 'user@example.com', scopes: [GMAIL_READONLY], refreshToken: 'refresh', key });
  await repo.upsertMessage({ account: 'personal', gmailMessageId: 'm1', labels: ['INBOX'], bodyState: 'meta' });
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'access', expires_in: 3600 });
    if (url.includes('/attachments/a1')) return Response.json({ size: 8, data: Buffer.from('%PDFtest').toString('base64url') });
    return Response.json({ id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [
      { filename: 'scope.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 8 } },
    ] } });
  }) as typeof fetch;
  const rpc = (body: object) => handleAuthorizedRequest(new Request('https://worker.example/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  }), env, { fetchImpl: fakeFetch });
  try {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const listed = await list.json() as { result: { tools: { name: string }[] } };
    assert.ok(listed.result.tools.some((tool) => tool.name === 'get_message_attachment'));
    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'get_message_attachment', arguments: { ref: 'personal:m1', attachment: 'scope.pdf' },
    } });
    const body = await call.json() as { result: { content: ({ type: string; resource?: { mimeType: string; blob: string } })[] } };
    const resource = body.result.content.find((item) => item.type === 'resource')?.resource;
    assert.equal(resource?.mimeType, 'application/pdf');
    assert.equal(Buffer.from(resource?.blob ?? '', 'base64').toString(), '%PDFtest');
  } finally { await mf.dispose(); }
});
