import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { agentCard, handleA2a } from '../dist-worker/worker/a2a.js';
import { handleAuthorizedRequest, handlePublicRequest } from '../dist-worker/worker/index.js';
import { toolList } from '../dist/mcp/server.js';

async function fixture() {
  const queued: unknown[] = []; const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async (m: unknown) => { queued.push(m); } }, TOKEN_ENC_KEY: Buffer.alloc(32, 5).toString('base64'), GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', OPERATOR_EMAILS: 'operator@example.com', SYNC_INTERVAL: '15m' };
  return { mf, env, queued };
}
function rpc(method: string, data?: unknown) { return new Request('https://worker.example/a2a', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: data }) }); }

test('public agent card is valid and derives every skill from the tool registry', async () => {
  const { mf, env } = await fixture(); try {
    const response = await handlePublicRequest(new Request('https://worker.example/.well-known/agent-card.json'), env, {} as never);
    const card = await response.json() as ReturnType<typeof agentCard>;
    assert.equal(card.url, 'https://worker.example/a2a'); assert.equal(card.capabilities.streaming, false);
    assert.deepEqual(card.skills.map((s) => s.id), toolList().map((t) => t.name));
  } finally { await mf.dispose(); }
});

test('A2A message/send dispatches the shared engine and carries Job receipts', async () => {
  const { mf, env, queued } = await fixture(); try {
    const request = rpc('message/send', { message: { role: 'user', parts: [{ kind: 'data', data: { tool: 'sync_status', args: {} } }] } });
    const response = await handleAuthorizedRequest(request, env); const body = await response.json() as { result: { parts: { data: Record<string, unknown> }[] } };
    assert.ok(body.result.parts[0]?.data['freshness']); assert.equal(queued.length, 1);
    assert.match(JSON.stringify(body), /job_id/);
  } finally { await mf.dispose(); }
});

test('A2A rejects text and unsupported task or streaming methods cleanly', async () => {
  const context = { repo: {} as never, config: { accounts: {} } };
  for (const method of ['tasks/get', 'tasks/cancel', 'message/stream']) {
    const body = await (await handleA2a(rpc(method), context)).json() as { error: { code: number } }; assert.equal(body.error.code, -32601);
  }
  const text = await (await handleA2a(rpc('message/send', { message: { parts: [{ kind: 'text', text: 'search mail' }] } }), context)).json() as { error: { code: number } };
  assert.equal(text.error.code, -32602);
});
