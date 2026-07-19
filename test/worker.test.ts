import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import worker, { handleAuthorizedRequest, handlePublicRequest } from '../dist-worker/worker/index.js';
import { SCHEMA_VERSION } from '../dist/index/schema.js';
import { toolList } from '../dist/mcp/server.js';

const oauthSecrets = { TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' };

async function fixture() {
  const queued: unknown[] = [];
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    kvNamespaces: ['OAUTH_KV'],
  });
  const env = {
    DB: await mf.getD1Database('DB'),
    OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'),
    SYNC_QUEUE: { send: async (message: unknown) => { queued.push(message); } },
    ...oauthSecrets,
    OPERATOR_EMAILS: 'operator@example.com',
    SYNC_INTERVAL: '15m',
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return { mf, env, ctx, queued };
}

function mcpRequest(body: unknown, sessionId?: string) {
  return new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
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
    const response = await handlePublicRequest(new Request('https://worker.example/healthz'), env, ctx);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body['version'], '1.4.0');
    assert.equal(body['schema_version'], SCHEMA_VERSION);
    assert.equal(body['migration_state'], 'current');
    assert.equal(body['ok'], true);
  } finally {
    await mf.dispose();
  }
});

test('Authorized Worker MCP serves initialize, tools/list, and a D1-backed call', async () => {
  const { mf, env, ctx, queued } = await fixture();
  try {
    const initialized = await handleAuthorizedRequest(mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }), env);
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);

    const listed = await handleAuthorizedRequest(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId), env);
    const listBody = (await listed.json()) as { result: { tools: unknown[] } };
    assert.deepEqual(listBody.result.tools, toolList());

    const called = await handleAuthorizedRequest(mcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sync_status', arguments: {} },
    }, sessionId), env);
    const callBody = (await called.json()) as { result: { content: { text: string }[] } };
    assert.match(callBody.result.content[0]?.text ?? '', /"accounts":\[\]/);
    assert.doesNotMatch(callBody.result.content[0]?.text ?? '', /mail-index /);
    assert.match(callBody.result.content[0]?.text ?? '', /job_id/);
    const repeated = await handleAuthorizedRequest(mcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sync_status', arguments: {} } }, sessionId), env);
    assert.equal(repeated.status, 200);
    assert.equal(queued.length, 1, 'stale-read Job enqueue is deduplicated');
  } finally {
    await mf.dispose();
  }
});
