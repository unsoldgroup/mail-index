import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

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
