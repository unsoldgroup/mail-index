import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

test('setup stdio negotiates MCP 2026-07-28 and calls the advisory tools', async () => {
  const client = new Client({ name: 'smoke', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(distDir, 'mcp', 'index.js')],
    env: { XDG_CONFIG_HOME: join(here, '__no_such_config__') },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['setup_status', 'setup_instructions']);
    const result = await client.callTool({ name: 'setup_status' });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).state.config_present, false);
  } finally {
    await client.close();
  }
});

test('local HTTP serves modern clients and retains legacy sessions', { timeout: 10_000 }, async () => {
  const serverModule = new URL('../dist/mcp/server.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { serveHttp, buildSetupServer } from ${JSON.stringify(serverModule)};
    await serveHttp({ host: '127.0.0.1', port: 0, path: '/mcp', mode: 'setup', build: buildSetupServer });
  `], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: join(here, '__no_such_config__') },
  });
  try {
    const url = await new Promise<URL>((resolve, reject) => {
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)\n/.exec(stderr);
        if (match) resolve(new URL(match[1]));
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`local MCP exited ${code}: ${stderr}`)));
    });
    for (const mode of ['legacy', { pin: '2026-07-28' }] as const) {
      const client = new Client({ name: 'smoke', version: '1' }, { versionNegotiation: { mode } });
      const transport = new StreamableHTTPClientTransport(url);
      try {
        await client.connect(transport);
        assert.equal(client.getProtocolEra(), mode === 'legacy' ? 'legacy' : 'modern');
        assert.equal(Boolean(transport.sessionId), mode === 'legacy');
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['setup_status', 'setup_instructions']);
        assert.equal((await client.callTool({ name: 'setup_status' })).isError, undefined);
        if (mode === 'legacy') await transport.terminateSession();
        const health = await fetch(new URL('/healthz', url));
        assert.equal((await health.json()).sessions, 0);
      } finally {
        await client.close();
      }
    }
  } finally {
    child.kill();
  }
});

test('cli bin prints usage and exits 0', async () => {
  const out = execFileSync('node', [join(distDir, 'cli', 'index.js')], {
    encoding: 'utf8',
  });
  assert.match(out, /Usage:/);
  assert.match(out, /mail-index/);
});

test('mcp bin self-bootstraps into SETUP MODE with no config (advisory tools, clean stdio)', async () => {
  // The MCP bin is a real stdio server (M3.4). With no operator config it now
  // SELF-BOOTSTRAPS (ITEM 2): instead of exiting it starts in SETUP MODE and
  // serves the reduced setup tool set, so an agent can onboard from inside the
  // session. STDOUT must stay a clean JSON-RPC transport; the setup-mode notice
  // goes to STDERR. Drive one tools/list request and assert the setup surface.
  // Point XDG_CONFIG_HOME at an empty dir so the run is hermetic.
  const child = spawn('node', [join(distDir, 'mcp', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: join(here, '__no_such_config__') },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  // Minimal MCP handshake then a tools/list call.
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  // Wait for the tools/list response (id:2) to appear on stdout, then stop.
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)), 10_000);
    child.stdout.on('data', async () => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          resolve(msg.result);
        }
      }
    });
    child.on('error', reject);
  });

  child.stdin.end();
  child.kill();

  // The advertised tools are the reduced SETUP surface — never the recall tools.
  const names = (result.tools ?? []).map((t) => t.name);
  assert.deepEqual(new Set(names), new Set(['setup_status', 'setup_instructions']));

  // STDOUT carried only valid JSON-RPC frames (no stray prose / diagnostics).
  for (const line of stdout.split('\n')) {
    if (line.trim()) assert.doesNotThrow(() => JSON.parse(line), `stdout line is JSON: ${line}`);
  }
  // The setup-mode notice + onboarding guidance went to STDERR.
  assert.match(stderr, /mail-index-mcp:/);
  assert.match(stderr, /SETUP MODE|no operator config/);
});
