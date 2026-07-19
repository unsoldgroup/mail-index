/**
 * Database open + lifecycle (SCOPE 0.2, ADR-0005).
 *
 * Opens the single SQLite file at
 * `${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`, enables WAL mode
 * (ADR-0005: a single background writer never blocks MCP reads), and runs all
 * pending migrations on open. Tests pass an explicit path (`:memory:` or a
 * tmp file) to avoid touching the operator's real index.
 *
 * Uses the built-in `node:sqlite` (`DatabaseSync`) — no native deps (D2).
 */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageDriver } from './driver.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { getUserVersion, runMigrations } from './migrations.js';

/** Error thrown for index-layer failures (open, migrate, repo invariants). */
export class IndexError extends Error {
  override name = 'IndexError';
}

export interface OpenOptions {
  /**
   * Explicit database path. `:memory:` for an ephemeral in-memory DB (tests).
   * When omitted, the default XDG path is used.
   */
  path?: string;
  /** Skip running migrations on open (rarely needed; tests of migrations). */
  skipMigrations?: boolean;
}

/**
 * If this build is running from a LINKED git worktree, return that worktree's
 * root; otherwise null. The single production index is shared by every worktree
 * and the installed CLI/MCP, and migrations are forward-only — so a dev build in
 * a worktree running a new migration bumps `user_version` past what the
 * installed (older) build supports and breaks it. A linked worktree's `.git` is
 * a FILE (a `gitdir:` pointer), whereas the main worktree's `.git` is a
 * directory and an npm-installed package has none — so this cleanly isolates dev
 * worktrees while leaving the install and the canonical checkout on production.
 */
function linkedWorktreeRoot(): string | null {
  try {
    // dist/index/db.js → package root is two levels up.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const git = join(root, '.git');
    if (existsSync(git) && statSync(git).isFile()) return root;
  } catch {
    /* fall through to the shared default */
  }
  return null;
}

/**
 * Resolve the default index path. Precedence:
 *
 *  1. `MAIL_INDEX_DB` — an explicit DB file path (always wins; the manual seam).
 *  2. `XDG_DATA_HOME` (when set) → `${XDG_DATA_HOME}/mail-index/mail.sqlite`.
 *     An explicitly-set data dir is deliberate caller intent and outranks the
 *     auto-isolation below — without this, worktree isolation would silently
 *     ignore a caller's chosen data dir (e.g. a test pointing at a tmp dir).
 *  3. A linked git worktree → `<worktree>/.mail-index-dev.sqlite`, so dev builds
 *     auto-isolate from the production index without anyone setting env (see
 *     {@link linkedWorktreeRoot}). Only fires when neither env above is set.
 *  4. `~/.local/share/mail-index/mail.sqlite` — the shared production default
 *     (installed CLI/MCP + the canonical checkout).
 */
export function defaultDbPath(): string {
  const explicit = process.env['MAIL_INDEX_DB'];
  if (explicit && explicit.trim() !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg && xdg.trim() !== '') return join(xdg, 'mail-index', 'mail.sqlite');
  const wt = linkedWorktreeRoot();
  if (wt) return join(wt, '.mail-index-dev.sqlite');
  return join(homedir(), '.local', 'share', 'mail-index', 'mail.sqlite');
}

/**
 * Open (creating if needed) the index database. Enables WAL + foreign keys,
 * runs migrations, and returns a {@link StorageDriver} over the live connection.
 * The caller owns closing it. Async because migrations run over the async driver
 * seam (the D1 driver is async-only, ticket 002).
 */
export async function openDb(options: OpenOptions = {}): Promise<StorageDriver> {
  const path = options.path ?? defaultDbPath();
  const inMemory = path === ':memory:';

  if (!inMemory) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      throw new IndexError(
        `failed to create index directory for ${path}: ${(err as Error).message}`,
      );
    }
  }

  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(path);
  } catch (err) {
    throw new IndexError(`failed to open index at ${path}: ${(err as Error).message}`);
  }

  // WAL is meaningless for :memory: and SQLite silently keeps it in `memory`
  // journal mode there, so only request it for file-backed databases.
  if (!inMemory) {
    raw.exec('PRAGMA journal_mode = WAL');
  }
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  const db: StorageDriver = new SqliteDriver(raw);

  // Guard against opening the old single-file prototype DB (M1 carry-over). The
  // prototype created a `messages` table without ever setting `user_version`, so
  // a fresh-looking version-0 database that *already* contains app tables is not
  // an empty DB the migrations can build into — running migration 1 would fail
  // deep inside SQLite with a bare "table messages already exists". Detect that
  // shape up front and emit an actionable IndexError instead.
  if (!options.skipMigrations) {
    if ((await getUserVersion(db)) === 0 && (await hasAppTables(db))) {
      throw new IndexError(
        `found a pre-existing un-versioned database at ${path} — looks like the old ` +
          `prototype; move it aside (e.g. rename to ${path}.prototype-bak) or set a ` +
          `different data dir (XDG_DATA_HOME) before running mail-index`,
      );
    }
    await runMigrations(db);
  }

  return db;
}

/**
 * Whether the database already carries this app's tables — used only to detect
 * the un-versioned prototype DB (see {@link openDb}). Checks for the `messages`
 * table, which both the prototype and the current schema create.
 */
async function hasAppTables(db: StorageDriver): Promise<boolean> {
  const row = (await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
    .get()) as { name: string } | undefined;
  return row != null;
}
