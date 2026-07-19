/**
 * Operator config loader tests (SCOPE 0.4, PLAN §2 the 2a/2b boundary, §15).
 * Pure validation + label resolution; the on-disk loader is exercised against
 * the in-repo placeholder example and a tmp file. No account data ships in the
 * tool — these tests use placeholders only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTERS,
  ConfigError,
  validateConfig,
  resolveAccount,
  loadConfig,
  defaultConfigPath,
  expandHome,
} from '../dist/config/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('validateConfig accepts a minimal valid config', async () => {
  const cfg = validateConfig({
    accounts: { 'acct-a': { adapter: 'gws', configDir: '~/.config/gws-acct-a' } },
  });
  assert.equal(cfg.accounts['acct-a']?.adapter, 'gws');
  assert.equal(cfg.accounts['acct-a']?.configDir, '~/.config/gws-acct-a');
});

test('validateConfig parses an optional syncPolicy', async () => {
  const cfg = validateConfig({
    accounts: {
      'acct-a': {
        adapter: 'gws',
        configDir: '/x',
        syncPolicy: { since: '1mo', limit: 100, includeSent: true, query: 'from:x@y.com' },
      },
    },
  });
  assert.deepEqual(cfg.accounts['acct-a']?.syncPolicy, {
    since: '1mo',
    limit: 100,
    includeSent: true,
    query: 'from:x@y.com',
  });
});

test('validateConfig rejects a non-object top level', async () => {
  assert.throws(() => validateConfig(42), ConfigError);
  assert.throws(() => validateConfig([]), ConfigError);
});

test('validateConfig rejects a missing accounts map', async () => {
  assert.throws(() => validateConfig({}), /missing required "accounts"/);
});

test('validateConfig rejects an empty accounts map', async () => {
  assert.throws(() => validateConfig({ accounts: {} }), /at least one account/);
});

test('validateConfig rejects an unknown adapter', async () => {
  assert.throws(
    () => validateConfig({ accounts: { a: { adapter: 'imap', configDir: '/x' } } }),
    /unknown adapter "imap"/,
  );
});

test('validateConfig rejects a missing/blank configDir', async () => {
  assert.throws(
    () => validateConfig({ accounts: { a: { adapter: 'gws' } } }),
    /missing a non-empty string "configDir"/,
  );
  assert.throws(
    () => validateConfig({ accounts: { a: { adapter: 'gws', configDir: '  ' } } }),
    /configDir/,
  );
});

test('validateConfig rejects a malformed syncPolicy', async () => {
  assert.throws(
    () =>
      validateConfig({ accounts: { a: { adapter: 'gws', configDir: '/x', syncPolicy: 'no' } } }),
    /"syncPolicy" must be an object/,
  );
  assert.throws(
    () =>
      validateConfig({
        accounts: { a: { adapter: 'gws', configDir: '/x', syncPolicy: { limit: -1 } } },
      }),
    /non-negative integer/,
  );
});

test('resolveAccount returns the account by label', async () => {
  const cfg = validateConfig({ accounts: { 'acct-a': { adapter: 'gws', configDir: '/x' } } });
  assert.equal(resolveAccount(cfg, 'acct-a').configDir, '/x');
});

test('resolveAccount throws a clear error listing known labels', async () => {
  const cfg = validateConfig({ accounts: { 'acct-a': { adapter: 'gws', configDir: '/x' } } });
  assert.throws(() => resolveAccount(cfg, 'nope'), /unknown account "nope".*acct-a/s);
});

test('loadConfig throws ConfigError with guidance when the file is missing', async () => {
  assert.throws(
    () => loadConfig(join(tmpdir(), 'mail-index-does-not-exist-xyz.json')),
    /no operator config at/,
  );
});

test('loadConfig rejects invalid JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-index-cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, '{ not json ');
  assert.throws(() => loadConfig(p), /not valid JSON/);
});

test('the shipped config.example.json is valid against the loader', async () => {
  const p = join(REPO_ROOT, 'config.example.json');
  const cfg = loadConfig(p);
  assert.ok(Object.keys(cfg.accounts).length >= 1);
  // Each account carries the binding its adapter requires: gws → configDir,
  // gog → account email. Placeholder-only (no real data, 2a/2b boundary).
  for (const acct of Object.values(cfg.accounts)) {
    assert.ok((ADAPTERS as readonly string[]).includes(acct.adapter));
    if (acct.adapter === 'gws') assert.ok((acct.configDir ?? '').length > 0);
    else assert.ok((acct.account ?? '').length > 0);
  }
  // Sanity: the raw file uses example placeholders, never real data (2a/2b).
  assert.match(readFileSync(p, 'utf8'), /example\.com|acct-/);
});

test('defaultConfigPath honours XDG_CONFIG_HOME', async () => {
  const prev = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = '/tmp/xdg';
  try {
    assert.equal(defaultConfigPath(), '/tmp/xdg/mail-index/config.json');
  } finally {
    if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prev;
  }
});

test('expandHome expands a leading tilde', async () => {
  assert.ok(!expandHome('~/x').startsWith('~'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
});
