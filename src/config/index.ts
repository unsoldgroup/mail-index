/**
 * Operator config loader (SCOPE 0.4, PLAN §2 the 2a/2b boundary, §15
 * multi-account).
 *
 * The distributable tool (2a) ships *no* account data. An operator (2b) stands
 * up their accounts in a private config file at
 * `${XDG_CONFIG_HOME:-~/.config}/mail-index/config.json`. This module is the
 * single seam that turns an **account** label into the adapter config the
 * ingest layer needs — "a stable label and a way to invoke the adapter for that
 * label" (§15). Nothing about a particular operator is hardcoded here: the tool
 * carries only the *schema* + a placeholder `config.example.json`, never a real
 * account.
 *
 * The shape is intentionally small and adapter-tagged:
 *
 *   {
 *     "accounts": {
 *       "<label>": {
 *         "adapter": "gws",
 *         "configDir": "~/.config/gws-<label>",
 *         "syncPolicy": { "since": "1mo", "includeSent": true, ... }
 *       }
 *     }
 *   }
 *
 * `adapter` selects which `MailSource` implementation to build; `configDir` and
 * `syncPolicy` are adapter-neutral hints the chosen adapter interprets. The
 * loader validates structure (clear, line-pointing errors) but stays out of
 * adapter-specific semantics — the gws adapter validates its own `configDir`.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Error thrown for config-layer failures (missing file, bad shape). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Adapter identifiers the tool knows how to build. `gws` (adapter #1, D1) shells
 * out to the Google Workspace CLI with a per-account config dir; `gog` (adapter
 * #2) shells out to the gog CLI, which carries its own bundled OAuth client and
 * selects the mailbox by account email — the public, one-click-auth path.
 */
export const ADAPTERS = ['gws', 'gog', 'gmail-rest'] as const;
export type AdapterId = (typeof ADAPTERS)[number];

/**
 * Per-account sync policy (PLAN §7, §15). Adapter-neutral; mirrors the CLI sync
 * flags and the {@link MailScope} fields the adapter ultimately receives. All
 * optional — an absent policy means "the adapter's own default scope".
 */
export interface SyncPolicy {
  /** Default provider-native query/filter for this account. */
  query?: string;
  /** Default lower bound on message age (`30d`, `1mo`, ISO-8601). */
  since?: string;
  /** Default cap on the number of ids a sync run enumerates. */
  limit?: number;
  /** Whether to include Sent messages by default (D11). */
  includeSent?: boolean;
}

/** A single account's adapter binding (the value side of the label → config map). */
export interface AccountConfig {
  /** Which `MailSource` adapter backs this account. */
  adapter: AdapterId;
  /**
   * Adapter config directory. Required for `gws` (the per-account
   * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` — the wrapper's isolated mailbox config);
   * unused by `gog`, which keeps its own tokens.
   */
  configDir?: string;
  /**
   * Mailbox email address. Required for `gog` (the account gog selects with
   * `-a` and that `gog auth add` authorized); unused by `gws`.
   */
  account?: string;
  /** Optional default sync policy for this account. */
  syncPolicy?: SyncPolicy;
}

/** The whole operator config file: a label → {@link AccountConfig} map. */
export interface OperatorConfig {
  accounts: Record<string, AccountConfig>;
}

/**
 * Resolve the default operator config path:
 * `${XDG_CONFIG_HOME:-~/.config}/mail-index/config.json`.
 */
export function defaultConfigPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'mail-index', 'config.json');
}

/** Expand a leading `~` (and `~/`) to the operator's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed value against the {@link OperatorConfig} shape, returning a
 * normalised config. `source` is used only to make error messages point at the
 * offending file/origin.
 */
export function validateConfig(parsed: unknown, source = '<config>'): OperatorConfig {
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`${source}: top-level value must be a JSON object`);
  }
  if (!('accounts' in parsed) || !isPlainObject(parsed['accounts'])) {
    throw new ConfigError(`${source}: missing required "accounts" object`);
  }

  const rawAccounts = parsed['accounts'];
  const labels = Object.keys(rawAccounts);
  if (labels.length === 0) {
    throw new ConfigError(`${source}: "accounts" must declare at least one account`);
  }

  const accounts: Record<string, AccountConfig> = {};
  for (const label of labels) {
    if (label.trim() === '') {
      throw new ConfigError(`${source}: account label must be a non-empty string`);
    }
    const raw = rawAccounts[label];
    if (!isPlainObject(raw)) {
      throw new ConfigError(`${source}: account "${label}" must be an object`);
    }

    const adapter = raw['adapter'];
    if (typeof adapter !== 'string') {
      throw new ConfigError(`${source}: account "${label}" is missing a string "adapter"`);
    }
    if (!(ADAPTERS as readonly string[]).includes(adapter)) {
      throw new ConfigError(
        `${source}: account "${label}" has unknown adapter "${adapter}" ` +
          `(known: ${ADAPTERS.join(', ')})`,
      );
    }

    // Adapter-specific binding: gws needs a configDir; gog needs an account
    // email. Validate the field the chosen adapter requires.
    const account: AccountConfig = { adapter: adapter as AdapterId };
    if (adapter === 'gog') {
      const email = raw['account'];
      if (typeof email !== 'string' || email.trim() === '') {
        throw new ConfigError(
          `${source}: account "${label}" (adapter "gog") is missing a non-empty string "account" (the mailbox email)`,
        );
      }
      account.account = email;
    } else if (adapter === 'gws') {
      const configDir = raw['configDir'];
      if (typeof configDir !== 'string' || configDir.trim() === '') {
        throw new ConfigError(
          `${source}: account "${label}" (adapter "${adapter}") is missing a non-empty string "configDir"`,
        );
      }
      account.configDir = configDir;
    }

    if ('syncPolicy' in raw && raw['syncPolicy'] !== undefined) {
      account.syncPolicy = validateSyncPolicy(raw['syncPolicy'], `${source}: account "${label}"`);
    }

    accounts[label] = account;
  }

  return { accounts };
}

function validateSyncPolicy(raw: unknown, where: string): SyncPolicy {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}: "syncPolicy" must be an object`);
  }
  const policy: SyncPolicy = {};
  if (raw['query'] !== undefined) {
    if (typeof raw['query'] !== 'string') {
      throw new ConfigError(`${where}: "syncPolicy.query" must be a string`);
    }
    policy.query = raw['query'];
  }
  if (raw['since'] !== undefined) {
    if (typeof raw['since'] !== 'string') {
      throw new ConfigError(`${where}: "syncPolicy.since" must be a string`);
    }
    policy.since = raw['since'];
  }
  if (raw['limit'] !== undefined) {
    if (typeof raw['limit'] !== 'number' || !Number.isInteger(raw['limit']) || raw['limit'] < 0) {
      throw new ConfigError(`${where}: "syncPolicy.limit" must be a non-negative integer`);
    }
    policy.limit = raw['limit'];
  }
  if (raw['includeSent'] !== undefined) {
    if (typeof raw['includeSent'] !== 'boolean') {
      throw new ConfigError(`${where}: "syncPolicy.includeSent" must be a boolean`);
    }
    policy.includeSent = raw['includeSent'];
  }
  return policy;
}

/**
 * Load + validate the operator config from `path` (default
 * {@link defaultConfigPath}). Throws {@link ConfigError} with a clear message
 * when the file is missing, unreadable, not valid JSON, or malformed.
 */
export function loadConfig(path = defaultConfigPath()): OperatorConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ConfigError(
        `no operator config at ${path} — copy config.example.json there and edit it ` +
          `(this file holds your private accounts; see PLAN §2 the 2a/2b boundary)`,
      );
    }
    throw new ConfigError(`failed to read config at ${path}: ${e.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  return validateConfig(parsed, path);
}

/**
 * Resolve a single account's config by label, throwing a clear error (listing
 * the known labels) when the label is absent. This is the account label →
 * adapter config resolution the rest of the tool relies on (§15).
 */
export function resolveAccount(config: OperatorConfig, label: string): AccountConfig {
  const account = config.accounts[label];
  if (!account) {
    const known = Object.keys(config.accounts);
    throw new ConfigError(
      `unknown account "${label}" — configured accounts: ${known.length ? known.join(', ') : '(none)'}`,
    );
  }
  return account;
}
