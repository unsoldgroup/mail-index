/**
 * `mail-index setup` — idempotent onboarding orchestrator (the GUI/agent
 * install path; companion to ADR-0001/0005 and the 2a→2b boundary in PLAN §2).
 *
 * `init` scaffolds an empty config; `setup` takes the operator all the way to a
 * first sync: detect the `gog` adapter CLI, install it if missing, configure a
 * file keyring, place the bundled OAuth client, authenticate one mailbox
 * (read-only), write the account into config.json WITHOUT clobbering existing
 * accounts, and run the first sync. Every step is CHECK-then-ACT, so a second
 * run is a no-op once the prior run succeeded.
 *
 * Testability is the design constraint: all process/network effects flow through
 * an injected {@link SetupDeps} contract (`which`/`run`/`readBundledClient` plus
 * the existing `runInit`/`runSyncOne`). Production wires the real spawn seam
 * (src/cli/proc.ts); tests inject fakes and assert the exact commands built,
 * idempotency, and that the config is merged rather than overwritten — with no
 * process ever spawned. This module itself imports NO `node:child_process`; the
 * egress guard's PROC_ALLOW vouches only for proc.ts.
 *
 * The two HUMAN steps (a browser OAuth consent, and — when `gog` is absent on a
 * non-Homebrew system — installing the binary) cannot be automated headlessly.
 * In `--json` mode they are emitted as `action` step records for an agent/GUI to
 * surface, rather than blocking on an interactive prompt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  defaultConfigPath,
  validateConfig,
  type AdapterId,
  type OperatorConfig,
} from '../config/index.js';
import { Repo } from '../index/repo.js';
import { openDb } from '../index/db.js';
import { runInit, type InitResult } from './init.js';
import { runSyncOne, type SyncFlags } from './sync.js';
import { run as realRun, which as realWhich, type RunResult } from './proc.js';

/** Error thrown for setup-layer failures (a blocking, non-advisory problem). */
export class SetupError extends Error {
  override name = 'SetupError';
}

/**
 * The injectable effect boundary. Production defaults spawn real processes and
 * read the bundled client off disk; tests pass fakes so {@link runSetup} runs
 * with zero side effects.
 */
export interface SetupDeps {
  /** Resolve a binary on PATH (absolute path) or null when absent. */
  which(bin: string): string | null;
  /** Run a child process to completion, capturing output. */
  run(cmd: string, args: string[], opts?: { stdin?: string }): RunResult;
  /**
   * Return the shipped/`--client` OAuth client JSON (the string to feed
   * `gog auth credentials set -`), or null when none is available.
   */
  readBundledClient(clientPath?: string): string | null;
  /** Scaffold config + data dir (reused from `init`). */
  runInit: typeof runInit;
  /** Run one account's first sync (reused from `sync`). */
  runSyncOne: typeof runSyncOne;
}

/** CLI options for a setup run. */
export interface SetupOptions {
  /** The mailbox email to authenticate + index (required). */
  account: string;
  /** Adapter to wire (default `gog`, the one-click public path). */
  adapter?: AdapterId;
  /** Optional path to an OAuth client JSON to place (overrides the bundled one). */
  client?: string;
  /** Lower bound for the first sync (e.g. `1mo`). */
  since?: string;
  /** Skip the first sync (config-only onboarding). */
  noSync?: boolean;
  /**
   * Opt into mailbox writes (archive + label edit). Requests the least-privilege
   * `gmail.modify` scope IN ADDITION to readonly — never send/delete. Off by
   * default: the standard install stays read-only at the token level.
   */
  enableWrites?: boolean;
  /** Emit structured step records instead of human prose (agent/GUI mode). */
  json?: boolean;
  /** Override the config path (tests). */
  configPath?: string;
}

/** One structured onboarding step outcome. */
export interface SetupStep {
  /** Stable step id (detect, keyring, client, auth, config, sync, mcp). */
  step: string;
  /**
   * - `ok`     — already satisfied / completed without manual help;
   * - `done`   — this run performed the action;
   * - `action` — a human/agent must run something (command or note attached);
   * - `skipped`— intentionally not run (e.g. --no-sync).
   */
  status: 'ok' | 'done' | 'action' | 'skipped';
  /** Human-readable detail. */
  detail: string;
  /** The exact command an agent/GUI should run, when status is `action`. */
  command?: string;
}

/** The whole setup run outcome, for both `--json` and human rendering. */
export interface SetupResult {
  account: string;
  adapter: AdapterId;
  steps: SetupStep[];
  /** The MCP client config snippet to print at the end. */
  mcpSnippet: string;
}

/** The gog client label all our `gog auth …` calls bind to. */
const GOG_CLIENT = 'mail-index';

/** Production deps: real spawn seam + on-disk bundled client + init/sync. */
export function defaultDeps(): SetupDeps {
  return {
    which: realWhich,
    run: realRun,
    readBundledClient: readBundledClientFromDisk,
    runInit,
    runSyncOne,
  };
}

/**
 * Locate + read the shipped OAuth client JSON. An explicit `--client` path wins;
 * otherwise look for the bundled `gog-client.json` at the package root (next to
 * config.example.json — same layout as init's example lookup). Returns null when
 * no client is available, so setup degrades to emitting the manual `gog auth
 * credentials set` command rather than failing.
 */
function readBundledClientFromDisk(clientPath?: string): string | null {
  if (clientPath != null) {
    if (!existsSync(clientPath)) {
      throw new SetupError(`--client path does not exist: ${clientPath}`);
    }
    return readFileSync(clientPath, 'utf8');
  }
  const bundled = new URL('../../gog-client.json', import.meta.url).pathname;
  return existsSync(bundled) ? readFileSync(bundled, 'utf8') : null;
}

/**
 * Build the `gog auth add` command for an account. Read-only Gmail scope by
 * default; with `enableWrites` it ALSO requests the least-privilege
 * `gmail.modify` scope (archive + label edit — never send/delete), keeping the
 * readonly base so the granted set is exactly read + modify.
 */
export function authAddArgs(account: string, enableWrites = false): string[] {
  const args = [
    'auth',
    'add',
    account,
    '--client',
    GOG_CLIENT,
    '--services',
    'gmail',
    '--gmail-scope=readonly',
  ];
  if (enableWrites) {
    args.push('--extra-scopes=https://www.googleapis.com/auth/gmail.modify');
    // Upgrading an already-readonly account: gog reuses the stored refresh token
    // and would NOT re-consent for the broader scope without this — the upgrade
    // would silently no-op. Forcing consent is harmless on a fresh auth too.
    args.push('--force-consent');
  }
  return args;
}

/** Build the `gog auth list -j` command (machine-readable, for the check). */
export function authListArgs(): string[] {
  return ['auth', 'list', '--client', GOG_CLIENT, '-j'];
}

/**
 * Parse `gog auth list -j` output and decide whether `account` is already
 * authenticated. The output shape is provider-defined; we accept either an array
 * of entries or an object with an `accounts`/`entries` array, matching on an
 * `email`/`account`/`address` field. Unparseable output → treated as "absent"
 * (we then emit the auth action rather than guessing it is present).
 */
export function accountIsAuthed(listJson: string, account: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return false;
  }
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? (asArray(parsed['accounts']) ?? asArray(parsed['entries']) ?? [])
      : [];
  const needle = account.toLowerCase();
  return entries.some((e) => {
    if (typeof e === 'string') return e.toLowerCase() === needle;
    if (!isRecord(e)) return false;
    for (const k of ['email', 'account', 'address']) {
      const v = e[k];
      if (typeof v === 'string' && v.toLowerCase() === needle) return true;
    }
    return false;
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/**
 * Merge one account block into config.json WITHOUT clobbering existing accounts.
 * Reads the current (init-created) config, validates it, adds/updates only the
 * `account` label, and writes it back. Returns whether the block was newly added
 * (vs. already present and unchanged) so the step can report ok vs done.
 */
export function writeAccountBlock(
  configPath: string,
  label: string,
  block: { adapter: AdapterId; account?: string; configDir?: string; since?: string },
  opts: { seedFresh?: boolean } = {},
): { added: boolean; existed: boolean } {
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SetupError(`config at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new SetupError(`config at ${configPath} must be a JSON object`);
  }
  // When `seedFresh` (init just created the config from the shipped example),
  // the existing `accounts` map is all PLACEHOLDER data — start from an empty
  // map so setup's account is the only real one. On a pre-existing operator
  // config we keep every sibling account and only add/update our label.
  const accountsRaw = parsed['accounts'];
  const accounts: Record<string, unknown> =
    opts.seedFresh || !isRecord(accountsRaw) ? {} : { ...accountsRaw };

  const existed = Object.prototype.hasOwnProperty.call(accounts, label);
  const desired: Record<string, unknown> = { adapter: block.adapter };
  if (block.adapter === 'gog') desired['account'] = block.account ?? label;
  else desired['configDir'] = block.configDir ?? `~/.config/gws-${label}`;
  if (block.since != null) desired['syncPolicy'] = { since: block.since };

  const before = existed ? JSON.stringify(accounts[label]) : null;
  accounts[label] = desired;
  const after = JSON.stringify(desired);

  const next = { ...parsed, accounts };
  // Validate the merged config before writing — never leave a broken config.
  validateConfig(next, configPath);
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

  return { added: !existed, existed: existed && before === after };
}

/**
 * The onboarding orchestrator. CHECK-then-ACT through each step, emitting a
 * {@link SetupStep} record per phase. Idempotent: a second run over an
 * already-onboarded account performs no actions (every step reports `ok`).
 */
export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  if (!opts.account || opts.account.trim() === '') {
    throw new SetupError('setup requires --account <email>');
  }
  const adapter: AdapterId = opts.adapter ?? 'gog';
  const label = opts.account;
  const configPath = opts.configPath ?? defaultConfigPath();
  const steps: SetupStep[] = [];

  // (1) Detect the adapter CLI.
  const adapterBin = adapter === 'gog' ? 'gog' : 'gws';
  const adapterPath = deps.which(adapterBin);
  if (adapterPath == null) {
    if (process.platform === 'darwin' && deps.which('brew') != null) {
      const installArgs = ['install', 'openclaw/tap/gogcli'];
      const res = deps.run('brew', installArgs);
      if (res.code === 0) {
        steps.push({ step: 'detect', status: 'done', detail: `installed ${adapterBin} via Homebrew` });
      } else {
        steps.push({
          step: 'detect',
          status: 'action',
          detail: `Homebrew install failed (exit ${res.code}). Install ${adapterBin} manually, then re-run setup.`,
          command: `brew ${installArgs.join(' ')}`,
        });
        return finish(label, adapter, steps);
      }
    } else {
      steps.push({
        step: 'detect',
        status: 'action',
        detail:
          `${adapterBin} is not installed. On macOS: brew install openclaw/tap/gogcli. ` +
          `Otherwise install the gog CLI from its release page, then re-run setup.`,
        command: 'brew install openclaw/tap/gogcli',
      });
      // Without the adapter CLI we cannot configure/auth/sync — stop here, but
      // emit the MCP snippet so the agent/GUI has the full picture.
      return finish(label, adapter, steps);
    }
  } else {
    steps.push({ step: 'detect', status: 'ok', detail: `${adapterBin} found at ${adapterPath}` });
  }

  // (2) Configure the file keyring. We do NOT set or hardcode a password — we
  // document the env var the operator/GUI must export. (gog reads
  // GOG_KEYRING_BACKEND from the environment; a headless keyring needs a
  // file-backed store rather than the OS login keychain.)
  if (process.env['GOG_KEYRING_BACKEND'] === 'file') {
    steps.push({ step: 'keyring', status: 'ok', detail: 'GOG_KEYRING_BACKEND=file already set' });
  } else {
    steps.push({
      step: 'keyring',
      status: 'action',
      detail:
        'Export GOG_KEYRING_BACKEND=file for a headless, file-backed token store ' +
        '(set GOG_KEYRING_PASSWORD yourself — never hardcoded here).',
      command: 'export GOG_KEYRING_BACKEND=file',
    });
  }

  // (3) Place the OAuth client (gog only — gws carries its own).
  if (adapter === 'gog') {
    const client = deps.readBundledClient(opts.client);
    if (client != null) {
      const res = deps.run('gog', ['auth', 'credentials', 'set', '-', '--client', GOG_CLIENT], {
        stdin: client,
      });
      if (res.code === 0) {
        steps.push({ step: 'client', status: 'done', detail: `OAuth client placed for ${GOG_CLIENT}` });
      } else {
        steps.push({
          step: 'client',
          status: 'action',
          detail: `gog auth credentials set failed (exit ${res.code}): ${res.stderr.trim()}`,
          command: `gog auth credentials set - --client ${GOG_CLIENT}`,
        });
      }
    } else {
      steps.push({
        step: 'client',
        status: 'action',
        detail:
          'No bundled OAuth client found. Provide one with --client <path> or place it via ' +
          `gog auth credentials set - --client ${GOG_CLIENT}.`,
        command: `gog auth credentials set - --client ${GOG_CLIENT}`,
      });
    }
  } else {
    steps.push({ step: 'client', status: 'skipped', detail: 'gws carries its own credentials' });
  }

  // (4) Authenticate the mailbox (CHECK then ACT). The browser consent is a
  // HUMAN step: in --json mode emit it as an action rather than blocking.
  if (adapter === 'gog') {
    const enableWrites = opts.enableWrites ?? false;
    const scopeLabel = enableWrites ? 'read + write (gmail.modify)' : 'read-only';
    const consentLabel = enableWrites
      ? 'opens a browser for read + WRITE (archive/label) Gmail consent'
      : 'opens a browser for read-only Gmail consent';
    const listed = deps.run('gog', authListArgs());
    const authed = listed.code === 0 && accountIsAuthed(listed.stdout, label);
    // --enable-writes always (re)runs auth add so an already-readonly account is
    // upgraded to the modify scope (gog auth add is idempotent and re-consents).
    if (authed && !enableWrites) {
      steps.push({ step: 'auth', status: 'ok', detail: `${label} already authenticated` });
    } else if (opts.json) {
      steps.push({
        step: 'auth',
        status: 'action',
        detail: `Authenticate ${label} (${consentLabel}).`,
        command: `gog ${authAddArgs(label, enableWrites).join(' ')}`,
      });
    } else {
      const res = deps.run('gog', authAddArgs(label, enableWrites));
      steps.push(
        res.code === 0
          ? { step: 'auth', status: 'done', detail: `${label} authenticated (${scopeLabel})` }
          : {
              step: 'auth',
              status: 'action',
              detail: `gog auth add failed (exit ${res.code}): ${res.stderr.trim()}`,
              command: `gog ${authAddArgs(label, enableWrites).join(' ')}`,
            },
      );
    }
  } else {
    steps.push({ step: 'auth', status: 'skipped', detail: 'gws authenticates via its own wrapper' });
  }

  // (5) Write config: init (idempotent) then merge the account block.
  const init: InitResult = deps.runInit({ configPath });
  ensureConfigExists(configPath, init);
  const merged = writeAccountBlock(
    configPath,
    label,
    {
      adapter,
      ...(adapter === 'gog' ? { account: label } : {}),
      ...(opts.since != null ? { since: opts.since } : {}),
    },
    // A fresh init means the config is the placeholder example — seed clean.
    { seedFresh: init.configCreated },
  );
  steps.push({
    step: 'config',
    status: merged.added ? 'done' : 'ok',
    detail: merged.added
      ? `Added account "${label}" to ${configPath}`
      : `Account "${label}" already in ${configPath} (left as-is)`,
  });

  // (6) First sync (unless --no-sync). Only runnable once auth + config are in
  // place; if a SYNC-BLOCKING step (detect/client/auth) emitted an `action`,
  // skip the sync — there is nothing authenticated to sweep yet. The keyring
  // advisory is non-blocking: it documents an env var, not a hard prerequisite.
  const SYNC_BLOCKERS = new Set(['detect', 'client', 'auth']);
  const blockingAction = steps.some((s) => s.status === 'action' && SYNC_BLOCKERS.has(s.step));
  if (opts.noSync) {
    steps.push({ step: 'sync', status: 'skipped', detail: '--no-sync: skipped first sync' });
  } else if (blockingAction) {
    steps.push({
      step: 'sync',
      status: 'action',
      detail: 'Complete the steps above, then run the first sync.',
      command: `mail-index sync --account ${label}${opts.since ? ` --since ${opts.since}` : ''}`,
    });
  } else {
    const config = loadMergedConfig(configPath);
    const flags: SyncFlags = opts.since != null ? { since: opts.since } : {};
    const db = await openDb();
    try {
      const repo = new Repo(db);
      const result = await deps.runSyncOne(config, label, flags, repo);
      steps.push({
        step: 'sync',
        status: 'done',
        detail: `First sync: fetched ${result.fetched}, indexed ${result.indexed}`,
      });
    } finally {
      db.close();
    }
  }

  return finish(label, adapter, steps);
}

/** Read the just-written config back through the validator (no caching). */
function loadMergedConfig(configPath: string): OperatorConfig {
  return validateConfig(JSON.parse(readFileSync(configPath, 'utf8')), configPath);
}

/** Guard: if init reported a fresh-create but the file is missing, fail loudly. */
function ensureConfigExists(configPath: string, init: InitResult): void {
  if (!existsSync(init.configPath) && !existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    throw new SetupError(`init did not create a config at ${configPath}`);
  }
}

/** Assemble the final result, appending the MCP snippet step. */
function finish(label: string, adapter: AdapterId, steps: SetupStep[]): SetupResult {
  const mcpSnippet = mcpSnippetFor();
  steps.push({
    step: 'mcp',
    status: 'ok',
    detail: 'Add mail-index to your MCP client config (snippet below).',
  });
  return { account: label, adapter, steps, mcpSnippet };
}

/** The MCP client config snippet printed at the end of setup. */
export function mcpSnippetFor(): string {
  return JSON.stringify(
    {
      mcpServers: {
        'mail-index': { command: 'npx', args: ['-y', '-p', 'mail-index', 'mail-index-mcp'] },
      },
    },
    null,
    2,
  );
}

/** Render a setup result as the CLI prints it (human mode). */
export function formatSetup(result: SetupResult): string {
  const lines: string[] = [];
  lines.push(`Setup for ${result.account} (adapter: ${result.adapter})`);
  lines.push('');
  for (const s of result.steps) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'done' ? '+' : s.status === 'skipped' ? '·' : '!';
    lines.push(`  ${mark} [${s.step}] ${s.detail}`);
    if (s.command) lines.push(`      → ${s.command}`);
  }
  lines.push('');
  lines.push('MCP client config:');
  lines.push(result.mcpSnippet);
  return lines.join('\n') + '\n';
}
