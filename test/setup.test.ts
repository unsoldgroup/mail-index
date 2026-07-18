/**
 * `mail-index setup` onboarding tests (SCOPE: setup engine).
 *
 * Drives {@link runSetup} with fully injected fake {@link SetupDeps} — no
 * process is ever spawned, no network touched. Asserts the design contract:
 * the exact gog commands are built, the account is merged into config.json
 * WITHOUT clobbering existing accounts, a second run is a no-op (idempotent),
 * and --no-sync skips the first sync. Mirrors test/sync.test.ts style: import
 * the compiled output (pretest builds first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSetup, writeAccountBlock, accountIsAuthed, authAddArgs } from '../dist/cli/setup.js';

const EMAIL = 'al@example.com';
process.env['XDG_DATA_HOME'] = mkdtempSync(join(tmpdir(), 'mail-index-setup-data-'));

/** A recorded run() call, for asserting the exact commands built. */
function makeDeps(overrides = {}) {
  const calls = [];
  const base = {
    whichMap: { gog: '/usr/local/bin/gog', brew: '/opt/homebrew/bin/brew' },
    authList: '[]', // nothing authed yet
    bundledClient: '{"installed":{"client_id":"x"}}',
    syncResult: { account: EMAIL, fetched: 3, indexed: 3 },
    initCreated: true,
  };
  const cfg = { ...base, ...overrides };

  const deps = {
    which: (bin) => cfg.whichMap[bin] ?? null,
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, stdin: opts?.stdin });
      if (cmd === 'gog' && args[0] === 'auth' && args[1] === 'list') {
        return { code: 0, stdout: cfg.authList, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    readBundledClient: () => cfg.bundledClient,
    runInit: ({ configPath }) => {
      // Mimic init: copy the example to configPath on first create.
      if (cfg.initCreated && !existsSync(configPath)) {
        writeFileSync(
          configPath,
          JSON.stringify({
            accounts: { 'acct-a': { adapter: 'gws', configDir: '~/.config/gws-acct-a' } },
          }),
        );
      }
      return { configPath, configCreated: cfg.initCreated, dataDir: '/tmp/data' };
    },
    runSyncOne: async () => cfg.syncResult,
  };
  return { deps, calls };
}

function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-index-setup-'));
  return join(dir, 'config.json');
}

test('builds the gog auth add command with the read-only Gmail scope', async () => {
  assert.deepEqual(authAddArgs(EMAIL), [
    'auth', 'add', EMAIL, '--client', 'mail-index', '--services', 'gmail', '--gmail-scope=readonly',
  ]);
});

test('--enable-writes adds the least-privilege gmail.modify scope (never send/delete)', async () => {
  const args = authAddArgs(EMAIL, true);
  assert.deepEqual(args, [
    'auth', 'add', EMAIL, '--client', 'mail-index', '--services', 'gmail',
    '--gmail-scope=readonly', '--extra-scopes=https://www.googleapis.com/auth/gmail.modify',
    '--force-consent',
  ]);
  // Least-privilege: no full scope, no send/delete.
  assert.ok(!args.includes('--gmail-scope=full'));
});

test('--enable-writes re-runs auth on an already-readonly account to upgrade scope', async () => {
  const configPath = tmpConfig();
  // The account already shows as authenticated (readonly) in gog auth list.
  const { deps, calls } = makeDeps({ authList: JSON.stringify([{ email: EMAIL }]) });

  await runSetup({ account: EMAIL, configPath, enableWrites: true, noSync: true }, deps);
  const authAdd = calls.find((c) => c.cmd === 'gog' && c.args[1] === 'add');
  assert.ok(authAdd, 'auth add still runs despite the account being authed (scope upgrade)');
  assert.deepEqual(authAdd.args, authAddArgs(EMAIL, true));
});

test('accountIsAuthed matches across array/object shapes and is absent-safe', async () => {
  assert.equal(accountIsAuthed(JSON.stringify([{ email: EMAIL }]), EMAIL), true);
  assert.equal(accountIsAuthed(JSON.stringify({ accounts: [{ account: EMAIL }] }), EMAIL), true);
  assert.equal(accountIsAuthed(JSON.stringify([EMAIL]), EMAIL), true);
  assert.equal(accountIsAuthed(JSON.stringify([{ email: 'other@x.com' }]), EMAIL), false);
  assert.equal(accountIsAuthed('not json', EMAIL), false);
});

test('full run: places client, auths, writes config, syncs — building the right commands', async () => {
  const configPath = tmpConfig();
  const { deps, calls } = makeDeps();

  const result = await runSetup({ account: EMAIL, configPath }, deps);

  // Client placement via stdin.
  const setCred = calls.find((c) => c.cmd === 'gog' && c.args[1] === 'credentials');
  assert.ok(setCred, 'gog auth credentials set called');
  assert.deepEqual(setCred.args, ['auth', 'credentials', 'set', '-', '--client', 'mail-index']);
  assert.equal(setCred.stdin, '{"installed":{"client_id":"x"}}');

  // Auth add built with the readonly scope (non-json mode runs it).
  const authAdd = calls.find((c) => c.cmd === 'gog' && c.args[1] === 'add');
  assert.ok(authAdd, 'gog auth add called');
  assert.deepEqual(authAdd.args, authAddArgs(EMAIL));

  // Config written with the account; sync ran.
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(written.accounts[EMAIL], 'account block present');
  assert.equal(written.accounts[EMAIL].adapter, 'gog');
  assert.equal(written.accounts[EMAIL].account, EMAIL);
  assert.ok(result.steps.some((s) => s.step === 'sync' && s.status === 'done'));
  assert.ok(result.mcpSnippet.includes('mail-index-mcp'));
});

test('fresh init seeds clean — the example placeholder account is dropped', async () => {
  const configPath = tmpConfig();
  const { deps } = makeDeps({ initCreated: true });
  await runSetup({ account: EMAIL, configPath }, deps);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(Object.keys(written.accounts), [EMAIL], 'only the onboarded account remains');
});

test('does NOT clobber a pre-existing operator config — sibling accounts survive', async () => {
  const configPath = tmpConfig();
  // Operator already has a real account; init reports "not created".
  writeFileSync(
    configPath,
    JSON.stringify({ accounts: { work: { adapter: 'gws', configDir: '~/.config/gws-work' } } }),
  );
  const { deps } = makeDeps({ initCreated: false });

  await runSetup({ account: EMAIL, configPath }, deps);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(written.accounts['work'], 'existing sibling account preserved');
  assert.ok(written.accounts[EMAIL], 'new account added alongside');
});

test('idempotent: a second run performs no actions and leaves config unchanged', async () => {
  const configPath = tmpConfig();
  // First run.
  await runSetup({ account: EMAIL, configPath }, makeDeps().deps);
  const afterFirst = readFileSync(configPath, 'utf8');

  // Second run: gog now found, account already authed, config already present.
  const { deps, calls } = makeDeps({ initCreated: false, authList: JSON.stringify([{ email: EMAIL }]) });
  const result = await runSetup({ account: EMAIL, configPath }, deps);

  assert.equal(readFileSync(configPath, 'utf8'), afterFirst, 'config unchanged on re-run');
  const authStep = result.steps.find((s) => s.step === 'auth');
  assert.equal(authStep.status, 'ok', 'auth detected as already done');
  const configStep = result.steps.find((s) => s.step === 'config');
  assert.equal(configStep.status, 'ok', 'account already present');
  // No `gog auth add` on the idempotent run.
  assert.ok(!calls.some((c) => c.cmd === 'gog' && c.args[1] === 'add'), 'no re-auth');
});

test('--no-sync skips the first sync', async () => {
  const configPath = tmpConfig();
  let syncCalled = false;
  const { deps } = makeDeps();
  deps.runSyncOne = async () => {
    syncCalled = true;
    return { account: EMAIL, fetched: 0, indexed: 0 };
  };

  const result = await runSetup({ account: EMAIL, configPath, noSync: true }, deps);
  assert.equal(syncCalled, false, 'sync not invoked');
  const syncStep = result.steps.find((s) => s.step === 'sync');
  assert.equal(syncStep.status, 'skipped');
});

test('--json mode emits the browser auth as an action rather than running it', async () => {
  const configPath = tmpConfig();
  const { deps, calls } = makeDeps();
  const result = await runSetup({ account: EMAIL, configPath, json: true }, deps);

  const authStep = result.steps.find((s) => s.step === 'auth');
  assert.equal(authStep.status, 'action');
  assert.match(authStep.command ?? '', /gog auth add/);
  assert.ok(!calls.some((c) => c.cmd === 'gog' && c.args[1] === 'add'), 'auth add NOT spawned in json mode');
  // A pending action means sync is deferred too.
  const syncStep = result.steps.find((s) => s.step === 'sync');
  assert.equal(syncStep.status, 'action');
});

test('missing gog with no brew → an install action and an early, non-crashing return', async () => {
  const configPath = tmpConfig();
  const { deps } = makeDeps({ whichMap: {} }); // neither gog nor brew
  const result = await runSetup({ account: EMAIL, configPath }, deps);
  const detect = result.steps.find((s) => s.step === 'detect');
  assert.equal(detect.status, 'action');
  assert.match(detect.command ?? '', /brew install/);
  // It still produced an MCP snippet step and did not throw.
  assert.ok(result.steps.some((s) => s.step === 'mcp'));
});

test('writeAccountBlock merges into a pre-existing config without dropping siblings', async () => {
  const configPath = tmpConfig();
  writeFileSync(
    configPath,
    JSON.stringify({ accounts: { a: { adapter: 'gws', configDir: '~/x' } } }),
  );
  const { added } = writeAccountBlock(configPath, EMAIL, { adapter: 'gog', account: EMAIL });
  assert.equal(added, true);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(Object.keys(written.accounts).sort(), ['a', EMAIL].sort());
});
