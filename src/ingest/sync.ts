/**
 * Sync phase 1 — metadata sweep (SCOPE 0.6, PLAN §7 phase 1, D12, ADR-0005).
 *
 * For every Message id in scope (from {@link MailSource.listIds}) this performs
 * one `getMetadata` fetch, classifies it (§8 — category / is_list / direction),
 * snapshots its current `unread`/`starred`/`important` flags (D12: store the
 * state as observed, no history here), and upserts it into the index at
 * `body_state='meta'`. The repo (`index/repo.ts`) keeps the FTS row in lockstep
 * (subject / sender / recipients / snippet) and enforces the two binding
 * invariants this phase relies on:
 *
 *  1. **Idempotent** — upsert by `(account, gmail_message_id)`; a re-run over
 *     the same mailbox produces the same rows, never duplicates.
 *  2. **No-downgrade** — a phase-1 `meta` upsert never clobbers an existing
 *     `full` / `summary-only` body (a re-sync after enrichment is safe).
 *
 * Every run writes a `sync_runs` audit row (phase / selector / started /
 * finished / fetched / indexed / error). That same in-progress row IS the
 * per-account LOCK (ADR-0005): {@link syncMetadata} refuses to start a second
 * run for an account while another is in flight, and always closes its own row
 * (success or failure) so the lock is released.
 *
 * This module is provider-neutral: it speaks only the {@link MailSource}
 * contract and the {@link Repo}. The CLI (SCOPE 0.7) wires a concrete adapter
 * and account label in; tests wire the in-memory {@link FakeMailSource}.
 */

import type { MailScope, MailSource } from '../source/index.js';
import type { Repo } from '../index/repo.js';
import { IndexError } from '../index/db.js';
import { classifyMessage } from './classify.js';
import { aggregateAccount } from '../intelligence/aggregate.js';
import { interestPass } from '../intelligence/interest.js';
import { compact } from '../writeback/index.js';

/** Error thrown when a sync cannot start or run (lock contention, etc.). */
export class SyncError extends Error {
  override name = 'SyncError';
}

/** Options for {@link syncMetadata}. */
export interface SyncOptions {
  /** The account label this run indexes under (the index partition key). */
  account: string;
  /** The provider adapter to sweep. */
  source: MailSource;
  /** The repo to persist into. */
  repo: Repo;
  /** Which messages to sweep. Empty = the adapter's own default scope (§15). */
  scope?: MailScope;
  /**
   * How many ids to fetch per `getMetadata` batch. Real adapters fetch one
   * Gmail `messages.get` per id under the hood; this only bounds how many ids
   * we hand the adapter at once. Defaults to 50.
   */
  batchSize?: number;
  /**
   * Whether to run the derived contact/domain/thread aggregation pass (M2.1)
   * after the metadata sweep. Defaults to `true`: aggregation is cheap,
   * INDEX-ONLY (PLAN §4), and idempotent, so a sync leaves the derived tables
   * current. Set `false` to sweep without rebuilding aggregates (e.g. when a
   * caller batches many syncs and aggregates once at the end).
   */
  aggregate?: boolean;
  /**
   * Whether to auto-invoke `compact` after the aggregation pass to demote
   * summarized bulk bodies past the grace window (ADR-0003). Defaults to `true`
   * — demotion keeps the index a small Working set and is INDEX-ONLY +
   * idempotent. Gated on `aggregate` (a no-aggregate sweep skips it too, since
   * eligibility reads the curation/thread state aggregation refreshes). Set
   * `false` to sweep without compacting.
   */
  compact?: boolean;
}

/** Outcome of a completed (or failed-then-recorded) sync run. */
export interface SyncResult {
  /** The `sync_runs.id` of the audit row written for this run. */
  runId: number;
  /** The account this run swept. */
  account: string;
  /** Number of metadata records fetched from the source. */
  fetched: number;
  /** Number of Messages upserted into the index. */
  indexed: number;
  /** The selector recorded for the run (a human-readable scope summary). */
  selector: string | null;
  /** Message ids returned by this source sweep; consumers must evaluate only this set. */
  messageIds: string[];
}

/**
 * Render a {@link MailScope} into the compact, greppable `selector` string the
 * `sync_runs` audit row stores. Stable key order; omits empty fields. `null`
 * (stored as SQL NULL) when the scope is empty — i.e. a whole-mailbox sweep.
 */
function describeScope(scope: MailScope | undefined): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  if (scope.query) parts.push(`query=${scope.query}`);
  if (scope.since) parts.push(`since=${scope.since}`);
  if (scope.limit != null) parts.push(`limit=${scope.limit}`);
  if (scope.includeSent != null) parts.push(`includeSent=${scope.includeSent}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Acquire the per-account lock by opening a `sync_runs` row, atomically
 * refusing if another run for the account is already in flight (ADR-0005).
 *
 * The check-and-insert runs in a single IMMEDIATE transaction on the one
 * synchronous connection, so two callers cannot both pass the "no active run"
 * check: node:sqlite executes statements serially, and the IMMEDIATE write lock
 * serialises any concurrent file-backed writer. Returns the new run's id.
 */
async function acquireLock(
  repo: Repo,
  account: string,
  selector: string | null,
): Promise<number> {
  const id = await repo.acquireSyncRun({ account, phase: 'sync', selector });
  if (id == null) throw new SyncError(`a sync for account "${account}" is already in progress; refusing to start a second concurrent run`);
  return id;
}

/**
 * Pin an account label to the mailbox it first indexed (migration 3). On first
 * sync, records the authenticated address as the label's identity. On every
 * later sync, asserts the adapter still resolves to that same address — so a
 * transport switch (gws ↔ gog) to the *same* mailbox reuses the cached index,
 * while accidentally pointing the label at a *different* mailbox is blocked
 * before any row is written. The provider may change; the mailbox may not.
 */
async function guardAccountIdentity(
  repo: Repo,
  account: string,
  address: string,
  provider: string,
): Promise<void> {
  const existing = await repo.getAccountIdentity(account);
  if (!existing) {
    await repo.setAccountIdentity(account, address, provider);
    return;
  }
  if (existing.address.toLowerCase() !== address.toLowerCase()) {
    throw new SyncError(
      `account "${account}" is indexed for mailbox <${existing.address}>, but the ` +
        `"${provider}" adapter authenticated as <${address}> — refusing to sync, to avoid ` +
        `mixing two mailboxes under one label. Point the label back at <${existing.address}>, ` +
        `or use a separate label for <${address}> (whose index is kept independent).`,
    );
  }
  // Same mailbox, possibly a new transport: refresh provider + last_verified.
  await repo.setAccountIdentity(account, existing.address, provider);
}

/**
 * Run a phase-1 metadata sweep over `scope` for one account.
 *
 * Steps: probe identity (so the account's own address feeds `direction`
 * classification), acquire the lock, enumerate ids, fetch + classify + upsert
 * each in `meta` state, then close the audit row with counts. On any failure
 * the audit row is still closed (with `error`) and the lock released, then the
 * error rethrown.
 */
export async function syncMetadata(options: SyncOptions): Promise<SyncResult> {
  const { account, source, repo } = options;
  if (!account || account.trim() === '') {
    throw new SyncError('syncMetadata requires a non-empty account label');
  }

  const batchSize = options.batchSize ?? 50;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new SyncError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }

  const selector = describeScope(options.scope);

  // Identity probe before the sweep: a known own-address makes `direction`
  // classification robust to Sent mail that lost its SENT label (§8). A failed
  // probe is non-fatal here (the address just stays unknown) — listIds will
  // surface a real connectivity failure.
  const knownAddresses: string[] = [];
  try {
    const identity = await source.check();
    if (identity.ok && identity.address) {
      knownAddresses.push(identity.address);
      // Adapter-switch safety: pin the label to the mailbox it first indexed.
      // The transport (gws ↔ gog) may change freely — the cached index keys on
      // (account, gmail_message_id) and Gmail ids are provider-independent, so a
      // switch reuses every row. But the bound *mailbox* may not change: that
      // would mix two mailboxes under one label. Block the mismatch up front.
      await guardAccountIdentity(repo, account, identity.address, source.provider);
    }
  } catch (err) {
    // A deliberate identity mismatch is fatal (protects the cache); any other
    // probe failure is tolerated (classification falls back to labels alone).
    if (err instanceof SyncError) throw err;
  }

  const runId = await acquireLock(repo, account, selector);

  let fetched = 0;
  let indexed = 0;
  const messageIds: string[] = [];
  try {
    // Enumerate the scope lazily, fetching metadata in bounded batches so a
    // large mailbox never buffers every id in memory at once.
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const metas = await source.getMetadata(batch);
      fetched += metas.length;
      for (const meta of metas) {
        const { category, isList, direction } = classifyMessage({
          labels: meta.labels,
          headers: meta.headers,
          from: meta.from,
          knownAddresses,
        });

        const labels = meta.labels;
        await repo.upsertMessage({
          account,
          gmailMessageId: meta.id,
          rfcMessageId: meta.messageId ?? null,
          threadId: meta.threadId,
          internalDate: meta.internalDate,
          dateHeader: meta.dateHeader,
          fromAddr: meta.from,
          toAddr: meta.to,
          ccAddr: meta.cc,
          replyTo: meta.replyTo,
          originFrom: meta.originFrom,
          subject: meta.subject,
          labels,
          category,
          isList,
          direction,
          // D12: snapshot current state as observed from the labels.
          unread: labels.includes('UNREAD'),
          starred: labels.includes('STARRED'),
          important: labels.includes('IMPORTANT'),
          sizeEstimate: meta.sizeEstimate,
          snippet: meta.snippet,
          bodyState: 'meta',
        });
        indexed += 1;
        messageIds.push(meta.id);
      }
      batch = [];
    };

    for await (const id of source.listIds(options.scope)) {
      batch.push(id);
      if (batch.length >= batchSize) await flush();
    }
    await flush();

    await repo.finishSyncRun(runId, { fetched, indexed });
  } catch (err) {
    // Always close the audit row so the lock is released, then rethrow.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await repo.finishSyncRun(runId, { fetched, indexed, error: message });
    } catch {
      // If we cannot even close the row (e.g. the DB is gone), there is nothing
      // more to do; surface the original failure below.
    }
    if (err instanceof SyncError || err instanceof IndexError) throw err;
    throw new SyncError(`sync failed for account "${account}": ${message}`);
  }

  // Derived, INDEX-ONLY aggregation (M2.1, PLAN §4): roll the now-current
  // messages up into contacts/domains/threads. Runs after the audit row is
  // closed (lock released) since it touches only the derived tables. Idempotent
  // — safe on every sync. The probed own-address(es) keep the user out of their
  // own contact list and feed Correspondent detection on Sent mail (D11).
  if (options.aggregate !== false) {
    await aggregateAccount(repo, account, knownAddresses);
    // Interest engine (M2.2, D12): recompute every contact's engagement_score
    // from the now-current aggregates and append a per-contact snapshot. Still
    // INDEX-ONLY and idempotent; the score is a curation SEED, never a fetch
    // trigger (D13), so this never enriches. Gated on the same `aggregate` flag
    // since it consumes the aggregates this run just rebuilt.
    await interestPass(repo, account);

    // Demotion (ADR-0003): once a bulk body has a summary older than the grace
    // window, drop the distilled body — summary-only is the end state, and the
    // provider remains the archive (Working set). Default grace (7 days); this
    // only demotes eligible rows, so a fresh sync with no aged summaries is a
    // no-op. Gated on the same aggregate flag since eligibility reads the
    // curation + thread-participation state the aggregation just rebuilt.
    if (options.compact !== false) {
      await compact(repo, account);
    }
  }

  return { runId, account, fetched, indexed, selector, messageIds };
}
