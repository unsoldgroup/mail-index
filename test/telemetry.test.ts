import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { assertTierCoverage, mcpAnalyticsOptions } from '../dist-worker/worker/mcp-telemetry.js';
import { toolList } from '../dist/mcp/server.js';
import { SENSITIVE_TOOLS, TOOL_TIERS, instrumentWorkerMcp } from '../dist-worker/worker/telemetry.js';

const listed = toolList().map((t) => t.name);

test('error telemetry exposes static categories without mailbox data or exception payloads', () => {
  const options = mcpAnalyticsOptions({ serverName: 'mail-index', environment: 'test', tiers: TOOL_TIERS });
  for (const [message, type, code] of [
    ['D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR', 'internal', 'storage_pattern_too_complex'],
    ['catch_up needs an "account" — configured/indexed: private@example.com', 'missing_context', 'account_required'],
    ['invalid "since" "private@example.com" — expected a relative token', 'validation', 'invalid_since'],
    ['D1_ERROR: private@example.com', 'internal', 'storage_error'],
    ['private@example.com bearer secret', 'internal', 'tool_failed'],
  ]) {
    const event = options.beforeSend!({ event: '$mcp_tool_call', properties: {
      $mcp_is_error: true, $mcp_tool_name: 'catch_up', $mcp_error_message: message,
      $mcp_error_type: 'private@example.com', $exception_list: [{ value: message }],
      $mcp_parameters: { since: 'private@example.com' }, $mcp_response: { content: [{ text: message }] },
    } });
    assert.equal(event?.properties?.$mcp_error_type, type);
    assert.equal(event?.properties?.$mcp_error_message, code);
    assert.doesNotMatch(JSON.stringify(event), /private@example|bearer secret|exception_list|mcp_response|mcp_parameters/);
  }
  const success = options.beforeSend!({ event: '$mcp_tool_call', properties: { $mcp_is_error: false, $mcp_error_message: 'secret' } });
  assert.equal(success?.properties?.$mcp_error_message, undefined);
});

test('every advertised tool has a telemetry tier, and no tier names a removed tool', () => {
  assertTierCoverage(listed, TOOL_TIERS);
  assert.deepEqual(Object.keys(TOOL_TIERS).filter((name) => !listed.includes(name)), []);
});

test('mailbox writers are write tier and sensitive tools are reads', () => {
  for (const name of ['archive_message', 'modify_labels', 'create_draft', 'settings_set', 'trigger_rule_save', 'webhook_consumer_register']) {
    assert.equal(TOOL_TIERS[name], 'write', name);
  }
  for (const name of SENSITIVE_TOOLS) assert.equal(TOOL_TIERS[name], 'read', name);
});

test('instrumentation is a no-op without a PostHog token', () => {
  const lifetime = { waitUntil: () => assert.fail('no delivery expected') };
  assert.equal(instrumentWorkerMcp({} as never, new Request('https://w.example/mcp'), {}, lifetime), false);
});

test('a /mcp tool call emits tier, surface and no arguments when a token is set', async () => {
  const { Miniflare } = await import('miniflare');
  const { handleAuthorizedRequest } = await import('../dist-worker/worker/index.js');
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'] });
  const env = { DB: await mf.getD1Database('DB'), OAUTH_KV: await mf.getKVNamespace('OAUTH_KV'), SYNC_QUEUE: { send: async () => undefined }, SWEEP_QUEUE: { send: async () => undefined }, TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', OPERATOR_EMAILS: 'o@example.com', SYNC_INTERVAL: '1h', POSTHOG_PROJECT_TOKEN: 'phc_test', ENVIRONMENT: 'test' };
  const pending: Promise<unknown>[] = [];
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('posthog.com')) {
      const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
      bodies.push((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString());
      return Response.json({ status: 1 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const call = new Request('https://w.example/mcp?surface=chatgpt', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'secret-needle' } } }) });
    const response = await handleAuthorizedRequest(call, env, {}, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
    assert.equal(response.status, 200);
    await Promise.all(pending);
    const sent = bodies.join('\n');
    assert.match(sent, /"\$mcp_tool_name":"search"/);
    assert.match(sent, /"tool_tier":"read"/);
    assert.match(sent, /"mcp_surface":"chatgpt"/);
    assert.match(sent, /"sensitive":true/);
    assert.doesNotMatch(sent, /secret-needle/);
    const failed = await handleAuthorizedRequest(new Request('https://w.example/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'catch_up', arguments: { account: 'default', since: 'private-failure@example.com' },
      } }),
    }), env, {}, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
    assert.equal(failed.status, 200);
    assert.equal((await failed.json() as { result: { isError: boolean } }).result.isError, true);
    await Promise.all(pending);
    const errors = bodies.join('\n');
    assert.match(errors, /"\$mcp_error_type":"validation"/);
    assert.match(errors, /"\$mcp_error_message":"invalid_since"/);
    assert.doesNotMatch(errors, /private-failure|exception_list|mcp_parameters|mcp_response/);
    const list = await handleAuthorizedRequest(new Request('https://w.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }), env, {}, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
    const listed = await list.text();
    assert.match(listed, /"search"/);
    assert.doesNotMatch(listed, /get_more_tools/);

    bodies.length = 0;
    const modern = await handleAuthorizedRequest(new Request('https://w.example/mcp?surface=chatgpt', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'search',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
        name: 'search', arguments: { query: 'modern-secret-needle' },
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      } }),
    }), env, {}, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} });
    assert.equal(modern.status, 200);
    await Promise.all(pending);
    const modernEvents = bodies.join('\n');
    assert.match(modernEvents, /"\$mcp_tool_name":"search"/);
    assert.match(modernEvents, /"mcp_surface":"chatgpt"/);
    assert.doesNotMatch(modernEvents, /modern-secret-needle/);
  } finally { globalThis.fetch = realFetch; await mf.dispose(); }
});
