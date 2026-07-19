/**
 * Egress guard (privacy invariant, enforced in CI).
 *
 * mail-index's core promise is local-first: the indexing/MCP core (src/) makes
 * NO network calls. The only way the CORE reaches the network is by spawning the
 * provider adapter CLI (e.g. `gws`) — a single, auditable trust boundary.
 *
 * There is exactly ONE other sanctioned network seam, and it lives OUTSIDE the
 * core by design: the launch shim's self-updater (bin/selfupdate.mjs), which
 * checks the npm registry for a newer release and updates the install for the
 * NEXT launch. It is quarantined in bin/ precisely so the core stays provably
 * egress-free. This test enforces both halves: src/ has zero network and spawns
 * only in the allow-listed core seams; bin/ may reach the network only in the
 * updater and spawn only in the updater + the launcher that kicks it off.
 *
 * If this test fails, the privacy claim in README/SECURITY/THREAT-MODEL no
 * longer holds — fix the code, do not relax the guard without updating those.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const BIN = join(ROOT, 'bin');

/** Direct network egress primitives. */
const NETWORK = [
  { re: /\bfetch\s*\(/, what: 'fetch()' },
  { re: /['"]node:(?:http|https|net|dgram|tls)['"]/, what: 'node net/http import' },
  { re: /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, what: 'browser network API' },
  { re: /['"](?:axios|node-fetch|undici|got|superagent|ws|request)['"]/, what: 'network library import' },
  { re: /\b(?:posthog|mixpanel|sentry|amplitude|segment|datadog|analytics)\b/i, what: 'telemetry/analytics' },
];

/** `\bspawn\b` / `child_process` — `db.exec(...)` and `regex.exec(...)` are intentionally not matched. */
const PROC = /\bchild_process\b|\bspawn\b/;

/** Core (src/) process-spawn seams — the provider boundary + sanctioned re-execs. */
const SRC_PROC_ALLOW = new Set([
  'source/adapters/gws/runner.ts', // spawns the gws CLI — the provider boundary
  'source/adapters/gog/runner.ts', // spawns the gog CLI — the provider boundary
  'mcp/server.ts', // detached re-exec of our own `mail-index sync` (ADR-0005)
  'cli/proc.ts', // onboarding: spawns gog/brew (mail-index setup) — the single auditable seam
]);

/** Core (src/) network seams — the local HTTP MCP transport (streamable HTTP, PR #10). */
const SRC_NETWORK_ALLOW = new Set([
  'mcp/server.ts', // node:http server for the streamable-HTTP MCP transport — serves, never fetches
  'source/adapters/gmail-rest/runner.ts', // injected Gmail REST fetch — remote Deployment provider seam
]);

/** The ONE bin/ file allowed to reach the network: the self-updater. */
const BIN_NETWORK_ALLOW = new Set(['selfupdate.mjs']);
/** bin/ files allowed to spawn: the updater (git/npm/build) + the launcher that fires it. */
const BIN_PROC_ALLOW = new Set(['selfupdate.mjs', 'launch.mjs']);

function filesIn(dir: string, ext: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesIn(p, ext));
    else if (e.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * Strip comments so the guard scans CODE, not prose (a docstring may say
 * "spawns a detached sync" or "one bounded fetch" without being either). The
 * `[^:]//` guard preserves `https://` inside string literals.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function load(dir: string, ext: string) {
  return filesIn(dir, ext).map((f) => ({ rel: relative(dir, f), code: stripComments(readFileSync(f, 'utf8')) }));
}

const srcFiles = load(SRC, '.ts');
const binFiles = load(BIN, '.mjs');

test('no direct network primitives anywhere in src/ (core is egress-free)', () => {
  const hits: string[] = [];
  for (const { rel, code } of srcFiles) {
    if (SRC_NETWORK_ALLOW.has(rel)) continue;
    for (const { re, what } of NETWORK) {
      if (re.test(code)) hits.push(`${rel} → ${what}`);
    }
  }
  assert.equal(hits.length, 0, `network egress found in src (privacy violation):\n  ${hits.join('\n  ')}`);
});

test('process spawning in src/ only in the allow-listed core seams', () => {
  const hits: string[] = [];
  for (const { rel, code } of srcFiles) {
    if (SRC_PROC_ALLOW.has(rel)) continue;
    if (PROC.test(code)) hits.push(rel);
  }
  assert.equal(hits.length, 0, `process spawn outside the allow-list (new egress surface):\n  ${hits.join('\n  ')}`);
});

test('bin/ reaches the network only in the self-updater', () => {
  const hits: string[] = [];
  for (const { rel, code } of binFiles) {
    if (BIN_NETWORK_ALLOW.has(rel)) continue;
    for (const { re, what } of NETWORK) {
      if (re.test(code)) hits.push(`${rel} → ${what}`);
    }
  }
  assert.equal(hits.length, 0, `unexpected network seam in bin (only selfupdate.mjs may):\n  ${hits.join('\n  ')}`);
});

test('bin/ spawns only in the updater + launcher', () => {
  const hits: string[] = [];
  for (const { rel, code } of binFiles) {
    if (BIN_PROC_ALLOW.has(rel)) continue;
    if (PROC.test(code)) hits.push(rel);
  }
  assert.equal(hits.length, 0, `process spawn in bin outside the allow-list:\n  ${hits.join('\n  ')}`);
});

test('the allow-listed seams still exist (guard cannot silently pass)', () => {
  const srcPresent = new Set(srcFiles.map((f) => f.rel));
  for (const a of SRC_PROC_ALLOW) assert.ok(srcPresent.has(a), `core seam missing: ${a}`);
  for (const a of SRC_NETWORK_ALLOW) assert.ok(srcPresent.has(a), `core network seam missing: ${a}`);
  const binPresent = new Set(binFiles.map((f) => f.rel));
  for (const a of BIN_NETWORK_ALLOW) assert.ok(binPresent.has(a), `bin network seam missing: ${a}`);
});
