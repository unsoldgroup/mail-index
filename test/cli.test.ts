/**
 * CLI tests (SCOPE 0.7, PLAN §13). Two layers:
 *
 *  - Unit: the pure helpers each command module exposes (scope composition, hit
 *    formatting, status assembly) — no process, no DB I/O beyond an in-memory
 *    index. The FTS MATCH builder now lives in the FTS contract (fts.test.ts).
 *  - Smoke: the built `dist/cli/index.js` bin parsing args end-to-end, including
 *    a `search` over a seeded tmp database (exercising arg routing + output).
 *
 * Imports the built JS (`../dist/...`) like the other suites so it runs after
 * the `pretest` compile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeScope, buildSource } from '../dist/cli/sync.js';
import { runSearch, formatHit, formatResults, messageRef } from '../dist/cli/search.js';
import { buildStatus, formatStatus, formatStatusJson } from '../dist/cli/status.js';
import { runInit, formatInit } from '../dist/cli/init.js';
import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cliBin = join(repoRoot, 'dist', 'cli', 'index.js');
const exampleConfig = join(repoRoot, 'config.example.json');

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- sync helpers --------------------------------------------------------

test('composeScope overlays CLI flags onto the account policy', async () => {
  const account = {
    adapter: 'gws' as const,
    configDir: '/x',
    syncPolicy: { since: '1mo', limit: 1000, includeSent: true },
  };
  const scope = composeScope(account, { since: '7d', limit: 50 });
  assert.equal(scope?.since, '7d');
  assert.equal(scope?.limit, 50);
  assert.equal(scope?.includeSent, true);
});

test('composeScope --all clears since/limit bounds (whole mailbox)', async () => {
  const account = {
    adapter: 'gws' as const,
    configDir: '/x',
    syncPolicy: { since: '1mo', limit: 1000 },
  };
  const scope = composeScope(account, { all: true });
  assert.equal(scope, undefined);
});

test('composeScope keeps query + includeSent even under --all', async () => {
  const account = {
    adapter: 'gws' as const,
    configDir: '/x',
    syncPolicy: { query: 'from:x@y.com', includeSent: false },
  };
  const scope = composeScope(account, { all: true });
  assert.equal(scope?.query, 'from:x@y.com');
  assert.equal(scope?.includeSent, false);
  assert.equal(scope?.since, undefined);
});

test('buildSource builds a gws adapter (expanding ~ in configDir)', async () => {
  const source = buildSource({ adapter: 'gws', configDir: '~/.config/gws-acct' });
  assert.equal(source.provider, 'gws');
});

// ---- search helpers ------------------------------------------------------

async function seedRepo(repo: Repo): void {
  await repo.upsertMessage({
    account: 'acct-a',
    gmailMessageId: 'm1',
    threadId: 't1',
    internalDate: 1717000000000,
    fromAddr: 'jordan@partner.example.com',
    toAddr: 'al@example.com',
    subject: 'Deposit terms for the Antarctica charter',
    snippet: 'Confirming the 20% deposit is due Friday.',
    bodyState: 'meta',
  });
  await repo.upsertMessage({
    account: 'acct-a',
    gmailMessageId: 'm2',
    threadId: 't2',
    internalDate: 1716900000000,
    fromAddr: 'news@bulletin.example.org',
    toAddr: 'subscribers@bulletin.example.org',
    subject: 'This week in polar logistics',
    snippet: 'Top stories: new zodiac schedules.',
    isList: true,
    bodyState: 'meta',
  });
}

test('runSearch ranks FTS hits and messageRef is account:id', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await seedRepo(repo);
    const rows = await runSearch(repo, ['deposit'], {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.gmail_message_id, 'm1');
    assert.equal(messageRef(rows[0]), 'acct-a:m1');
  } finally {
    db.close();
  }
});

test('runSearch is account-scoped + honours limit', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await seedRepo(repo);
    // Both messages match a fuzzy OR query; limit 1 caps the result.
    const rows = await runSearch(repo, ['antarctica', 'polar'], { account: 'acct-a', limit: 1 });
    assert.equal(rows.length, 1);
    const none = await runSearch(repo, ['deposit'], { account: 'other' });
    assert.equal(none.length, 0);
  } finally {
    db.close();
  }
});

test('formatHit is the compact sender · subject · date · snippet · ref line', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await seedRepo(repo);
    const row = (await runSearch(repo, ['deposit'], {}))[0];
    const line = formatHit(row);
    assert.match(line, /jordan@partner\.example\.com/);
    assert.match(line, /Antarctica charter/);
    assert.match(line, /2024-05-29/);
    assert.match(line, /acct-a:m1$/);
  } finally {
    db.close();
  }
});

test('formatResults reports an empty set without throwing', async () => {
  assert.match(formatResults([], ['nothing']), /No matches for "nothing"/);
});

// ---- status --------------------------------------------------------------

test('buildStatus reports per-account counts, freshness, and totals', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await seedRepo(repo);
    const runId = await repo.startSyncRun({ account: 'acct-a', phase: 'sync', selector: 'since=1mo' });
    await repo.finishSyncRun(runId, { fetched: 2, indexed: 2 });

    const report = await buildStatus(repo);
    assert.equal(report.totals.messages, 2);
    assert.equal(report.totals.bodyStates.meta, 2);
    const a = report.accounts.find((x) => x.account === 'acct-a');
    assert.ok(a);
    assert.equal(a.messages, 2);
    assert.equal(a.syncing, false);
    assert.ok(a.indexAsOf);
  } finally {
    db.close();
  }
});

test('buildStatus flags an in-flight sync as syncing', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await repo.startSyncRun({ account: 'acct-a', phase: 'sync' }); // left open = the lock
    const report = await buildStatus(repo);
    const a = report.accounts.find((x) => x.account === 'acct-a');
    assert.ok(a);
    assert.equal(a.syncing, true);
    assert.equal(a.indexAsOf, null);
  } finally {
    db.close();
  }
});

test('formatStatus / formatStatusJson render without throwing', async () => {
  const db = await openDb({ path: ':memory:' });
  try {
    const repo = new Repo(db);
    await seedRepo(repo);
    const report = await buildStatus(repo);
    assert.match(formatStatus(report), /acct-a/);
    const parsed = JSON.parse(formatStatusJson(report));
    assert.equal(parsed.totals.messages, 2);
  } finally {
    db.close();
  }
});

// ---- init ----------------------------------------------------------------

test('runInit scaffolds config from the example and is non-destructive', async () => {
  const dir = tmp('mi-init-');
  const configPath = join(dir, 'config.json');
  const dataDir = join(dir, 'data');

  const first = runInit({ configPath, examplePath: exampleConfig, dataDir });
  assert.equal(first.configCreated, true);
  assert.ok(existsSync(configPath));
  assert.ok(existsSync(dataDir));
  assert.match(formatInit(first), /Next steps:/);

  // Second run must not overwrite the (possibly hand-edited) config.
  const second = runInit({ configPath, examplePath: exampleConfig, dataDir });
  assert.equal(second.configCreated, false);
  assert.match(formatInit(second), /already exists/);
});

// ---- bin smoke tests -----------------------------------------------------

test('bin: top-level usage and per-command help', async () => {
  const usage = execFileSync('node', [cliBin], { encoding: 'utf8' });
  assert.match(usage, /Usage:/);
  for (const cmd of ['sync', 'search', 'show', 'open', 'status']) {
    const help = execFileSync('node', [cliBin, cmd, '--help'], { encoding: 'utf8' });
    assert.match(help, new RegExp(`mail-index ${cmd}`));
  }
});

test('bin: unknown command exits non-zero', async () => {
  assert.throws(() => execFileSync('node', [cliBin, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }));
});

test('bin: search over a seeded tmp db prints a ranked hit', async () => {
  const dir = tmp('mi-cli-');
  const dataDir = join(dir, 'mail-index');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'mail.sqlite');

  // Seed via the index layer directly, then drive the bin against the same DB
  // through XDG_DATA_HOME so the CLI resolves the default path to our tmp file.
  const db = await openDb({ path: dbPath });
  try {
    await seedRepo(new Repo(db));
  } finally {
    db.close();
  }

  const out = execFileSync('node', [cliBin, 'search', 'deposit'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: dir },
  });
  assert.match(out, /acct-a:m1/);
  assert.match(out, /Antarctica charter/);
});

test('bin: open prints the provider URL for a ref (no provider fetch)', async () => {
  const dir = tmp('mi-cli-');
  // A config dir with the shipped example config (has account "acct-a").
  const cfgHome = join(dir, 'config');
  mkdirSync(join(cfgHome, 'mail-index'), { recursive: true });
  cpSync(exampleConfig, join(cfgHome, 'mail-index', 'config.json'));
  // A data dir so the (lazily-opened) index resolves to a tmp path.
  mkdirSync(join(dir, 'mail-index'), { recursive: true });

  const out = execFileSync('node', [cliBin, 'open', 'acct-a:18f0a1b2c3'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: cfgHome, XDG_DATA_HOME: dir },
  });
  assert.equal(out.trim(), 'https://mail.google.com/mail/u/0/#all/18f0a1b2c3');
});

test('bin: status --json over a seeded tmp db is machine-readable', async () => {
  const dir = tmp('mi-cli-');
  const dataDir = join(dir, 'mail-index');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'mail.sqlite');

  const db = await openDb({ path: dbPath });
  try {
    await seedRepo(new Repo(db));
  } finally {
    db.close();
  }

  const out = execFileSync('node', [cliBin, 'status', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: dir },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.totals.messages, 2);
});
