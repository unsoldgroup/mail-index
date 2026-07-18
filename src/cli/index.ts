#!/usr/bin/env node
/**
 * mail-index CLI entry point (SCOPE 0.7, PLAN §13).
 *
 * Hand-rolled subcommand routing over `node:util` parseArgs (zero deps, per the
 * D2 no-friction spirit). The top-level dispatch peels the subcommand off argv,
 * then each command parses its own flags. Commands that touch the index open the
 * DB lazily (so `init`/`--help` never require an existing index) and always
 * close it.
 *
 * Output contract: human-readable text on stdout; errors on stderr with a
 * non-zero exit. The `--json` paths (status) emit machine-readable JSON for the
 * tray/scheduler ladder + ADR-0005.
 */

import { parseArgs } from 'node:util';

import { ConfigError, loadConfig, resolveAccount } from '../config/index.js';
import { IndexError, openDb } from '../index/db.js';
import { Repo } from '../index/repo.js';
import { SyncError } from '../ingest/sync.js';
import { enrich, EnrichError, type EnrichSelector } from '../ingest/enrich.js';

import { formatInit, runInit } from './init.js';
import { defaultDeps, formatSetup, runSetup, SetupError, type SetupOptions } from './setup.js';
import { buildSource, formatSyncResult, runSyncAll, runSyncOne, type SyncFlags } from './sync.js';
import { formatLabelResults, formatResults, runSearchEnriching, type SearchFlags } from './search.js';
import { formatShow, parseRef, runShow, RefError } from './show.js';
import { archiveChange, formatMutateResult, runLabelChange } from './labels.js';
import { formatOpen, runOpen } from './open.js';
import { buildStatus, formatStatus, formatStatusJson } from './status.js';
import { formatCadence, formatCadenceJson, runCadence, type CadenceFlags } from './cadence.js';
import { formatGraphResult, runGraphBuildAll, runGraphBuildOne } from './graph.js';
import { formatCurate, readlinePrompter, runCurate } from './curate.js';
import { compact } from '../writeback/index.js';

const USAGE = `mail-index — a local, agent-queryable mail intelligence layer

Usage:
  mail-index <command> [options]

Commands:
  init                          Scaffold the operator config + data dir
  setup   --account <email>     Onboard an account end-to-end (detect→auth→config→sync)
  sync    --account <label>     Sync message metadata for an account
  enrich  --account <label>     Fetch + distil bodies for selected messages (phase 2)
  curate  [--account <label>]   Interactive curation wizard (no-agent fallback; D14)
  search  <terms>               Recall over the index (ranked, snippet-first)
  inbox   [--account <label>]   List what's in the inbox now (kept fresh each sync)
  labeled <LABEL>               List messages carrying a Gmail label (e.g. UNREAD, STARRED)
  show    <account:message-id>  Print a message's full record (auto-enriches a meta row)
  open    <account:message-id>  Print the provider web URL for a message (no fetch)
  archive <account:message-id>  Archive a message (drop INBOX) — opt-in write; needs gmail.modify
  label   <account:message-id>  Add/remove labels (--add / --remove) — opt-in write; needs gmail.modify
  graph   build                 Build the contact graph (centrality + communities)
  compact [--account <label>]   Demote summarized bulk bodies to summary-only (ADR-0003)
  cadence --account <label>     Inbound frequency per sender brand (optionally --category)
  status                        Show per-account index freshness + counts

Run 'mail-index <command> --help' for command-specific options.
`;

const SETUP_USAGE = `mail-index setup — idempotent onboarding for one account

Usage:
  mail-index setup --account <email> [--adapter gog|gws] [--client <path>]
                   [--since <30d|1mo>] [--no-sync] [--enable-writes] [--json]

Walks the full install path: detect (and, on macOS, install) the adapter CLI,
configure a file keyring, place the bundled OAuth client, authenticate the
mailbox (read-only — opens a browser once), merge the account into config.json
without clobbering existing accounts, and run the first sync. Idempotent: a
second run over an already-onboarded account is a no-op.

Options:
  --account <email>   The mailbox email to onboard (required)
  --adapter <id>      Adapter to wire: gog (default) or gws
  --client <path>     OAuth client JSON to place (overrides the bundled one)
  --since <token>     Lower bound for the first sync (e.g. 30d, 1mo)
  --no-sync           Configure only; skip the first sync
  --enable-writes     Opt into archive + label edit: requests the least-privilege
                      gmail.modify scope (read + write, never send/delete). Re-runs
                      auth on an already-readonly account to upgrade its grant.
  --json              Emit structured step records (agent/GUI mode); the browser
                      auth step is surfaced as an action rather than blocking
`;

const SYNC_USAGE = `mail-index sync — phase-1 metadata sweep for an account

Usage:
  mail-index sync --account <label> [--since <30d|1mo>] [--all] [--query <q>] [--limit N]
  mail-index sync --all-accounts

Options:
  --account <label>   Account label from the operator config (required unless --all-accounts)
  --since <token>     Lower bound on message age (e.g. 30d, 1mo); overrides the account policy
  --all               Whole mailbox — ignore --since / --limit and the account's policy bounds
  --query <q>         Provider-native search filter (e.g. from:bloomberg.com)
  --limit N           Cap the number of ids the sweep enumerates
  --all-accounts      Sync every configured account using its own policy presets
`;

const ENRICH_USAGE = `mail-index enrich — phase-2 selective body enrichment

Usage:
  mail-index enrich --account <label> [--rule direct|all] [--sender <addr>] [--match <fts>] [--limit N]

Promotes matching meta messages to full: fetch the provider body, distil it
(raw bytes are never stored), and re-index FTS with the distilled text.

Options:
  --account <label>   Account label from the operator config (required)
  --profile           Enrich by the curated interest_profile policy (important→always,
                      muted/blocked→never, keyword matches→yes); ignores --rule/--sender/--match
  --rule direct|all   direct = non-list, non-promo/social mail (default); all = every meta row
  --sender <addr>     Only messages from this address
  --match <fts>       Only meta messages matching this FTS query
  --limit N           Cap the number of messages enriched
`;

const CURATE_USAGE = `mail-index curate — interactive curation wizard (no-agent fallback)

Usage:
  mail-index curate [--account <label>] [--limit N]

Walks the ranked curation shortlist (top contacts + domains by engagement) and
takes a keep/mute/important/skip decision for each, then collects interest
keywords. Persists the disposition (this is the enrichment policy, PLAN §7).
INDEX-ONLY: reads the local index, never the provider. The agent-mediated MCP
loop is the primary path (D14); this is the fallback for users with no agent.

Options:
  --account <label>   Account label from the operator config (default: the sole account)
  --limit N           Cap the contacts AND domains walked (default 20 each)
`;

const SEARCH_USAGE = `mail-index search — ranked recall over the index

Usage:
  mail-index search <terms...> [--account <label>] [--limit N] [--enrich]

Options:
  --account <label>   Restrict the search to one account
  --limit N           Maximum hits to return (default 20)
  --enrich            Enrich the returned hits' bodies, then re-rank (CLI-only; see ADR-0001)
`;

const LABELED_USAGE = `mail-index inbox / labeled — list messages by Gmail label

Usage:
  mail-index inbox [--account <label>] [--limit N]
  mail-index labeled <LABEL> [--account <label>] [--limit N]

Notes:
  inbox is sugar for 'labeled INBOX'. INBOX membership is reconciled on every
  sync, so 'inbox' reflects what's in the mailbox now. Other mutable labels
  (UNREAD, STARRED) reflect the state at last fetch.

Options:
  --account <label>   Restrict to one account
  --limit N           Maximum messages to return (default 20)
`;

const SHOW_USAGE = `mail-index show — print a message's full record

Usage:
  mail-index show <account:message-id>

A still-meta message is auto-enriched first (one provider fetch → distil →
upsert), then its distilled body is printed (the O(1) inline pattern, ADR-0001).
`;

const OPEN_USAGE = `mail-index open — print a message's provider web URL

Usage:
  mail-index open <account:message-id>

Resolves the ref to its provider deep link (Gmail #all view for gws) and prints
the URL. Does not fetch the message or touch the provider — it only needs the
account's adapter and the message id, so it works even before the message is
indexed.
`;

const ARCHIVE_USAGE = `mail-index archive — archive a message (OPT-IN write)

Usage:
  mail-index archive <account:message-id>

Removes the INBOX label from the message (Gmail "Archive"). This MUTATES your
mailbox — it is opt-in and needs a gmail.modify grant. The default read-only
install will refuse with the exact re-auth command. Enable writes with:
  mail-index setup --account <email> --enable-writes
`;

const LABEL_USAGE = `mail-index label — add/remove labels on a message (OPT-IN write)

Usage:
  mail-index label <account:message-id> [--add <label>]... [--remove <label>]...

Adds and/or removes Gmail labels (system ids like STARRED/UNREAD, or existing
user-label names; --add and --remove each repeatable). This MUTATES your mailbox
— opt-in, needs a gmail.modify grant. Creating new labels is not supported.
Enable writes with: mail-index setup --account <email> --enable-writes
`;

const GRAPH_USAGE = `mail-index graph — derived contact-graph analysis (lazy)

Usage:
  mail-index graph build [--account <label>]
  mail-index graph build --all-accounts

Builds the co-recipiency graph over non-list threads, runs PageRank centrality
and Louvain community detection, and persists centrality + community_id back
onto contacts. Reads the index only — never the provider. Heavy relative to an
incremental sweep, so sync auto-runs it only after a full/initial sync.

Options:
  --account <label>   Account label from the operator config (required unless --all-accounts)
  --all-accounts      Build the graph for every configured account
`;

const COMPACT_USAGE = `mail-index compact — demote summarized bulk bodies (ADR-0003)

Usage:
  mail-index compact [--account <label>] [--now]
  mail-index compact --all-accounts [--now]

For each message that has an agent-written summary and is bulk (is_list or
promotions/social) and NOT a curated-important sender or user-participated
thread, once past the grace window (default 7 days) the distilled body is
dropped and the row moves to summary-only — FTS then indexes the summary. The
provider remains the archive, so this is never data loss (Working set).
INDEX-ONLY: reads + rewrites the local index, never the provider.

Options:
  --account <label>   Account to compact (default: the sole configured account)
  --all-accounts      Compact every configured account
  --now               Ignore the grace window — demote every eligible body now
`;

const STATUS_USAGE = `mail-index status — per-account index freshness + counts

Usage:
  mail-index status [--json]

Options:
  --json   Emit a machine-readable JSON report (for tray/scheduler use)
`;

const CADENCE_USAGE = `mail-index cadence — inbound frequency per sender brand

Groups received mail by registrable (brand) domain and reports volume, distinct
senders, first/last seen, and messages-per-month. Optionally restrict to one
agent-assigned entity category (e.g. a vertical you tagged via save_domain_category).

Usage:
  mail-index cadence --account <label> [--category <c>] [--since <30d|1mo|ISO>] [--limit N] [--json]

Options:
  --account <label>   Account to report (required unless only one is configured)
  --category <c>      Only senders whose domain carries this entity category
  --since <token>     Only mail on/after this point (e.g. 30d, 1mo, or ISO-8601)
  --limit N           Cap to the top-N brands by volume
  --json              Emit a machine-readable JSON report
`;

/** Parse a `--limit`-style integer flag, throwing a CLI error on bad input. */
function parseLimit(raw: string | undefined, flag: string): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new CliError(`${flag} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** A user-facing CLI error: message goes to stderr, exit code 2. */
class CliError extends Error {
  override name = 'CliError';
}

function cmdInit(): number {
  const result = runInit();
  process.stdout.write(formatInit(result));
  return 0;
}

async function cmdSetup(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      adapter: { type: 'string' },
      client: { type: 'string' },
      since: { type: 'string' },
      'no-sync': { type: 'boolean' },
      'enable-writes': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(SETUP_USAGE);
    return 0;
  }

  if (!values.account) {
    throw new CliError('setup requires --account <email>');
  }
  if (values.adapter != null && values.adapter !== 'gog' && values.adapter !== 'gws') {
    throw new CliError(`--adapter must be "gog" or "gws", got "${values.adapter}"`);
  }

  const opts: SetupOptions = {
    account: values.account,
    ...(values.adapter ? { adapter: values.adapter as 'gog' | 'gws' } : {}),
    ...(values.client ? { client: values.client } : {}),
    ...(values.since ? { since: values.since } : {}),
    ...(values['no-sync'] ? { noSync: true } : {}),
    ...(values['enable-writes'] ? { enableWrites: true } : {}),
    ...(values.json ? { json: true } : {}),
  };

  const result = await runSetup(opts, defaultDeps());
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatSetup(result));
  }
  // A run that still needs a human/agent action exits non-zero so a wrapping
  // script can detect "not fully onboarded yet".
  return result.steps.some((s) => s.status === 'action') ? 1 : 0;
}

async function cmdSync(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      since: { type: 'string' },
      all: { type: 'boolean' },
      query: { type: 'string' },
      limit: { type: 'string' },
      'all-accounts': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(SYNC_USAGE);
    return 0;
  }

  const flags: SyncFlags = {
    since: values.since,
    all: values.all,
    query: values.query,
    limit: parseLimit(values.limit, '--limit'),
  };

  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);

    if (values['all-accounts']) {
      if (Object.keys(config.accounts).length === 0) {
        throw new CliError('no accounts configured — run mail-index init and edit the config');
      }
      const outcomes = await runSyncAll(config, flags, repo);
      let failures = 0;
      for (const outcome of outcomes) {
        if (outcome.result) {
          process.stdout.write(formatSyncResult(outcome.result) + '\n');
        } else {
          failures += 1;
          process.stderr.write(`${outcome.account}: sync failed — ${outcome.error}\n`);
        }
      }
      return failures > 0 ? 1 : 0;
    }

    if (!values.account) {
      throw new CliError('sync requires --account <label> (or --all-accounts)');
    }
    const result = await runSyncOne(config, values.account, flags, repo);
    process.stdout.write(formatSyncResult(result) + '\n');
    return 0;
  } finally {
    db.close();
  }
}

async function cmdEnrich(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      profile: { type: 'boolean' },
      rule: { type: 'string' },
      sender: { type: 'string' },
      match: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(ENRICH_USAGE);
    return 0;
  }

  if (!values.account) {
    throw new CliError('enrich requires --account <label>');
  }
  if (values.rule != null && values.rule !== 'direct' && values.rule !== 'all') {
    throw new CliError(`--rule must be "direct" or "all", got "${values.rule}"`);
  }

  // `--profile` resolves the candidate set from the curated interest_profile and
  // ignores the heuristic selectors; flag the conflict rather than silently
  // dropping --rule/--sender/--match.
  if (values.profile && (values.rule != null || values.sender != null || values.match != null)) {
    throw new CliError('--profile cannot be combined with --rule/--sender/--match (the profile IS the policy)');
  }

  const limit = parseLimit(values.limit, '--limit');
  const selector: EnrichSelector = values.profile
    ? { profile: true, ...(limit != null ? { limit } : {}) }
    : {
        ...(values.rule ? { rule: values.rule as 'direct' | 'all' } : {}),
        ...(values.sender ? { sender: values.sender } : {}),
        ...(values.match ? { match: values.match } : {}),
        ...(limit != null ? { limit } : {}),
      };

  const config = loadConfig();
  const account = resolveAccount(config, values.account);
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const source = buildSource(account);
    const result = await enrich({ account: values.account, source, repo, selector });
    const sel = result.selector ? ` (${result.selector})` : '';
    process.stdout.write(`${result.account}: fetched ${result.fetched}, enriched ${result.enriched}${sel}\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdCurate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(CURATE_USAGE);
    return 0;
  }

  // INDEX-ONLY (PLAN §4): the wizard needs the account LABEL (to scope the
  // index), not an adapter binding — but loadConfig is still the source of
  // truth for which accounts exist. Default to the sole configured account when
  // `--account` is omitted; require it when there is ambiguity.
  const config = loadConfig();
  const labels = Object.keys(config.accounts);
  let account = values.account;
  if (account == null) {
    if (labels.length === 1) {
      account = labels[0]!;
    } else if (labels.length === 0) {
      throw new CliError('no accounts configured — run mail-index init and edit the config');
    } else {
      throw new CliError(`curate requires --account <label> (configured: ${labels.join(', ')})`);
    }
  }
  // Validate the label exists (throws ConfigError otherwise).
  resolveAccount(config, account);

  const limit = parseLimit(values.limit, '--limit');
  const db = await openDb();
  const prompter = readlinePrompter();
  try {
    const repo = new Repo(db);
    const result = await runCurate(repo, account, prompter, {
      ...(limit != null ? { contactLimit: limit, domainLimit: limit } : {}),
    });
    process.stdout.write(formatCurate(result));
    return 0;
  } finally {
    prompter.close();
    db.close();
  }
}

async function cmdSearch(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      limit: { type: 'string' },
      enrich: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(SEARCH_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('search requires one or more terms');
  }

  const flags: SearchFlags = {
    account: values.account,
    limit: parseLimit(values.limit, '--limit'),
    enrich: values.enrich,
  };

  // `--enrich` reaches the provider, so it needs the operator config (account →
  // adapter). A plain search never opens the config — pass an empty one, which
  // runSearchEnriching ignores when `enrich` is unset (it returns plain hits).
  const config = values.enrich ? loadConfig() : { accounts: {} };
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const rows = await runSearchEnriching(config, repo, positionals, flags);
    process.stdout.write(formatResults(rows, positionals));
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `inbox` / `labeled <LABEL>` — list messages carrying a Gmail label, newest
 * first. `inbox` is sugar for `labeled INBOX` (the membership the per-sync
 * reconcile keeps exact). A fixed `label` (from the `inbox` route) takes no
 * positional; otherwise the label is the sole positional.
 */
async function cmdLabeled(argv: string[], label?: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(LABELED_USAGE);
    return 0;
  }

  const resolved = label ?? positionals[0];
  if (resolved == null || resolved === '') {
    throw new CliError('labeled requires a label name (e.g. mail-index labeled UNREAD)');
  }

  const limit = parseLimit(values.limit, '--limit');
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const rows = await repo.messagesByLabel(resolved, {
      ...(values.account ? { account: values.account } : {}),
      ...(limit != null ? { limit } : {}),
    });
    process.stdout.write(formatLabelResults(rows, resolved));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdShow(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(SHOW_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('show requires a <account:message-id> reference');
  }
  if (positionals.length > 1) {
    throw new CliError('show takes a single <account:message-id> reference');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const result = await runShow(config, repo, ref);
    process.stdout.write(formatShow(result));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdOpen(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(OPEN_USAGE);
    return 0;
  }

  if (positionals.length === 0) {
    throw new CliError('open requires a <account:message-id> reference');
  }
  if (positionals.length > 1) {
    throw new CliError('open takes a single <account:message-id> reference');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const result = await runOpen(config, repo, ref);
    process.stdout.write(formatOpen(result));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdArchive(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean' } },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(ARCHIVE_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    throw new CliError('archive requires a single <account:message-id> reference');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const result = await runLabelChange(config, repo, ref, archiveChange());
    process.stdout.write(formatMutateResult('archived', result));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdLabel(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      add: { type: 'string', multiple: true },
      remove: { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(LABEL_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    throw new CliError('label requires a single <account:message-id> reference');
  }
  const add = (values.add ?? []) as string[];
  const remove = (values.remove ?? []) as string[];
  if (add.length === 0 && remove.length === 0) {
    throw new CliError('label requires at least one --add <label> or --remove <label>');
  }

  const ref = parseRef(positionals[0]!);
  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);
    const result = await runLabelChange(config, repo, ref, {
      addLabelIds: add,
      removeLabelIds: remove,
    });
    process.stdout.write(formatMutateResult('labeled', result));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdGraph(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  // `graph` currently has one subcommand, `build`. Treat help / missing sub as
  // usage, and reject anything else.
  if (sub == null || sub === '--help' || sub === '-h') {
    process.stdout.write(GRAPH_USAGE);
    return 0;
  }
  if (sub !== 'build') {
    throw new CliError(`unknown graph subcommand "${sub}" (expected "build")`);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      account: { type: 'string' },
      'all-accounts': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(GRAPH_USAGE);
    return 0;
  }

  // The graph engine is INDEX-ONLY (PLAN §4): it needs account labels, not
  // adapter bindings, but loadConfig is still the source of truth for which
  // accounts exist.
  const config = loadConfig();
  const db = await openDb();
  try {
    const repo = new Repo(db);

    if (values['all-accounts']) {
      if (Object.keys(config.accounts).length === 0) {
        throw new CliError('no accounts configured — run mail-index init and edit the config');
      }
      for (const result of await runGraphBuildAll(config, repo)) {
        process.stdout.write(formatGraphResult(result) + '\n');
      }
      return 0;
    }

    if (!values.account) {
      throw new CliError('graph build requires --account <label> (or --all-accounts)');
    }
    // Resolve to validate the label exists in the config (throws ConfigError if not).
    resolveAccount(config, values.account);
    const result = await runGraphBuildOne(repo, values.account);
    process.stdout.write(formatGraphResult(result) + '\n');
    return 0;
  } finally {
    db.close();
  }
}

async function cmdCompact(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      'all-accounts': { type: 'boolean' },
      now: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(COMPACT_USAGE);
    return 0;
  }

  // INDEX-ONLY (PLAN §4): compaction needs only the account LABEL to scope the
  // index, not an adapter binding — but loadConfig is the source of truth for
  // which accounts exist.
  const config = loadConfig();
  const labels = Object.keys(config.accounts);
  const opts = values.now ? { now: true } : {};

  const db = await openDb();
  try {
    const repo = new Repo(db);

    if (values['all-accounts']) {
      if (labels.length === 0) {
        throw new CliError('no accounts configured — run mail-index init and edit the config');
      }
      for (const label of labels) {
        const result = await compact(repo, label, opts);
        process.stdout.write(`${result.account}: demoted ${result.demoted} body(ies) to summary-only\n`);
      }
      return 0;
    }

    let account = values.account;
    if (account == null) {
      if (labels.length === 1) {
        account = labels[0]!;
      } else if (labels.length === 0) {
        throw new CliError('no accounts configured — run mail-index init and edit the config');
      } else {
        throw new CliError(`compact requires --account <label> (configured: ${labels.join(', ')})`);
      }
    }
    resolveAccount(config, account);

    const result = await compact(repo, account, opts);
    process.stdout.write(`${result.account}: demoted ${result.demoted} body(ies) to summary-only\n`);
    return 0;
  } finally {
    db.close();
  }
}

async function cmdStatus(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(STATUS_USAGE);
    return 0;
  }

  const db = await openDb();
  try {
    const repo = new Repo(db);
    const report = await buildStatus(repo);
    process.stdout.write(values.json ? formatStatusJson(report) : formatStatus(report));
    return 0;
  } finally {
    db.close();
  }
}

async function cmdCadence(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      account: { type: 'string' },
      category: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(CADENCE_USAGE);
    return 0;
  }

  // INDEX-ONLY (PLAN §4): cadence needs only the account LABEL; loadConfig is
  // the source of truth for which accounts exist (and the sole-account default).
  const config = loadConfig();
  const labels = Object.keys(config.accounts);
  let account = values.account;
  if (account == null) {
    if (labels.length === 1) {
      account = labels[0]!;
    } else if (labels.length === 0) {
      throw new CliError('no accounts configured — run mail-index init and edit the config');
    } else {
      throw new CliError(`cadence requires --account <label> (configured: ${labels.join(', ')})`);
    }
  }

  const flags: CadenceFlags = {
    account,
    category: values.category,
    since: values.since,
    limit: parseLimit(values.limit, '--limit'),
  };

  const db = await openDb();
  try {
    const repo = new Repo(db);
    const rows = await runCadence(repo, flags);
    process.stdout.write(values.json ? formatCadenceJson(rows) : formatCadence(rows, flags));
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command == null || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case 'init':
      return cmdInit();
    case 'setup':
      return cmdSetup(rest);
    case 'sync':
      return cmdSync(rest);
    case 'enrich':
      return cmdEnrich(rest);
    case 'curate':
      return cmdCurate(rest);
    case 'search':
      return cmdSearch(rest);
    case 'inbox':
      return cmdLabeled(rest, 'INBOX');
    case 'labeled':
      return cmdLabeled(rest);
    case 'show':
      return cmdShow(rest);
    case 'open':
      return cmdOpen(rest);
    case 'archive':
      return cmdArchive(rest);
    case 'label':
      return cmdLabel(rest);
    case 'graph':
      return cmdGraph(rest);
    case 'compact':
      return cmdCompact(rest);
    case 'cadence':
      return cmdCadence(rest);
    case 'status':
      return cmdStatus(rest);
    default:
      process.stderr.write(`unknown command "${command}"\n\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (
      err instanceof ConfigError ||
      err instanceof IndexError ||
      err instanceof SyncError ||
      err instanceof EnrichError ||
      err instanceof CliError ||
      err instanceof SetupError ||
      err instanceof RefError
    ) {
      process.stderr.write(`error: ${err.message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
    } else {
      process.stderr.write(`error: ${String(err)}\n`);
    }
    process.exit(2);
  });
