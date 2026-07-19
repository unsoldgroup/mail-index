/**
 * `mail-index search` (SCOPE 0.7, PLAN §13, CONTEXT.md "Recall").
 *
 * Ranked FTS recall over the index, snippet-first. Honours the recall-not-lookup
 * spirit: the terms are treated as a fuzzy bag, not an exact key. Output is the
 * compact one-line-per-hit shape an agent (or human) skims:
 *
 *   sender · subject · date · snippet · ref
 *
 * where `ref` is the `<account>:<gmail-message-id>` handle the `show` / `open`
 * commands (M1) consume. Bodies are never dumped here — snippet only — keeping
 * the surface token-budget-conscious by default.
 */

import { resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import { buildMatch } from '../index/fts.js';
import { Repo, type MessageRow } from '../index/repo.js';
import type { MailSource } from '../source/index.js';
import { enrichOne } from '../ingest/enrich.js';

import { buildSource } from './sync.js';

/** Options for {@link runSearch}. */
export interface SearchFlags {
  account?: string;
  limit?: number;
  /** `--enrich` — promote the returned hits' bodies before printing (SCOPE 1.2). */
  enrich?: boolean;
}

/** Run a search, returning ranked rows (best first). */
export async function runSearch(
  repo: Repo,
  terms: readonly string[],
  flags: SearchFlags,
): Promise<MessageRow[]> {
  const query = buildMatch(terms, { expand: true });
  if (query === '') return [];
  return await repo.searchMessages(query, { account: flags.account, limit: flags.limit ?? 20 });
}

/**
 * Run a search and, with `--enrich`, promote the returned hits' bodies first
 * (SCOPE 1.2). After ranking the hits this enriches each still-`meta` hit
 * in place ({@link enrichOne}) — O(N) over the bounded hit set, which is fine in
 * CLI context (ADR-0001 restricts the O(1)-inline rule to MCP). It then re-runs
 * the same search so the returned/printed rows reflect the freshly distilled
 * bodies (snippets and any newly-matching body terms); without `--enrich` it is
 * exactly {@link runSearch}.
 *
 * Enrichment needs the per-account adapter, so it resolves each hit's account
 * against the operator config and builds its source. `buildSourceFn` is
 * injectable for tests. A hit whose account is unconfigured, or whose enrich
 * fetch fails, is skipped (best-effort) rather than aborting the whole search —
 * recall must still return the ranked set.
 */
export async function runSearchEnriching(
  config: OperatorConfig,
  repo: Repo,
  terms: readonly string[],
  flags: SearchFlags,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<MessageRow[]> {
  const hits = await runSearch(repo, terms, flags);
  if (!flags.enrich || hits.length === 0) return hits;

  // Build (and cache) one source per distinct account across the hit set, so a
  // multi-account result set does not rebuild an adapter per hit.
  const sources = new Map<string, MailSource | null>();
  let promotedAny = false;
  for (const hit of hits) {
    if (hit.body_state !== 'meta') continue;
    let source = sources.get(hit.account);
    if (source === undefined) {
      try {
        source = buildSourceFn(resolveAccount(config, hit.account));
      } catch {
        source = null; // unconfigured account — skip its hits, keep the rest.
      }
      sources.set(hit.account, source);
    }
    if (!source) continue;
    try {
      const promoted = await enrichOne({
        account: hit.account,
        id: hit.gmail_message_id,
        source,
        repo,
      });
      promotedAny ||= promoted;
    } catch {
      // Best-effort: a single hit's fetch failure must not sink the search.
    }
  }

  // Re-run so the printed snippets/rankings reflect the enriched bodies.
  return promotedAny ? runSearch(repo, terms, flags) : hits;
}

/** The `<account>:<gmail-message-id>` reference handle (matches `show`/`open`). */
export function messageRef(row: MessageRow): string {
  return `${row.account}:${row.gmail_message_id}`;
}

/** Render an `internal_date` (epoch ms) as a compact `YYYY-MM-DD`, or `?`. */
function formatDate(internalDate: number | null): string {
  if (internalDate == null) return '?';
  const d = new Date(internalDate);
  if (Number.isNaN(d.getTime())) return '?';
  return d.toISOString().slice(0, 10);
}

/** Collapse a snippet to a single trimmed line, capped for skimmability. */
function compactSnippet(snippet: string | null, max = 100): string {
  if (!snippet) return '';
  const oneLine = snippet.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Format one hit as the compact `sender · subject · date · snippet · ref` line. */
export function formatHit(row: MessageRow): string {
  const sender = row.from_addr ?? '(unknown sender)';
  const subject = row.subject ?? '(no subject)';
  const date = formatDate(row.internal_date);
  const snippet = compactSnippet(row.snippet);
  const ref = messageRef(row);
  const parts = [sender, subject, date];
  if (snippet) parts.push(snippet);
  parts.push(ref);
  return parts.join(' · ');
}

/** Format the whole result set (header + one line per hit, or an empty notice). */
export function formatResults(rows: readonly MessageRow[], terms: readonly string[]): string {
  if (rows.length === 0) {
    return `No matches for "${terms.join(' ')}".\n`;
  }
  const lines = rows.map(formatHit);
  return lines.join('\n') + '\n';
}

/**
 * Format a label listing (the `inbox` / `labeled` commands) — same one-line hit
 * shape as search, with a count header and an empty notice naming the label.
 */
export function formatLabelResults(rows: readonly MessageRow[], label: string): string {
  if (rows.length === 0) {
    return `No messages labeled ${label}.\n`;
  }
  const header = `${rows.length} message${rows.length === 1 ? '' : 's'} labeled ${label}:`;
  return [header, ...rows.map(formatHit)].join('\n') + '\n';
}
