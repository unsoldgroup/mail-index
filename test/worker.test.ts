import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import worker from '../dist-worker/worker/index.js';
import { SCHEMA_VERSION } from '../dist/index/schema.js';
import { toolList } from '../dist/mcp/server.js';

const bearer = 'development-secret-with-enough-entropy';
const oauthSecrets = { TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' };

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    kvNamespaces: ['OAUTH_KV'],
  });
  const env = {
    DB: await mf.getD1Database('DB'),
    OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'),
    SYNC_QUEUE: { send: async () => undefined },
    DEV_BEARER_TOKEN: bearer,
    ...oauthSecrets,
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, env, ctx };
}

function mcpRequest(body: unknown, sessionId?: string) {
  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('Worker fails loudly when required bindings are missing', async () => {
  await assert.rejects(() => worker.fetch(new Request('https://worker.example/healthz'), {} as never, {} as never));
});

test('Worker health reports package and migrated schema versions', async () => {
  const { mf, env, ctx } = await fixture();
  try {
    const response = await worker.fetch(new Request('https://worker.example/healthz'), env, ctx);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['version'], '1.4.0');
    assert.equal(body['schema_version'], SCHEMA_VERSION);
    assert.equal(body['ok'], true);
  } finally {
    await mf.dispose();
  }
});

test('Worker MCP requires bearer and serves initialize, tools/list, and a D1-backed call', async () => {
  const { mf, env, ctx } = await fixture();
  try {
    const denied = await worker.fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }), {
      ...env,
      DEV_BEARER_TOKEN: 'different',
    }, ctx);
    assert.equal(denied.status, 401);

    const initialized = await worker.fetch(mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }), env, ctx);
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);

    const listed = await worker.fetch(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId), env, ctx);
    const listBody = (await listed.json()) as { result: { tools: unknown[] } };
    assert.deepEqual(listBody.result.tools, toolList());

    const called = await worker.fetch(mcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sync_status', arguments: {} },
    }, sessionId), env, ctx);
    const callBody = (await called.json()) as { result: { content: { text: string }[] } };
    assert.match(callBody.result.content[0]?.text ?? '', /"accounts":\[\]/);
  } finally {
    await mf.dispose();
  }
});
