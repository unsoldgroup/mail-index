/** Exercises the stateless MCP handler (fresh Server + web-standard transport
 * per request) inside workerd, without the OAuth layer. */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/env.js';
import { handleMcpRequest } from '../src/mcp.js';

const ctx = { env: env as unknown as Env, waitUntil: () => {} };

function rpc(body: unknown): Request {
  return new Request('http://mcp.test/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown): Promise<{ status: number; json: any }> {
  const res = await handleMcpRequest(rpc(body), ctx);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

describe('stateless MCP over web-standard streamable HTTP', () => {
  it('answers initialize', async () => {
    const { status, json } = await call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '0' },
      },
    });
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe('mail-index');
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it('lists tools without a session', async () => {
    const { status, json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(status).toBe(200);
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('ping');
  });

  it('calls a tool', async () => {
    const { json } = await call({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    });
    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.account).toBe('al');
  });
});
