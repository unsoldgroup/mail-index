/**
 * Inbox membership reconcile (label freshness; ADR-0005 spirit).
 *
 * Sync selects message ids by *date window* ({@link composeScope}), so an
 * already-indexed message archived after it left the window keeps a stale
 * `INBOX` label in `labels_json` forever — "what's in my inbox right now" would
 * be wrong. This pass makes INBOX *membership* exact again, cheaply:
 *
 *  1. List the live inbox id set `L` from the provider (`in:inbox`) — ids only,
 *     one paged `messages.list`, bounded by inbox size.
 *  2. Index any id in `L` not yet stored (the only fetch this pass does) — same
 *     metadata path as {@link syncMetadata}; the row gains `INBOX` naturally.
 *  3. Diff against the rows currently marked `INBOX`:
 *     - **archived** (was INBOX, not in `L`) → drop `INBOX`.
 *     - **re-inboxed** (in `L`, indexed, not marked INBOX) → add `INBOX`.
 *     Each edit rewrites `labels_json` and recomputes the derived `category`.
 *
 * Membership only: `UNREAD`/`STARRED` on already-indexed inbox rows are NOT
 * refreshed here (that would re-fetch every inbox message) — they refresh via
 * the normal windowed sweep / `--all`. The label edits touch only `labels_json`
 * + `category`, never the body ladder, so the pass is INDEX-ONLY and idempotent.
 */

import type { MailSource } from '../source/index.js';
import type { Repo } from '../index/repo.js';
import { classifyCategory, classifyMessage } from './classify.js';

/** Options for {@link reconcileInbox}. */
export interface ReconcileInboxOptions {
  /** The account label whose inbox membership to reconcile. */
  account: string;
  /** The provider adapter to list the live inbox from. */
  source: MailSource;
  /** The repo to read + edit. */
  repo: Repo;
  /** Own-address(es), for classifying newly-indexed inbox mail (direction, §8). */
  knownAddresses?: readonly string[];
  /** Fetch batch size for newly-indexed inbox ids. Defaults to 50. */
  batchSize?: number;
}

/** Counts from a completed reconcile (for logging / tests). */
export interface ReconcileInboxResult {
  /** Live inbox size reported by the provider. */
  liveCount: number;
  /** Inbox ids newly indexed by this pass. */
  added: number;
  /** Rows that lost `INBOX` (archived since last fetch). */
  archived: number;
  /** Rows that regained `INBOX` (re-inboxed). */
  restored: number;
}

/** Recompute `category` for a label set and persist labels + category together. */
async function writeLabels(
  repo: Repo,
  account: string,
  id: string,
  labels: string[],
): Promise<void> {
  await repo.setMessageLabels(account, id, labels, classifyCategory(labels));
}

/**
 * Reconcile one account's INBOX membership against the live provider inbox.
 * Bounded by inbox size; fetches metadata only for inbox ids not yet indexed.
 */
export async function reconcileInbox(options: ReconcileInboxOptions): Promise<ReconcileInboxResult> {
  const { account, source, repo } = options;
  const knownAddresses = options.knownAddresses ?? [];
  const batchSize = options.batchSize ?? 50;

  // 1. Live inbox id set (ids only — cheap).
  const live = new Set<string>();
  for await (const id of source.listIds({ query: 'in:inbox', includeSent: false })) {
    live.add(id);
  }

  // 2. Index inbox ids we have never seen (the only fetch this pass does).
  const existing = await repo.existingMessageIds(account, [...live]);
  const toIndex = [...live].filter((id) => !existing.has(id));
  let added = 0;
  for (let i = 0; i < toIndex.length; i += batchSize) {
    const metas = await source.getMetadata(toIndex.slice(i, i + batchSize));
    for (const meta of metas) {
      const { category, isList, direction } = classifyMessage({
        labels: meta.labels,
        headers: meta.headers,
        from: meta.from,
        knownAddresses,
      });
      await repo.upsertMessage({
        account,
        gmailMessageId: meta.id,
        threadId: meta.threadId,
        internalDate: meta.internalDate,
        dateHeader: meta.dateHeader,
        fromAddr: meta.from,
        toAddr: meta.to,
        ccAddr: meta.cc,
        subject: meta.subject,
        labels: meta.labels,
        category,
        isList,
        direction,
        unread: meta.labels.includes('UNREAD'),
        starred: meta.labels.includes('STARRED'),
        important: meta.labels.includes('IMPORTANT'),
        sizeEstimate: meta.sizeEstimate,
        snippet: meta.snippet,
        bodyState: 'meta',
      });
      added += 1;
    }
  }

  // 3. Diff stored-INBOX against live: drop archived, restore re-inboxed.
  const storedInbox = await repo.inboxMessageIds(account);
  let archived = 0;
  for (const id of storedInbox) {
    if (live.has(id)) continue;
    const row = await repo.getMessage(account, id);
    if (!row) continue;
    const labels = parseLabels(row.labels_json).filter((l) => l !== 'INBOX');
    await writeLabels(repo, account, id, labels);
    archived += 1;
  }

  const storedInboxSet = new Set(storedInbox);
  let restored = 0;
  for (const id of live) {
    if (!existing.has(id) || storedInboxSet.has(id)) continue; // new ids already have INBOX
    const row = await repo.getMessage(account, id);
    if (!row) continue;
    const labels = parseLabels(row.labels_json);
    if (labels.includes('INBOX')) continue;
    labels.push('INBOX');
    await writeLabels(repo, account, id, labels);
    restored += 1;
  }

  return { liveCount: live.size, added, archived, restored };
}

/** Parse a stored `labels_json` into a string array (empty on absent/bad JSON). */
function parseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
