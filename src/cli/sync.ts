/**
 * `mail-index sync` (SCOPE 0.7, PLAN §13, §7 phase 1, §15 multi-account).
 *
 * Resolves an account label to its adapter config (operator config, §15),
 * builds the concrete {@link MailSource} for that adapter, overlays the CLI
 * sync flags onto the account's stored `syncPolicy`, and runs the phase-1
 * metadata sweep ({@link syncMetadata}). Prints a concise fetched/indexed
 * summary.
 *
 * `--all-accounts` is a thin loop over every configured account (each is an
 * independent sweep using its own policy presets); a per-account failure does
 * not abort the others.
 *
 * Adapter construction lives here (not in the ingest layer) so the ingest layer
 * stays provider-neutral — it only ever sees the {@link MailSource} contract.
 * The adapter `id` → builder map is the single place a new adapter is wired for
 * the CLI.
 */

import { expandHome, resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import { Repo } from '../index/repo.js';
import { GwsAdapter } from '../source/adapters/gws/index.js';
import { GogAdapter } from '../source/adapters/gog/index.js';
import type { MailScope, MailSource } from '../source/index.js';
import { syncMetadata, type SyncResult } from '../ingest/sync.js';
import { reconcileInbox } from '../ingest/reconcile-inbox.js';
import { syncLabels } from '../ingest/sync-labels.js';
import { buildGraph } from '../graph/index.js';

/** CLI-supplied sync flags (already parsed; all optional). */
export interface SyncFlags {
  since?: string;
  /** `--all` — whole mailbox: clears `since`/`limit` so nothing bounds the sweep. */
  all?: boolean;
  query?: string;
  limit?: number;
}

/**
 * Build the concrete {@link MailSource} for an account's adapter binding. The
 * one place CLI sync knows which adapter class backs which `adapter` id.
 */
export function buildSource(account: AccountConfig): MailSource {
  switch (account.adapter) {
    case 'gws':
      return new GwsAdapter({ configDir: expandHome(account.configDir ?? '') });
    case 'gog':
      return new GogAdapter({ account: account.account ?? '' });
    default: {
      // Exhaustiveness guard: AccountConfig.adapter is a closed union, but a
      // future adapter id added to config must be wired here too.
      const unknown: never = account.adapter;
      throw new Error(`no MailSource builder for adapter "${String(unknown)}"`);
    }
  }
}

/**
 * Compose the effective {@link MailScope} for a run: the account's stored
 * `syncPolicy` provides defaults; explicit CLI flags override field-by-field.
 * `--all` means "whole mailbox", so it wins over any `since`/`limit` (from flag
 * or policy) by clearing both. Returns `undefined` when nothing constrains the
 * scope (the adapter's own default policy then applies, per §15).
 */
export function composeScope(account: AccountConfig, flags: SyncFlags): MailScope | undefined {
  const policy = account.syncPolicy ?? {};
  const scope: MailScope = {};

  const query = flags.query ?? policy.query;
  if (query != null) scope.query = query;

  if (policy.includeSent != null) scope.includeSent = policy.includeSent;

  if (!flags.all) {
    const since = flags.since ?? policy.since;
    if (since != null) scope.since = since;
    const limit = flags.limit ?? policy.limit;
    if (limit != null) scope.limit = limit;
  }

  return Object.keys(scope).length > 0 ? scope : undefined;
}

/**
 * Decide whether a sweep with these flags is a FULL or INITIAL sync — the only
 * two triggers for the auto graph build (D10). `--all` is an explicit
 * whole-mailbox (full) sweep; an INITIAL sync is the account's first completed
 * `sync` run (none recorded yet *before* this sweep). Incremental sweeps
 * (a bounded `--since`/policy sweep over an already-synced account) do NOT
 * trigger the graph build — it is heavy relative to an incremental sweep.
 */
function isFullOrInitialSync(flags: SyncFlags, priorCompletedSyncs: number): boolean {
  return Boolean(flags.all) || priorCompletedSyncs === 0;
}

/**
 * Run a single account's sync, returning the ingest layer's result.
 *
 * After a FULL or INITIAL sweep (D10), auto-runs the lazy graph build
 * ({@link buildGraph}) so centrality + communities stay current without the
 * operator remembering a second command. The graph engine is INDEX-ONLY and
 * derived (D8): it runs only after the sweep + aggregation have populated the
 * `threads` rows it reads, and a failure to build the graph never fails the
 * sync (the index is fully usable without it). Incremental sweeps skip it.
 */
export async function runSyncOne(
  config: OperatorConfig,
  label: string,
  flags: SyncFlags,
  repo: Repo,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<SyncResult> {
  const account = resolveAccount(config, label);
  const source = buildSourceFn(account);
  const scope = composeScope(account, flags);

  // Capture the prior completed-sync count BEFORE the sweep so "initial sync"
  // means "no completed sync existed when this one started" (D10).
  const priorCompletedSyncs = await repo.completedSyncCount(label);

  const result = await syncMetadata({ account: label, source, repo, scope });

  // Inbox membership reconcile: the windowed sweep never revisits old mail, so
  // a message archived after it left the window keeps a stale INBOX label. This
  // pass makes "what's in my inbox right now" exact again — bounded by inbox
  // size, INDEX-ONLY, and (like the graph build) never allowed to fail a sync.
  //
  // Skipped when the sweep is explicitly `limit`-bounded: a limit is a cost cap,
  // and reconcile lists (and indexes new ids from) the WHOLE live inbox, which
  // would blow past it. The common cadence (`--since`) sets no limit, so it
  // reconciles; a deliberately capped sweep stays capped (run an unbounded sync
  // to refresh inbox membership).
  if (scope?.limit == null) {
    try {
      let knownAddresses: string[] = [];
      try {
        const identity = await source.check();
        if (identity.ok && identity.address) knownAddresses = [identity.address];
      } catch {
        // Probe failure only weakens direction classification of new inbox mail.
      }
      await reconcileInbox({ account: label, source, repo, knownAddresses });
    } catch {
      // Membership freshness is best-effort; the index stays usable without it.
    }
  }

  // Label catalogue refresh (id → human name): cache the small, stable label map
  // so display can show names instead of opaque ids and writes can resolve a
  // name → id. Like the reconcile, INDEX-ONLY and never allowed to fail a sync.
  try {
    await syncLabels({ account: label, source, repo });
  } catch {
    // Best-effort; a stale/absent catalogue just falls back to raw label ids.
  }

  // D10: auto graph build after a full/initial sync only. Derived + lazy (D8):
  // never let a graph failure mask a successful sync.
  if (isFullOrInitialSync(flags, priorCompletedSyncs)) {
    try {
      await buildGraph(repo, label);
    } catch {
      // The graph layer is optional (D8); a build failure leaves the index
      // fully functional. Swallow so sync still reports success.
    }
  }

  return result;
}

/** Format a completed sync run as the one-line CLI summary. */
export function formatSyncResult(result: SyncResult): string {
  const scope = result.selector ? ` (${result.selector})` : ' (whole mailbox)';
  return `${result.account}: fetched ${result.fetched}, indexed ${result.indexed}${scope}`;
}

/** One account's outcome in an all-accounts sweep (success or isolated failure). */
export interface AccountSyncOutcome {
  account: string;
  /** The completed run, when the account synced successfully. */
  result?: SyncResult;
  /** The failure message, when this account's sweep failed (others continue). */
  error?: string;
}

/**
 * Run phase-1 sync for *every* configured account (SCOPE 1.3, PLAN §15), each
 * using its own stored `syncPolicy` preset overlaid with the shared CLI
 * `flags`. Each account is an independent sweep — its own `sync_runs` row + the
 * per-account lock (enforced down in {@link syncMetadata}) — so one account's
 * failure is captured as an {@link AccountSyncOutcome} error and does NOT abort
 * the rest. Returns one outcome per account, in config order.
 *
 * The loop body reuses {@link runSyncOne}; `buildSourceFn` is threaded through
 * so tests can wire fake sources per account without a live provider.
 */
export async function runSyncAll(
  config: OperatorConfig,
  flags: SyncFlags,
  repo: Repo,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<AccountSyncOutcome[]> {
  const outcomes: AccountSyncOutcome[] = [];
  for (const label of Object.keys(config.accounts)) {
    try {
      const result = await runSyncOne(config, label, flags, repo, buildSourceFn);
      outcomes.push({ account: label, result });
    } catch (err) {
      outcomes.push({ account: label, error: (err as Error).message });
    }
  }
  return outcomes;
}
