#!/usr/bin/env node
/**
 * mail-index-mcp server entry point (SCOPE 3.4, PLAN §12, §13 `mail-index mcp`).
 *
 * The thin process wiring: load the operator config, open the local index
 * (WAL — ADR-0005, so the detached background sync never blocks reads), build
 * the {@link ToolContext}, and connect the stdio MCP {@link serve}r. All tool
 * logic lives in `tools.ts` (pure, tested) and the surface registry in
 * `server.ts`; this file only assembles them and keeps the process alive.
 *
 * READ-ONLY on the mailbox (D15): the only provider seam wired in is
 * {@link buildSource} for `get_message`'s single inline O(1) enrich (ADR-0001).
 * Stale time-sensitive reads spawn a detached `mail-index sync` child
 * ({@link spawnDetachedSync}, ADR-0005). Diagnostics go to STDERR only — STDOUT
 * is the JSON-RPC transport and must carry nothing else.
 */

import { ConfigError, loadConfig, type OperatorConfig } from '../config/index.js';
import { openDb } from '../index/db.js';
import { Repo } from '../index/repo.js';
import { buildSource } from '../cli/sync.js';
import { serve, serveSetup, spawnDetachedSync } from './server.js';
import type { ToolContext } from './tools.js';

/**
 * Load the operator config, distinguishing "no config yet" (a first-run install
 * → SETUP MODE) from a malformed config (a real error that should still fail).
 * Returns null only when the config file is simply ABSENT (ConfigError whose
 * message is the ENOENT "no operator config at …" guidance); any other
 * ConfigError (bad JSON, bad shape) re-throws so the operator sees it.
 */
function loadConfigOrNull(): OperatorConfig | null {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError && /no operator config at /.test(err.message)) {
      return null;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrNull();

  // SELF-BOOTSTRAP (ITEM 2): with no config the recall surface has no index to
  // serve, so start in SETUP MODE — a reduced, advisory tool set that tells the
  // agent/user exactly how to onboard — instead of exiting with an error.
  if (config == null) {
    process.stderr.write(
      'mail-index-mcp: no operator config found — starting in SETUP MODE ' +
        '(setup_status / setup_instructions). Run `mail-index setup --account <email>`, ' +
        'then restart this server.\n',
    );
    await serveSetup();
    return;
  }

  const db = await openDb();
  const repo = new Repo(db);

  const ctx: ToolContext = {
    repo,
    config,
    buildSource,
    backgroundSync: spawnDetachedSync,
  };

  await serve(ctx);
  // serve() resolves once connected; the transport keeps the event loop alive
  // until stdin closes. Close the DB on shutdown so WAL is checkpointed.
  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mail-index-mcp: ${message}\n`);
  process.exit(1);
});
