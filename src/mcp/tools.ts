/**
 * MCP tool engine (SCOPE 3.4, PLAN §12, ADR-0001/0004/0005, CONTEXT.md
 * "Recall" / "Command handback" / "Inline enrichment").
 *
 * The pure, transport-free half of the MCP server: every PLAN §12 tool is a
 * function over a {@link ToolContext} that returns a plain, JSON-serialisable
 * result object. `server.ts` wires these to the stdio `@modelcontextprotocol/sdk`
 * Server; the golden-response tests call them directly against a seeded fixture
 * DB. Splitting the logic out (mirroring the CLI's `run*` seam) keeps the tools
 * testable without a live transport and keeps the entry point thin.
 *
 * Binding constraints these tools honour:
 *
 *  - **READ-ONLY on the mailbox BY DEFAULT (D15).** Every recall tool reads the
 *    LOCAL index. The one permitted read-side provider contact is
 *    `get_message`'s single O(1) inline enrich of a still-`meta` row (ADR-0001).
 *    The ONLY mailbox-mutating tools are the two OPT-IN writers `archive_message`
 *    and `modify_labels` — both require a `gmail.modify` grant (the default
 *    `gmail.readonly` install refuses them with the exact re-auth command) and
 *    are reached only when the user has explicitly opted into writes
 *    (docs/adr/0007-opt-in-mailbox-writes.md).
 *  - **O(N) → COMMAND HANDBACK (ADR-0001).** Anything bulk (sync, bulk enrich,
 *    graph build, compact) is NEVER run inline; the tool returns the exact
 *    `mail-index` CLI command string the agent runs itself (CONTEXT.md "Command
 *    handback"). The CLI is the execution engine; the MCP is the brain.
 *  - **A `freshness` block on EVERY response (ADR-0005).** {@link withMeta} stamps
 *    `index_as_of`, `age_seconds`, `stale`, `syncing`, and the `refresh_command`
 *    onto every result so the agent always knows how fresh the data is and how to
 *    refresh it.
 *  - **Any stale account-scoped read spawns a DETACHED background sync (ADR-0005).**
 *    {@link withMeta} — the single freshness authority — returns current data
 *    immediately AND, when the index is older than {@link STALE_AFTER_MS}, kicks
 *    off an incremental sync (debounced; reuses the existing sync + the sync_runs
 *    lock so there is never a second writer), reporting `sync_started` +
 *    `eta_seconds`. It never blocks.
 *  - **Recall, not lookup (DESIGN TEST a).** `search` is fuzzy ranked FTS;
 *    `find_person` ranks Correspondents first and resolves substrings;
 *    `graph_neighbors` falls back to a ranked near-miss set rather than a bare
 *    empty answer.
 *  - **Token-budget-conscious (DESIGN TEST b).** Compact shapes, snippet-first,
 *    full bodies opt-in (`get_message` level), sensible default limits.
 */

import type { OperatorConfig, AccountConfig } from '../config/index.js';
import type {
  Repo,
  MessageRow,
  ThreadRow,
  ContactDetailRow,
  ContactSort,
  GraphNeighborRow,
} from '../index/index.js';
import type { LabelChange, MailSource } from '../source/index.js';
import { InsufficientScopeError } from '../source/index.js';
import {
  applyLabelChange as applyMailboxLabelChange,
  archiveChange,
  MailboxWriteUnsupportedError,
} from '../ingest/mutate.js';
import type { Curation } from '../index/schema.js';
import { CURATIONS } from '../index/schema.js';
import { enrichOne } from '../ingest/enrich.js';
import { reconcileInbox } from '../ingest/reconcile-inbox.js';
import { isLikelyImageOnly } from '../intelligence/images.js';
import { computeCadence, type CadenceRow } from '../intelligence/cadence.js';
import { buildMatch } from '../index/fts.js';
import { propose, set as curationSet, get as curationGet } from '../curation/index.js';
import {
  saveSummary,
  domainsToCategorize as wbDomainsToCategorize,
  saveDomainCategory as wbSaveDomainCategory,
} from '../writeback/index.js';

/** Error thrown for a tool call that cannot proceed (bad ref, unknown tool). */
export class McpToolError extends Error {
  override name = 'McpToolError';
}

/**
 * Spawn a DETACHED background incremental sync for an account (ADR-0005). The
 * server wires a real implementation that re-execs the `mail-index sync` CLI
 * detached (so it outlives the MCP request — a request-scoped child cannot, per
 * ADR-0005); tests wire a spy. Returns `true` when a sync was actually started,
 * `false` when it was debounced/declined (e.g. a sync is already running).
 */
export type BackgroundSync = (account: string, since?: string) => boolean;
export type EnqueueJob = (kind: 'sync' | 'backfill' | 'enrich_bulk', account: string, params?: Record<string, unknown>) => Promise<string>;

/** Everything the tools read/write. INDEX-ONLY except the one O(1) enrich seam. */
export interface ToolContext {
  repo: Repo;
  /** Operator config — used only to resolve an account's adapter for inline enrich. */
  config: OperatorConfig;
  /**
   * Build the per-account {@link MailSource} for the ONE permitted inline enrich
   * (`get_message`, ADR-0001). Optional: when absent (or it throws), a `meta`
   * `get_message` simply returns the meta shape rather than enriching — the
   * server stays usable read-only without provider creds.
   */
  buildSource?: (account: AccountConfig) => MailSource;
  /** Spawn the detached incremental sync for stale time-sensitive reads (ADR-0005). */
  backgroundSync?: BackgroundSync;
  /** Clock seam for deterministic freshness tests. Defaults to `Date`. */
  now?: () => Date;
  /** Remote Deployment Job status; absent locally so the local response shape is unchanged. */
  jobStatus?: (account?: string) => Promise<unknown>;
  enqueueJob?: EnqueueJob;
}

/** The freshness staleness threshold for reads (ADR-0005): "a few hours" (3h).
 * Any account-scoped call on a stale index auto-spawns a background refresh.
 * Per-account override is a v1.x follow-up; this global default matches the ADR. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** Reported ETA for a spawned background incremental sync (ADR-0005). */
export const SYNC_ETA_SECONDS = 90;

// ---- freshness (ADR-0005) -------------------------------------------------

/**
 * The `index_as_of` for an account: the latest finished, error-free sync run.
 * Cross-account (no `account`) returns the OLDEST such timestamp across accounts
 * — the index is only as fresh as its stalest mailbox. Null when never synced.
 */
async function indexAsOf(repo: Repo, account?: string): Promise<string | null> {
  if (account) {
    const row = (await repo.driver
      .prepare(
        `SELECT finished_at FROM sync_runs
          WHERE account = ? AND finished_at IS NOT NULL AND error IS NULL
          ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(account)) as { finished_at: string | null } | undefined;
    return row?.finished_at ?? null;
  }
  const rows = (await repo.driver
    .prepare(
      `SELECT account, max(finished_at) AS f FROM sync_runs
        WHERE finished_at IS NOT NULL AND error IS NULL
        GROUP BY account`,
    )
    .all()) as { account: string; f: string | null }[];
  if (rows.length === 0) return null;
  let oldest: string | null = null;
  for (const r of rows) {
    if (r.f == null) continue;
    if (oldest == null || r.f < oldest) oldest = r.f;
  }
  return oldest;
}

/**
 * The freshness/status block stamped on EVERY response (ADR-0005): tells the
 * agent how stale the index is and how to refresh it, so it never has to guess.
 */
export interface Freshness {
  /** Latest error-free sync completion for the scope (ISO), or null if never synced. */
  index_as_of: string | null;
  /** Age of the index in seconds, or null when never synced. */
  age_seconds: number | null;
  /** True when older than {@link STALE_AFTER_MS} (or never synced). */
  stale: boolean;
  /** True when a sync for this account is in flight right now. */
  syncing: boolean;
  /** The CLI command to refresh this scope manually. */
  refresh_command: unknown;
}

/** A response carrying the ADR-0005 freshness stamp. */
export interface WithMeta {
  /** Kept top-level for back-compat (ADR-0005); mirrors `freshness.index_as_of`. */
  index_as_of: string | null;
  /** Full freshness/status block — present on every response. */
  freshness: Freshness;
  /** Set when this call spawned a background refresh because the index was stale. */
  sync_started?: boolean;
  /** ETA for that background refresh, in seconds. */
  eta_seconds?: number;
}

/**
 * Stamp freshness onto a result AND auto-refresh when stale (ADR-0005).
 *
 * Every response carries a `freshness` block so the agent always knows how fresh
 * the data is and how to refresh it. When the scope is a single account whose
 * index is older than {@link STALE_AFTER_MS} ("a few hours") and no sync is
 * already running, this spawns a DETACHED incremental sync (never blocks) and
 * annotates the result with `sync_started` + `eta_seconds`. The debounce (one
 * writer; the sync_runs lock is the guard) makes calling this on every response
 * safe — this is the single freshness + auto-refresh authority for the server.
 */
async function withMeta<T extends object>(ctx: ToolContext, account: string | undefined, body: T): Promise<T & WithMeta> {
  // When the caller omitted `account` but there's a single mailbox, scope
  // freshness (and the auto-refresh) to it — otherwise a no-account read (the
  // common single-mailbox case) would never auto-refresh. A genuinely
  // multi-account cross read stays cross-account (oldest stamp, no single spawn).
  const acct = account ?? await soleAccount(ctx);
  const asOf = await indexAsOf(ctx.repo, acct);
  const now = (ctx.now?.() ?? new Date()).getTime();
  const ageMs = asOf == null ? null : now - new Date(asOf).getTime();
  const stale = ageMs == null || ageMs > STALE_AFTER_MS;
  const syncing = acct != null && await ctx.repo.activeSyncRun(acct) != null;
  const refresh_command: unknown = ctx.enqueueJob
    ? { kind: 'sync', account: acct ?? null, status: 'available', poll: 'sync_status' }
    : acct ? handback('sync', '--account', acct) : handback('sync', '--all-accounts');

  const meta: WithMeta = {
    index_as_of: asOf,
    freshness: { index_as_of: asOf, age_seconds: ageMs == null ? null : Math.floor(ageMs / 1000), stale, syncing, refresh_command },
  };

  // Auto-refresh on any stale account-scoped read (ADR-0005): spawn a detached
  // INCREMENTAL sync. `since` = days elapsed + 1 day of overlap (idempotent
  // upsert makes re-fetching the boundary day harmless); a never-synced account
  // passes no `since`, so its first sweep is a correct initial full sync.
  if (acct && stale && !syncing && ctx.enqueueJob) {
    const since = asOf == null ? undefined : `${Math.ceil(ageMs! / 86_400_000) + 1}d`;
    const jobId = await ctx.enqueueJob('sync', acct, since ? { since } : {});
    meta.sync_started = true;
    meta.eta_seconds = SYNC_ETA_SECONDS;
    meta.freshness.syncing = true;
    meta.freshness.refresh_command = { job_id: jobId, status: 'queued', poll: 'sync_status' };
  } else if (acct && stale && !syncing && ctx.backgroundSync) {
    const since = asOf == null ? undefined : `${Math.ceil(ageMs! / 86_400_000) + 1}d`;
    if (ctx.backgroundSync(acct, since)) {
      meta.sync_started = true;
      meta.eta_seconds = SYNC_ETA_SECONDS;
      meta.freshness.syncing = true;
    }
  }

  return { ...body, ...meta };
}

// ---- command handbacks (ADR-0001) ----------------------------------------

/** Quote a CLI argument for the handback string when it contains whitespace. */
function quoteArg(v: string): string {
  return /\s/.test(v) ? `'${v.replace(/'/g, "'\\''")}'` : v;
}

/** Build a `mail-index <args...>` command-handback string (CONTEXT.md). */
export function handback(...args: string[]): string {
  return ['mail-index', ...args.map(quoteArg)].join(' ');
}

// ---- compact projections (DESIGN TEST b: token-conscious) -----------------

/** The `<account>:<id>` ref the CLI `show`/`open` consume (shared handle). */
function messageRef(row: Pick<MessageRow, 'account' | 'gmail_message_id'>): string {
  return `${row.account}:${row.gmail_message_id}`;
}

/** Collapse a snippet to one capped line for skimmability. */
function compactSnippet(snippet: string | null, max = 160): string | null {
  if (!snippet) return null;
  const one = snippet.replace(/\s+/g, ' ').trim();
  if (one === '') return null;
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function isoDate(internalDate: number | null): string | null {
  if (internalDate == null) return null;
  const d = new Date(internalDate);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A compact search/thread hit row — snippet-first, never the body. */
export interface HitShape {
  ref: string;
  account: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  body_state: string;
  has_summary: boolean;
  unread: boolean;
  direction: string;
  /** Gmail labels on the message (human names; INBOX, UNREAD, "Coverage Review", …) as last fetched. */
  labels: string[];
}

/**
 * A memoized id→name label renderer over a repo: caches each account's
 * {@link Repo.labelMap} so a result set spanning many rows (and accounts) does
 * one map fetch per account, not per row. Unknown ids pass through.
 */
function labelRenderer(repo: ToolContext['repo']): (account: string, ids: string[]) => Promise<string[]> {
  const cache = new Map<string, Map<string, string>>();
  return async (account, ids) => {
    let map = cache.get(account);
    if (!map) {
      map = await repo.labelMap(account);
      cache.set(account, map);
    }
    return ids.map((id) => map.get(id) ?? id);
  };
}

/** Project a row to a compact hit. `render` translates its label ids → names. */
async function toHit(row: MessageRow, render: (account: string, ids: string[]) => Promise<string[]>): Promise<HitShape> {
  return {
    ref: messageRef(row),
    account: row.account,
    from: row.from_addr,
    subject: row.subject,
    date: isoDate(row.internal_date),
    snippet: compactSnippet(row.snippet),
    body_state: row.body_state,
    has_summary: row.summary_text != null,
    unread: row.unread === 1,
    direction: row.direction,
    labels: await render(row.account, parseLabels(row.labels_json)),
  };
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

/** A compact contact shape for list/find/get. */
export interface ContactShape {
  address: string;
  account: string;
  displayName: string | null;
  domain: string | null;
  msgsReceived: number;
  msgsSent: number;
  correspondent: boolean;
  repliedCount: number;
  starredCount: number;
  importantCount: number;
  lastSeen: string | null;
  engagementScore: number | null;
  centrality: number | null;
  communityId: number | null;
  curation: Curation | null;
}

function toContact(row: ContactDetailRow): ContactShape {
  return {
    address: row.address,
    account: row.account,
    displayName: row.display_name,
    domain: row.domain,
    msgsReceived: row.msgs_received,
    msgsSent: row.msgs_sent,
    correspondent: row.msgs_sent > 0,
    repliedCount: row.replied_count,
    starredCount: row.starred_count,
    importantCount: row.important_count,
    lastSeen: row.last_seen,
    engagementScore: row.engagement_score,
    centrality: row.centrality,
    communityId: row.community_id,
    curation: row.curation,
  };
}

/** A compact thread shape (metadata + summary presence; never the bodies). */
export interface ThreadShape {
  ref: string;
  account: string;
  subject: string | null;
  msgCount: number;
  unreadCount: number;
  userParticipated: boolean;
  firstAt: string | null;
  lastAt: string | null;
  hasSummary: boolean;
}

function toThread(row: ThreadRow): ThreadShape {
  return {
    ref: `${row.account}:${row.thread_id}`,
    account: row.account,
    subject: row.subject,
    msgCount: row.msg_count,
    unreadCount: row.unread_count,
    userParticipated: row.user_participated === 1,
    firstAt: row.first_at,
    lastAt: row.last_at,
    hasSummary: row.summary_text != null,
  };
}

/** Parse an `<account>:<id>` ref (message id or thread id), both sides non-empty. */
export function parseToolRef(raw: string): { account: string; id: string } {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new McpToolError(
      `invalid reference "${raw}" — expected <account>:<id> (e.g. personal:18f0a1b2c3)`,
    );
  }
  return { account: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

// =========================================================================
// PRIMITIVES (PLAN §12)
// =========================================================================

export interface SearchArgs {
  query: string;
  account?: string;
  limit?: number;
}

/**
 * `search` — ranked FTS recall, snippet-first (PLAN §12, DESIGN TEST recall).
 * Fuzzy: each term is a prefix-matched, OR-combined FTS literal (the FTS
 * contract's {@link buildMatch}, shared with the CLI), so a half-remembered
 * detail still surfaces neighbours rather than nothing. Never dumps bodies — the
 * agent opts in per hit via `get_message`.
 */
export async function search(ctx: ToolContext, args: SearchArgs): Promise<WithMeta & { hits: HitShape[] }> {
  const terms = args.query.split(/\s+/).filter((t) => t !== '');
  const q = buildMatch(terms, { expand: true });
  const rows = q === '' ? [] : await ctx.repo.searchMessages(q, {
    ...(args.account ? { account: args.account } : {}),
    limit: args.limit ?? 15,
  });
  const render = labelRenderer(ctx.repo);
  return await withMeta(ctx, args.account, { hits: await Promise.all(rows.map((r) => toHit(r, render))) });
}

export interface ListLabeledArgs {
  /** The Gmail label id to filter by (e.g. `INBOX`, `UNREAD`, `STARRED`). */
  label: string;
  account?: string;
  limit?: number;
}

/**
 * `list_labeled` — messages carrying a Gmail label, newest-first (label
 * membership, not FTS). `INBOX` answers "what's in my inbox right now" (kept
 * exact by the per-sync inbox reconcile); `UNREAD` answers "what's unread";
 * any user label filters to that label. Snippet-first like {@link search}.
 */
export async function listLabeled(ctx: ToolContext, args: ListLabeledArgs): Promise<WithMeta & { hits: HitShape[] }> {
  // Accept a friendly label NAME as well as an id: resolve "Coverage Review" →
  // Label_123… (scoped to the account when given) before the membership query.
  const label =
    (args.account ? (await ctx.repo.labelNameToId(args.account)).get(args.label.toLowerCase()) : undefined) ??
    args.label;
  const rows = await ctx.repo.messagesByLabel(label, {
    ...(args.account ? { account: args.account } : {}),
    limit: args.limit ?? 15,
  });
  const render = labelRenderer(ctx.repo);
  return await withMeta(ctx, args.account, { hits: await Promise.all(rows.map((r) => toHit(r, render))) });
}

export interface RefreshInboxArgs {
  account?: string;
  limit?: number;
}

/** The fresh inbox + what the reconcile changed (counts; `refreshed=false` = read-only fallback). */
export interface RefreshInboxResult extends WithMeta {
  /** True when a live provider reconcile ran; false when no creds were wired (indexed fallback). */
  refreshed: boolean;
  /** Inbox ids newly indexed by this refresh. */
  added: number;
  /** Rows that lost INBOX (archived since last fetch). */
  archived: number;
  /** Rows that regained INBOX (re-inboxed). */
  restored: number;
  hits: HitShape[];
}

/**
 * `refresh_inbox` — reconcile INBOX membership against the live mailbox, THEN
 * return the current inbox. Use this (not `list_labeled INBOX`) to answer
 * "what's in my inbox right now": Gmail labels mutate (archiving drops INBOX),
 * and a plain index read can lag, so this runs the bounded inbox reconcile
 * inline first (the same pass every sync runs) so the result is exact.
 *
 * The reconcile is the ONE inline provider round-trip this tool makes (bounded
 * by inbox size — list `in:inbox` ids + fetch only new ones), mirroring
 * `get_message`'s inline-enrich seam. With no provider creds wired (or on a
 * fetch failure) it degrades gracefully to the indexed inbox with
 * `refreshed=false`, so the tool is always answerable.
 */
export async function refreshInbox(ctx: ToolContext, args: RefreshInboxArgs): Promise<RefreshInboxResult> {
  const account = await requireAccount(ctx, args.account, 'refresh_inbox');
  const limit = args.limit ?? 15;

  let refreshed = false;
  let counts = { added: 0, archived: 0, restored: 0 };
  const accCfg = ctx.config.accounts[account];
  if (ctx.buildSource && accCfg && await ctx.repo.activeSyncRun(account) == null) {
    try {
      const source = ctx.buildSource(accCfg);
      // Probe own-address so newly-indexed inbox mail classifies direction (§8).
      let knownAddresses: string[] = [];
      try {
        const identity = await source.check();
        if (identity.ok && identity.address) knownAddresses = [identity.address];
      } catch {
        // Probe failure only weakens direction classification of new inbox mail.
      }
      const res = await reconcileInbox({ account, source, repo: ctx.repo, knownAddresses });
      counts = { added: res.added, archived: res.archived, restored: res.restored };
      refreshed = true;
    } catch {
      // Best-effort: fall back to the indexed inbox (read-only resilience).
    }
  }

  const rows = await ctx.repo.messagesByLabel('INBOX', { account, limit });
  const render = labelRenderer(ctx.repo);
  return await withMeta(ctx, account, { refreshed, ...counts, hits: await Promise.all(rows.map((r) => toHit(r, render))) });
}

export interface GetMessageArgs {
  ref: string;
  /**
   * What to return (PLAN §12): `summary` → the agent summary if present else the
   * distilled/snippet; `body` → the distilled body (inline-enriching a `meta` row
   * once, ADR-0001 O(1)); `meta` → headers + snippet only, no fetch. Default:
   * `summary` (token-conscious — the cheapest informative shape).
   */
  level?: 'summary' | 'body' | 'meta';
}

/** Full single-message detail. The body is opt-in via `level: 'body'`. */
export interface MessageDetail extends WithMeta {
  ref: string;
  account: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  threadRef: string | null;
  category: string | null;
  unread: boolean;
  starred: boolean;
  important: boolean;
  isList: boolean;
  direction: string;
  /** Gmail label ids on the message (INBOX, UNREAD, …) as last fetched. */
  labels: string[];
  bodyState: string;
  summary: string | null;
  /** The distilled body — only populated at `level: 'body'`. */
  body: string | null;
  snippet: string | null;
  /** True when this call performed the single O(1) inline enrich (ADR-0001). */
  enriched: boolean;
}

/**
 * `get_message` — the ladder summary → distilled body → inline-enrich (PLAN §12,
 * ADR-0001). At `level: 'body'` a still-`meta` row is enriched with the ONE
 * permitted inline O(1) provider fetch (gated on a source being wired in); every
 * other level reads the index only. Bodies are opt-in (token-conscious).
 */
export async function getMessage(ctx: ToolContext, args: GetMessageArgs): Promise<MessageDetail> {
  const { account, id } = parseToolRef(args.ref);
  const level = args.level ?? 'summary';
  let row = await ctx.repo.getMessage(account, id);
  if (!row) {
    throw new McpToolError(
      `message ${account}:${id} is not in the index — sync the account first ` +
        `(${handback('sync', '--account', account)})`,
    );
  }

  let enriched = false;
  // ADR-0001: ONE bounded inline fetch, only when the agent asked for the body
  // and the row is still meta, and only when a source is wired in.
  if (level === 'body' && row.body_state === 'meta' && ctx.buildSource) {
    try {
      const accCfg = ctx.config.accounts[account];
      if (accCfg) {
        const source = ctx.buildSource(accCfg);
        enriched = await enrichOne({ account, id, source, repo: ctx.repo });
        const refreshed = await ctx.repo.getMessage(account, id);
        if (refreshed) row = refreshed;
      }
    } catch {
      // Best-effort inline enrich: a fetch failure falls back to the meta shape
      // (read-only resilience; the agent can run `show` via a handback instead).
    }
  }

  const body = level === 'body' && row.body_state === 'full' ? row.body_text : null;
  // OCR candidates: images the offer/content may live in (mail-index never OCRs
  // — the agent reads them). `needsOcr` is the deterministic "when needed"
  // signal: the distilled body is thin yet content-bearing images exist, so the
  // meaning is in the images, not the text.
  const ocrImages = parseOcrImages(row.ocr_images_json);
  const needsOcr = isLikelyImageOnly(row.body_text, ocrImages.length);
  return await withMeta(ctx, account, {
    ref: messageRef(row),
    account: row.account,
    from: row.from_addr,
    to: row.to_addr,
    cc: row.cc_addr,
    subject: row.subject,
    date: isoDate(row.internal_date),
    threadRef: row.thread_id ? `${row.account}:${row.thread_id}` : null,
    category: row.category,
    unread: row.unread === 1,
    starred: row.starred === 1,
    important: row.important === 1,
    isList: row.is_list === 1,
    direction: row.direction,
    labels: await ctx.repo.labelNames(account, parseLabels(row.labels_json)),
    bodyState: row.body_state,
    summary: row.summary_text,
    body,
    snippet: compactSnippet(row.snippet),
    ocrImages,
    needsOcr,
    enriched,
  });
}

/** Arguments for `archive_message`. */
export interface ArchiveMessageArgs {
  ref: string;
}

/** Arguments for `modify_labels`. */
export interface ModifyLabelsArgs {
  ref: string;
  add?: string[];
  remove?: string[];
}

/** Result shape both opt-in writers return. */
export interface MutateToolResult {
  ref: string;
  /** Resulting labels after the change as human names (opaque ids rendered via
   * the cached catalogue), or null when the row is not indexed. */
  labels: string[] | null;
  /** False when the provider write succeeded but no local row existed. */
  indexed: boolean;
}

/**
 * Shared core for the two OPT-IN writers. Resolves the account, builds its
 * adapter via the {@link ToolContext.buildSource} seam, and runs the one
 * provider-write path. Translates the typed write errors into a
 * {@link McpToolError} carrying the exact re-auth command so the agent can relay
 * it. NEVER reached by the read tools.
 */
async function mutateLabels(
  ctx: ToolContext,
  ref: string,
  change: LabelChange,
): Promise<MutateToolResult & WithMeta> {
  const { account, id } = parseToolRef(ref);
  const accCfg = ctx.config.accounts[account];
  if (!accCfg) {
    throw new McpToolError(`unknown account "${account}" — not in the operator config`);
  }
  if (!ctx.buildSource) {
    throw new McpToolError('mailbox writes are not available in this server context');
  }

  const source = ctx.buildSource(accCfg);
  try {
    const result = await applyMailboxLabelChange({ account, id, source, repo: ctx.repo, change });
    return await withMeta(ctx, account, {
      ref: `${account}:${id}`,
      labels: result.labelNames,
      indexed: result.indexed,
    });
  } catch (err) {
    if (err instanceof InsufficientScopeError || err instanceof MailboxWriteUnsupportedError) {
      throw new McpToolError(err.message);
    }
    throw err;
  }
}

/**
 * `archive_message` — OPT-IN write. Archive one message (drop its `INBOX`
 * label). Mutates the mailbox; requires a `gmail.modify` grant.
 */
export async function archiveMessage(
  ctx: ToolContext,
  args: ArchiveMessageArgs,
): Promise<MutateToolResult & WithMeta> {
  return mutateLabels(ctx, args.ref, archiveChange());
}

/**
 * `modify_labels` — OPT-IN write. Add and/or remove Gmail labels on one message
 * (system ids like `STARRED`/`UNREAD`, or existing user-label names). Creating
 * new labels is not supported. Mutates the mailbox; requires `gmail.modify`.
 */
export async function modifyLabels(
  ctx: ToolContext,
  args: ModifyLabelsArgs,
): Promise<MutateToolResult & WithMeta> {
  const add = (args.add ?? []).filter((s) => s.trim() !== '');
  const remove = (args.remove ?? []).filter((s) => s.trim() !== '');
  if (add.length === 0 && remove.length === 0) {
    throw new McpToolError('modify_labels requires at least one label in "add" or "remove"');
  }
  return mutateLabels(ctx, args.ref, { addLabelIds: add, removeLabelIds: remove });
}

/**
 * Parse a stored `ocr_images_json` into a plain array (or `[]` on absent/bad
 * JSON). Surfaced on `get_message` so the agent can fetch + read these images
 * when the offer lives in a graphic rather than text.
 */
function parseOcrImages(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface GetThreadArgs {
  ref: string;
}

/** `get_thread` — thread metadata + its messages + the thread summary (PLAN §12). */
export async function getThread(
  ctx: ToolContext,
  args: GetThreadArgs,
): Promise<WithMeta & {
  thread: ThreadShape | null;
  summary: string | null;
  messages: HitShape[];
}> {
  const { account, id } = parseToolRef(args.ref);
  const row = await ctx.repo.getThread(account, id);
  const messages = await ctx.repo.threadMessages(account, id);
  if (!row && messages.length === 0) {
    throw new McpToolError(`thread ${account}:${id} is not in the index`);
  }
  const render = labelRenderer(ctx.repo);
  return await withMeta(ctx, account, {
    thread: row ? toThread(row) : null,
    summary: row?.summary_text ?? null,
    messages: await Promise.all(messages.map((m) => toHit(m, render))),
  });
}

export interface ListContactsArgs {
  account?: string;
  sort?: ContactSort;
  /** `correspondent` | a curation label (`important`/`muted`/`blocked`). */
  filter?: string;
  limit?: number;
}

/** `list_contacts` — ranked, filterable contact list (PLAN §12, DESIGN TEST recall). */
export async function listContacts(
  ctx: ToolContext,
  args: ListContactsArgs,
): Promise<WithMeta & { contacts: ContactShape[] }> {
  const filter: { correspondent?: boolean; curation?: Curation } = {};
  if (args.filter === 'correspondent') filter.correspondent = true;
  else if (args.filter && (CURATIONS as readonly string[]).includes(args.filter)) {
    filter.curation = args.filter as Curation;
  }
  const rows = await ctx.repo.listContacts({
    ...(args.account ? { account: args.account } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    filter,
    limit: args.limit ?? 20,
  });
  return await withMeta(ctx, args.account, { contacts: rows.map(toContact) });
}

export interface GetContactArgs {
  address: string;
  account?: string;
}

/**
 * `get_contact` — one contact's stats, curation, and recent threads (PLAN §12).
 * Resolves the contact across accounts when `account` is omitted (first match).
 * On a non-exact hit it falls back to {@link findContacts} so a near-miss returns
 * the ranked candidates rather than nothing (DESIGN TEST recall).
 */
export async function getContact(
  ctx: ToolContext,
  args: GetContactArgs,
): Promise<WithMeta & {
  contact: ContactShape | null;
  recentThreads: ThreadShape[];
  candidates?: ContactShape[];
}> {
  let account = args.account;
  let row = account ? await ctx.repo.getContactDetail(account, args.address) : undefined;
  if (!row && !account) {
    // Cross-account exact resolution: the first account that has the address.
    const found = (await ctx.repo
      .findContacts(args.address, { limit: 25 }))
      .find((c) => c.address === args.address);
    if (found) {
      account = found.account;
      row = found;
    }
  }
  if (!row) {
    // Near-miss: return ranked candidates so the answer is never a bare empty.
    const candidates = (await ctx.repo
      .findContacts(args.address, { ...(account ? { account } : {}), limit: 10 }))
      .map(toContact);
    return await withMeta(ctx, account, { contact: null, recentThreads: [], candidates });
  }
  const recentThreads = (await ctx.repo.threadsForContact(row.account, row.address, 10)).map(toThread);
  return await withMeta(ctx, row.account, { contact: toContact(row), recentThreads });
}

export interface FindPersonArgs {
  hint: string;
  account?: string;
  limit?: number;
}

/**
 * `find_person` — fuzzy contact resolution from a vague hint (PLAN §12, the
 * entry point for "who was that insurance contact from last spring?"). Ranks
 * Correspondents FIRST (people remember by who they talked to) and matches
 * substrings of name/address/domain, so a half-remembered fragment resolves and
 * never returns a bare empty set where a near-miss exists (DESIGN TEST recall).
 */
export async function findPerson(
  ctx: ToolContext,
  args: FindPersonArgs,
): Promise<WithMeta & { matches: ContactShape[] }> {
  const rows = await ctx.repo.findContacts(args.hint, {
    ...(args.account ? { account: args.account } : {}),
    limit: args.limit ?? 10,
  });
  return await withMeta(ctx, args.account, { matches: rows.map(toContact) });
}

export interface ListThreadsArgs {
  contact?: string;
  query?: string;
  account?: string;
  limit?: number;
}

/** `list_threads` — conversations by contact OR by query (PLAN §12). */
export async function listThreads(
  ctx: ToolContext,
  args: ListThreadsArgs,
): Promise<WithMeta & { threads: ThreadShape[] }> {
  let rows: ThreadRow[];
  if (args.contact) {
    // By-contact needs an account to scope the participant search; default to
    // the contact's resolved account when omitted.
    let account = args.account;
    if (!account) {
      const found = (await ctx.repo.findContacts(args.contact, { limit: 1 }))[0];
      account = found?.account;
    }
    rows = account ? await ctx.repo.threadsForContact(account, args.contact, args.limit ?? 20) : [];
  } else if (args.query) {
    const q = buildMatch(args.query.split(/\s+/).filter((t) => t !== ''));
    rows = q === '' ? [] : await ctx.repo.threadsForQuery(q, {
      ...(args.account ? { account: args.account } : {}),
      limit: args.limit ?? 20,
    });
  } else {
    throw new McpToolError('list_threads requires either "contact" or "query"');
  }
  return await withMeta(ctx, args.account, { threads: rows.map(toThread) });
}

export interface GraphNeighborsArgs {
  address: string;
  account?: string;
  limit?: number;
}

/**
 * `graph_neighbors` — ranked co-recipiency neighbours of a contact (PLAN §12,
 * D8/D9). On a miss (no non-list co-recipients, or no graph built) it falls back
 * to ranked near-misses via {@link findContacts} so the answer is never a bare
 * empty set (DESIGN TEST recall); `fallback` flags that.
 */
export async function graphNeighbors(
  ctx: ToolContext,
  args: GraphNeighborsArgs,
): Promise<WithMeta & { neighbors: GraphNeighborRow[]; fallback: boolean }> {
  let account = args.account;
  if (!account) {
    const found = (await ctx.repo.findContacts(args.address, { limit: 1 }))[0];
    account = found?.account;
  }
  const neighbors = account
    ? await ctx.repo.graphNeighbors(account, args.address, args.limit ?? 15)
    : [];
  if (neighbors.length > 0) {
    return await withMeta(ctx, account, { neighbors, fallback: false });
  }
  // Near-miss fallback: project the ranked contact candidates as zero-weight
  // neighbours so the agent still gets ranked entry points.
  const fb = await ctx.repo.findContacts(args.address, { ...(account ? { account } : {}), limit: 10 });
  return await withMeta(ctx, account, {
    neighbors: fb
      .filter((c) => c.address !== args.address)
      .map((c) => ({
        address: c.address,
        display_name: c.display_name,
        domain: c.domain,
        shared_threads: 0,
        engagement_score: c.engagement_score,
        centrality: c.centrality,
        community_id: c.community_id,
      })),
    fallback: true,
  });
}

export interface GraphCommunitiesArgs {
  account?: string;
  memberLimit?: number;
}

/** `graph_communities` — detected social circles (PLAN §12, D8). */
export async function graphCommunities(
  ctx: ToolContext,
  args: GraphCommunitiesArgs,
): Promise<WithMeta & {
  communities: Awaited<ReturnType<Repo['graphCommunities']>>;
  /** A handback to (re)build the graph when none exists (ADR-0001, O(N)). */
  build_command?: string;
}> {
  // Communities require an account scope (community ids are per-account); default
  // to the sole account when omitted.
  const account = args.account ?? await soleAccount(ctx);
  const communities = account
    ? await ctx.repo.graphCommunities(account, args.memberLimit ?? 10)
    : [];
  const body: { communities: typeof communities; build_command?: string } = { communities };
  if (communities.length === 0 && account) {
    body.build_command = handback('graph', 'build', '--account', account);
  }
  return await withMeta(ctx, account, body);
}

// ---- curation write-back loop (M3.1, PLAN §11) ----------------------------

export interface InterestProposeArgs {
  account?: string;
  contactLimit?: number;
  domainLimit?: number;
}

/** `interest_propose` — the curation SEED shortlist (PLAN §11/§12, D13). */
export async function interestPropose(ctx: ToolContext, args: InterestProposeArgs): Promise<WithMeta & {
  proposal: Awaited<ReturnType<typeof propose>>;
}> {
  const account = await requireAccount(ctx, args.account, 'interest_propose');
  const proposal = await propose(ctx.repo, account, {
    ...(args.contactLimit != null ? { contactLimit: args.contactLimit } : {}),
    ...(args.domainLimit != null ? { domainLimit: args.domainLimit } : {}),
  });
  return await withMeta(ctx, account, { proposal });
}

export interface InterestSetArgs {
  account?: string;
  contacts?: { address: string; curation: Curation | null }[];
  domains?: { domain: string; curation: Curation | null }[];
  keywords?: string[];
}

/** `interest_set` — persist the curation disposition (PLAN §11/§12, D14). */
export async function interestSet(ctx: ToolContext, args: InterestSetArgs): Promise<WithMeta & {
  result: Awaited<ReturnType<typeof curationSet>>;
}> {
  const account = await requireAccount(ctx, args.account, 'interest_set');
  const result = await curationSet(ctx.repo, account, {
    ...(args.contacts ? { contacts: args.contacts } : {}),
    ...(args.domains ? { domains: args.domains } : {}),
    ...(args.keywords ? { keywords: args.keywords } : {}),
  });
  return await withMeta(ctx, account, { result });
}

export interface InterestGetArgs {
  account?: string;
}

/** `interest_get` — read back the curated profile (PLAN §11/§12). */
export async function interestGet(ctx: ToolContext, args: InterestGetArgs): Promise<WithMeta & {
  profile: Awaited<ReturnType<typeof curationGet>>;
}> {
  const account = await requireAccount(ctx, args.account, 'interest_get');
  return await withMeta(ctx, account, { profile: await curationGet(ctx.repo, account) });
}

// ---- summarization write-back (M3.5, ADR-0003) ----------------------------

export interface SaveSummaryArgs {
  ref: string;
  text: string;
  /** `message` (default) or `thread`. */
  level?: 'message' | 'thread';
}

/** `save_summary` — persist an agent summary at message/thread level (PLAN §12, ADR-0003). */
export async function saveSummaryTool(ctx: ToolContext, args: SaveSummaryArgs): Promise<WithMeta & {
  result: Awaited<ReturnType<typeof saveSummary>>;
}> {
  const { account, id } = parseToolRef(args.ref);
  const level = args.level ?? 'message';
  const result = await saveSummary(ctx.repo, account, level, id, args.text);
  return await withMeta(ctx, account, { result });
}

// ---- domain categorization write-back (M3.5, PLAN §12) --------------------

export interface DomainsToCategorizeArgs {
  account?: string;
  includeCategorized?: boolean;
  limit?: number;
}

/** `domains_to_categorize` — PROPOSE domains for the categorization loop (PLAN §12). */
export async function domainsToCategorizeTool(
  ctx: ToolContext,
  args: DomainsToCategorizeArgs,
): Promise<WithMeta & { candidates: Awaited<ReturnType<typeof wbDomainsToCategorize>> }> {
  const account = await requireAccount(ctx, args.account, 'domains_to_categorize');
  const candidates = await wbDomainsToCategorize(ctx.repo, account, {
    ...(args.includeCategorized != null ? { includeCategorized: args.includeCategorized } : {}),
    ...(args.limit != null ? { limit: args.limit } : {}),
  });
  return await withMeta(ctx, account, { candidates });
}

export interface SaveDomainCategoryArgs {
  domain: string;
  category: string;
  note?: string;
  account?: string;
}

/** `save_domain_category` — PERSIST an agent-assigned domain category (PLAN §12). */
export async function saveDomainCategoryTool(
  ctx: ToolContext,
  args: SaveDomainCategoryArgs,
): Promise<WithMeta & { result: Awaited<ReturnType<typeof wbSaveDomainCategory>> }> {
  const account = await requireAccount(ctx, args.account, 'save_domain_category');
  const result = await wbSaveDomainCategory(ctx.repo, account, args.domain, args.category, args.note ?? null);
  return await withMeta(ctx, account, { result });
}

// ---- cadence (deterministic correspondent frequency) ----------------------

export interface CadenceArgs {
  account?: string;
  /** Restrict to senders whose domain carries this agent-assigned entity category. */
  category?: string;
  /** Relative token (`30d`, `1mo`) or ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

/**
 * `cadence` — inbound frequency per registrable (brand) domain (PLAN §12). The
 * deterministic answer to "how often does <brand / category> email me": no
 * ad-hoc SQL, no per-query classification. Pair with `save_domain_category` to
 * tag a vertical once, then pass `category` here to scope to it (e.g. every
 * expedition operator's cadence in one call).
 */
export async function cadenceTool(ctx: ToolContext, args: CadenceArgs): Promise<WithMeta & { cadence: CadenceRow[] }> {
  const account = await requireAccount(ctx, args.account, 'cadence');
  const now = ctx.now ? ctx.now() : new Date();
  const opts: Parameters<typeof computeCadence>[2] = {};
  if (args.category != null) opts.category = args.category;
  if (args.since != null) opts.sinceMs = parseSince(args.since, now);
  if (args.limit != null) opts.limit = args.limit;
  const cadence = await computeCadence(ctx.repo, account, opts);
  return await withMeta(ctx, account, { cadence });
}

// ---- sync status (PLAN §12, ADR-0005) -------------------------------------

export interface SyncStatusArgs {
  account?: string;
}

/** Per-account freshness/shape, the ADR-0005 freshness contract surfaced to the agent. */
export interface SyncStatusEntry {
  account: string;
  index_as_of: string | null;
  syncing: boolean;
  messages: number;
  bodyStates: { meta: number; full: number; 'summary-only': number };
}

/** `sync_status` — counts, last run, body-ladder split, freshness (PLAN §12). */
export async function syncStatus(ctx: ToolContext, args: SyncStatusArgs): Promise<WithMeta & {
  accounts: SyncStatusEntry[];
}> {
  const labels = args.account ? [args.account] : await discoverAccounts(ctx.repo);
  const accounts: SyncStatusEntry[] = await Promise.all(labels.map(async (account) => {
    const counts = { meta: 0, full: 0, 'summary-only': 0 };
    const rows = (await ctx.repo.driver
      .prepare(`SELECT body_state, count(*) c FROM messages WHERE account = ? GROUP BY body_state`)
      .all(account)) as { body_state: string; c: number }[];
    for (const r of rows) {
      if (r.body_state === 'meta' || r.body_state === 'full' || r.body_state === 'summary-only') {
        counts[r.body_state] = r.c;
      }
    }
    return {
      account,
      index_as_of: await indexAsOf(ctx.repo, account),
      syncing: await ctx.repo.activeSyncRun(account) != null,
      messages: await ctx.repo.countMessages(account),
      bodyStates: counts,
    };
  }));
  const body: { accounts: SyncStatusEntry[]; jobs?: unknown } = { accounts };
  if (ctx.jobStatus) body.jobs = await ctx.jobStatus(args.account);
  return await withMeta(ctx, args.account, body);
}

// ---- relay/menu status ----------------------------------------------------

export interface RelayMenuAction {
  id: string;
  label: string;
  systemImage: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface RelayMenuStatusAccount extends SyncStatusEntry {
  stale: boolean;
  age_seconds: number | null;
}

export interface RelayMenuStatus {
  title: string;
  summary: string;
  state: 'ready' | 'syncing' | 'stale' | 'empty';
  systemImage: string;
  detail: string[];
  accounts: RelayMenuStatusAccount[];
  actions: RelayMenuAction[];
  _meta: Record<string, unknown>;
}

function ageSeconds(now: Date, iso: string | null): number | null {
  if (iso == null) return null;
  const ms = now.getTime() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : null;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return 'never synced';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Menu-bar status for local relay hosts. This is intentionally read-only and
 * does not call `withMeta`, because status polling must not auto-spawn syncs.
 */
export async function relayMenuStatus(ctx: ToolContext): Promise<RelayMenuStatus> {
  const now = ctx.now?.() ?? new Date();
  const labels = [...new Set([...Object.keys(ctx.config.accounts), ...await discoverAccounts(ctx.repo)])].sort();
  const accounts = await Promise.all(labels.map(async (account) => {
    const counts = { meta: 0, full: 0, 'summary-only': 0 };
    const rows = (await ctx.repo.driver
      .prepare(`SELECT body_state, count(*) c FROM messages WHERE account = ? GROUP BY body_state`)
      .all(account)) as { body_state: string; c: number }[];
    for (const r of rows) {
      if (r.body_state === 'meta' || r.body_state === 'full' || r.body_state === 'summary-only') {
        counts[r.body_state] = r.c;
      }
    }
    const index_as_of = await indexAsOf(ctx.repo, account);
    const age = ageSeconds(now, index_as_of);
    return {
      account,
      index_as_of,
      syncing: await ctx.repo.activeSyncRun(account) != null,
      messages: await ctx.repo.countMessages(account),
      bodyStates: counts,
      age_seconds: age,
      stale: age == null || age * 1000 > STALE_AFTER_MS,
    };
  }));

  const totalMessages = accounts.reduce((sum, a) => sum + a.messages, 0);
  const syncing = accounts.some((a) => a.syncing);
  const stale = accounts.some((a) => a.stale);
  const state: RelayMenuStatus['state'] = syncing
    ? 'syncing'
    : totalMessages === 0
      ? 'empty'
      : stale
        ? 'stale'
        : 'ready';
  const freshest = accounts
    .map((a) => a.age_seconds)
    .filter((age): age is number => age != null)
    .sort((a, b) => a - b)[0] ?? null;

  return {
    title: 'Mail Index',
    summary: `${state[0]!.toUpperCase()}${state.slice(1)} · ${totalMessages} messages · ${accounts.length} accounts`,
    state,
    systemImage: syncing ? 'arrow.triangle.2.circlepath' : stale ? 'exclamationmark.triangle' : 'tray.full',
    detail: [
      `${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
      `${totalMessages} indexed message${totalMessages === 1 ? '' : 's'}`,
      `Last sync ${formatAge(freshest)}`,
      ...accounts.slice(0, 4).map((a) =>
        `${a.account}: ${a.messages} messages · ${a.syncing ? 'syncing' : a.stale ? 'stale' : 'ready'} · ${formatAge(a.age_seconds)}`,
      ),
    ],
    accounts,
    actions: [
      { id: 'sync_now', label: 'Sync Now', systemImage: 'arrow.triangle.2.circlepath', tool: 'sync_now' },
      { id: 'sync_status', label: 'Detailed Status', systemImage: 'list.bullet.rectangle', tool: 'sync_status' },
      { id: 'catch_up_24h', label: 'Catch Up 24h', systemImage: 'clock.arrow.circlepath', tool: 'catch_up', arguments: { since: '24h' } },
    ],
    _meta: {
      'io.github.unsoldgroup.mail-index/menuStatusVersion': 1,
      'io.modelcontextprotocol.ui/display': 'menu',
    },
  };
}

export interface SyncNowArgs {
  account?: string;
}

export async function syncNow(ctx: ToolContext, args: SyncNowArgs): Promise<WithMeta & {
  started: boolean;
  started_accounts: string[];
  skipped_accounts: string[];
  command: string;
}> {
  const labels = args.account
    ? [args.account]
    : [...new Set([...Object.keys(ctx.config.accounts), ...await discoverAccounts(ctx.repo)])].sort();
  const started: string[] = [];
  const skipped: string[] = [];
  for (const account of labels) {
    if (await ctx.repo.activeSyncRun(account) != null) {
      skipped.push(account);
      continue;
    }
    if (ctx.backgroundSync?.(account)) started.push(account);
    else skipped.push(account);
  }
  const command = args.account ? handback('sync', '--account', args.account) : handback('sync', '--all-accounts');
  return await withMeta(ctx, args.account, {
    started: started.length > 0,
    started_accounts: started,
    skipped_accounts: skipped,
    command,
  });
}

// =========================================================================
// COMPOSITES (PLAN §12) — SQL views over the index, stale → background sync
// =========================================================================

export interface CatchUpArgs {
  since: string;
  account?: string;
}

/** A catch_up section's compact rows + a handback to read the bodies in bulk. */
export interface CatchUpResult extends WithMeta {
  since_ms: number;
  /** New mail from curated-important contacts. */
  fromImportant: HitShape[];
  /** New replies in threads the user took part in. */
  inUserThreads: HitShape[];
  /** Interest-keyword hits. */
  keywordHits: HitShape[];
  /** Command handback to enrich the surfaced bodies (ADR-0001, O(N)). */
  bodies_command: string;
  /** ADR-0005: set when this stale read spawned a detached incremental sync. */
  sync_started?: boolean;
  eta_seconds?: number;
}

/**
 * `catch_up` — the "what did I miss" briefing (PLAN §12). Three compact feeds
 * since `since`: new mail from curated-important contacts, new replies in
 * user-participated threads, and interest-keyword hits. Bodies are NOT fetched
 * (O(N)) — a command handback enriches them. When the index is stale (ADR-0005)
 * it returns current data immediately AND spawns a detached incremental sync,
 * reporting `sync_started` + `eta_seconds`; it never blocks.
 */
export async function catchUp(ctx: ToolContext, args: CatchUpArgs): Promise<CatchUpResult> {
  const account = await await requireAccount(ctx, args.account, 'catch_up');
  const sinceMs = parseSince(args.since, ctx.now?.() ?? new Date());

  const fromImportant = (await ctx.repo.driver
    .prepare(catchUpFromImportantSql())
    .all(account, sinceMs)) as unknown as MessageRow[];
  const inUserThreads = (await ctx.repo.driver
    .prepare(catchUpUserThreadsSql())
    .all(account, sinceMs)) as unknown as MessageRow[];

  const keywords = (await ctx.repo.getInterestProfile(account)).keywords;
  let keywordHits: MessageRow[] = [];
  if (keywords.length > 0) {
    const q = keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(' OR ');
    keywordHits = (await ctx.repo.driver
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
          WHERE messages_fts MATCH ? AND m.account = ? AND m.internal_date >= ?
          ORDER BY m.internal_date DESC LIMIT 25`,
      )
      .all(q, account, sinceMs)) as unknown as MessageRow[];
  }

  const render = labelRenderer(ctx.repo);
  const base: CatchUpResult = await withMeta(ctx, account, {
    since_ms: sinceMs,
    fromImportant: await Promise.all(fromImportant.map((r) => toHit(r, render))),
    inUserThreads: await Promise.all(inUserThreads.map((r) => toHit(r, render))),
    keywordHits: await Promise.all(keywordHits.map((r) => toHit(r, render))),
    bodies_command: handback('enrich', '--account', account, '--profile'),
  });
  return base;
}

export interface DigestSourcesArgs {
  since?: string;
  account?: string;
}

/** A digest source: a newsletter/list sender ranked by engagement + interest. */
export interface DigestSource {
  address: string;
  displayName: string | null;
  domain: string | null;
  engagementScore: number | null;
  curation: Curation | null;
  /** Issues received (optionally since `since`). */
  issues: number;
  /** Unread issues. */
  unread: number;
  /** Issues with no agent summary yet (the digest loop's worklist). */
  unsummarized: number;
}

export interface DigestSourcesResult extends WithMeta {
  sources: DigestSource[];
  /** Per-issue read loop handback (the digest routine, PLAN §12). */
  read_command: string;
  sync_started?: boolean;
  eta_seconds?: number;
}

/**
 * `digest_sources` — newsletter/list senders ranked by engagement + interest,
 * with unread/unsummarized counts (PLAN §12). The digest routine then loops:
 * `digest_sources` → `get_message` per issue → `save_summary` → bodies demote
 * (ADR-0003). Like `catch_up`, a stale index returns current data immediately
 * and spawns a detached incremental sync (ADR-0005).
 */
export async function digestSources(ctx: ToolContext, args: DigestSourcesArgs): Promise<DigestSourcesResult> {
  const account = await await requireAccount(ctx, args.account, 'digest_sources');
  const sinceMs = args.since ? parseSince(args.since, ctx.now?.() ?? new Date()) : 0;

  const rows = (await ctx.repo.driver
    .prepare(digestSourcesSql())
    .all(account, sinceMs)) as {
      address: string;
      display_name: string | null;
      domain: string | null;
      engagement_score: number | null;
      curation: Curation | null;
      issues: number;
      unread: number;
      unsummarized: number;
    }[];

  const base: DigestSourcesResult = await withMeta(ctx, account, {
    sources: rows.map((r) => ({
      address: r.address,
      displayName: r.display_name,
      domain: r.domain,
      engagementScore: r.engagement_score,
      curation: r.curation,
      issues: r.issues,
      unread: r.unread,
      unsummarized: r.unsummarized,
    })),
    read_command: handback('search', '<sender or subject>', '--account', account),
  });
  return base;
}

// ---- shared SQL + helpers -------------------------------------------------

function catchUpFromImportantSql(): string {
  // New mail since cutoff from a curated-important contact (or important domain).
  return `SELECT m.* FROM messages m
           WHERE m.account = ? AND m.internal_date >= ? AND m.direction = 'received'
             AND (
               EXISTS (
                 SELECT 1 FROM contacts c
                  WHERE c.account = m.account AND c.curation = 'important'
                    AND (m.from_addr = c.address OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%')
               )
               OR EXISTS (
                 SELECT 1 FROM domains d
                  WHERE d.account = m.account AND d.curation = 'important'
                    AND (lower(m.from_addr) LIKE '%@' || lower(d.domain) OR lower(m.from_addr) LIKE '%@' || lower(d.domain) || '>%')
               )
             )
           ORDER BY m.internal_date DESC LIMIT 25`;
}

function catchUpUserThreadsSql(): string {
  // New replies since cutoff in threads the user took part in.
  return `SELECT m.* FROM messages m
            JOIN threads t ON t.account = m.account AND t.thread_id = m.thread_id
           WHERE m.account = ? AND m.internal_date >= ?
             AND t.user_participated = 1 AND m.direction = 'received'
           ORDER BY m.internal_date DESC LIMIT 25`;
}

function digestSourcesSql(): string {
  // List/bulk senders ranked by engagement then volume, with issue counts.
  return `SELECT c.address, c.display_name, c.domain, c.engagement_score, c.curation,
                 count(m.gmail_message_id) AS issues,
                 sum(CASE WHEN m.unread = 1 THEN 1 ELSE 0 END) AS unread,
                 sum(CASE WHEN m.summary_text IS NULL THEN 1 ELSE 0 END) AS unsummarized
            FROM contacts c
            JOIN messages m
              ON m.account = c.account
             AND (m.from_addr = c.address OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%')
           WHERE c.account = ?
             AND m.direction = 'received'
             AND m.internal_date >= ?
             AND (m.is_list = 1 OR m.category IN ('promotions','social','updates','forums'))
           GROUP BY c.account, c.address
          HAVING issues > 0
           ORDER BY c.engagement_score IS NULL, c.engagement_score DESC, issues DESC, c.address ASC
           LIMIT 20`;
}

/**
 * Parse a `since` token into an epoch-ms cutoff: a relative `<n>[dwhmo]` token
 * (`30d`, `2w`, `12h`, `1mo`) or an ISO-8601 timestamp. Relative tokens subtract
 * from `now`. Throws {@link McpToolError} on an unparseable token.
 */
export function parseSince(since: string, now: Date): number {
  const s = since.trim();
  const rel = /^(\d+)\s*(mo|[dwhm])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms =
      unit === 'mo'
        ? n * 30 * 24 * 60 * 60 * 1000
        : unit === 'w'
          ? n * 7 * 24 * 60 * 60 * 1000
          : unit === 'd'
            ? n * 24 * 60 * 60 * 1000
            : unit === 'h'
              ? n * 60 * 60 * 1000
              : n * 60 * 1000; // 'm' = minutes
    return now.getTime() - ms;
  }
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) return ts;
  throw new McpToolError(
    `invalid "since" "${since}" — expected a relative token (30d, 2w, 12h, 1mo) or an ISO timestamp`,
  );
}

/** Discover every account label that appears anywhere in the index. */
async function discoverAccounts(repo: Repo): Promise<string[]> {
  const rows = (await repo.driver
    .prepare(
      `SELECT account FROM messages
       UNION SELECT account FROM contacts
       UNION SELECT account FROM sync_runs
       ORDER BY account`,
    )
    .all()) as { account: string }[];
  return rows.map((r) => r.account);
}

/** The sole configured/indexed account, or undefined when ambiguous/none. */
async function soleAccount(ctx: ToolContext): Promise<string | undefined> {
  const cfg = Object.keys(ctx.config.accounts);
  if (cfg.length === 1) return cfg[0]!;
  const seen = await discoverAccounts(ctx.repo);
  return seen.length === 1 ? seen[0]! : undefined;
}

/**
 * Resolve the account an account-scoped tool needs: the explicit arg, else the
 * sole configured/indexed account. Throws {@link McpToolError} when ambiguous so
 * the agent passes one rather than silently picking.
 */
async function requireAccount(ctx: ToolContext, account: string | undefined, tool: string): Promise<string> {
  if (account) return account;
  const sole = await await soleAccount(ctx);
  if (sole) return sole;
  const known = [...new Set([...Object.keys(ctx.config.accounts), ...await discoverAccounts(ctx.repo)])];
  throw new McpToolError(
    `${tool} needs an "account" — configured/indexed: ${known.length ? known.join(', ') : '(none)'}`,
  );
}
