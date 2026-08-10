/**
 * Typed repository over the index (SCOPE 0.2). Every persistence path goes
 * through here so the critical invariants live in one place (CONTEXT.md):
 *
 *  1. Upsert by (account, gmail_message_id) is idempotent — re-running a sync
 *     over the same Message produces the same row, no duplicates.
 *  2. Never downgrade body_state: a re-sync delivering `meta` must not clobber
 *     an existing `full` / `summary-only` row's body or state. The body ladder
 *     only moves up (BODY_STATE_RANK).
 *  3. The FTS row is kept in lockstep with the Message: subject/sender/
 *     recipients always indexed; `body` reflects snippet (meta) → snippet +
 *     body_text (full) → snippet + summary (summary-only).
 *
 * Convention for later stages: the repo is a thin class wrapping a live
 * `DatabaseSync`. Public methods are verbs (`upsertMessage`, `recordSyncRun`).
 * Inputs are plain typed records; the repo fills `indexed_at`/timestamps.
 * Failures that violate an invariant or a closed enum throw `IndexError`
 * (re-exported from `db.ts`); SQLite errors propagate as-is. Booleans cross the
 * boundary as JS `boolean` and are stored as 0/1 internally.
 */

import type { StorageDriver, PreparedStatement } from './driver.js';
import { IndexError } from './db.js';
import { bm25Expr, projectBody, projectRecipients } from './fts.js';
import { classifyCategory, classifyDirection } from '../ingest/classify.js';
import {
  BODY_STATES,
  BODY_STATE_RANK,
  CATEGORIES,
  CURATIONS,
  DIRECTIONS,
  SYNC_PHASES,
  type BodyState,
  type Category,
  type Curation,
  type Direction,
  type SyncPhase,
} from './schema.js';

const bool = (v: boolean | undefined): number => (v ? 1 : 0);

/**
 * How long an unfinished `sync_runs` row stays a valid lock before it is treated
 * as a DEAD lock left by a crashed sync (see {@link Repo.activeSyncRun}). 6h —
 * comfortably above the longest legitimate run (an initial whole-mailbox sweep),
 * so a live sync is never reaped, while a crashed one self-clears within a day.
 */
export const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

/** Input for {@link Repo.upsertMessage}. Mirrors PLAN §6 `messages`. */
export interface MessageInput {
  account: string;
  gmailMessageId: string;
  rfcMessageId?: string | null;
  threadId?: string | null;
  internalDate?: number | null;
  dateHeader?: string | null;
  fromAddr?: string | null;
  toAddr?: string | null;
  ccAddr?: string | null;
  subject?: string | null;
  labels?: string[] | null;
  category?: Category | null;
  isList?: boolean;
  direction?: Direction;
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  sizeEstimate?: number | null;
  snippet?: string | null;
  /** Body ladder state. Defaults to 'meta'. Never downgraded on re-sync. */
  bodyState?: BodyState;
  /** Distilled body text; only meaningful for 'full'. */
  bodyText?: string | null;
  gmailUrl?: string | null;
  /**
   * JSON array of deterministic OCR-candidate images (the offer may live in an
   * image, not text — see `intelligence/images.ts`). Computed at enrich time.
   * `undefined`/`null` on a meta sync leaves any existing value intact (the
   * upsert COALESCEs it), so a phase-1 re-sync never wipes candidates.
   */
  ocrImagesJson?: string | null;
}

/** A persisted message row (subset used by callers/tests). */
export interface MessageRow {
  account: string;
  gmail_message_id: string;
  rfc_message_id: string | null;
  thread_id: string | null;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  snippet: string | null;
  body_state: BodyState;
  body_text: string | null;
  summary_text: string | null;
  summary_is_model: number;
  summarized_at: string | null;
  is_list: number;
  direction: Direction;
  unread: number;
  starred: number;
  important: number;
  category: Category | null;
  internal_date: number | null;
  indexed_at: string | null;
  body_fetched_at: string | null;
  /** JSON array of OCR-candidate images, or null. See {@link MessageInput.ocrImagesJson}. */
  ocr_images_json: string | null;
  /** JSON array of Gmail label ids (`INBOX`, `UNREAD`, …) as last fetched, or null. */
  labels_json: string | null;
}

export interface SyncRunStart {
  account: string;
  phase: SyncPhase;
  selector?: string | null;
}

export interface SyncRunFinish {
  fetched?: number;
  indexed?: number;
  error?: string | null;
}

/**
 * A selector for {@link Repo.selectMetaMessages} — which `meta` rows an enrich
 * run should promote (PLAN §7 phase 2). Fields combine with AND.
 */
export interface MetaSelector {
  /** `'direct'` applies the pre-curation heuristic; `'all'` matches every meta row. */
  rule?: 'direct' | 'all';
  /** Restrict to a single sender (bare address or exact `from_addr`). */
  sender?: string;
  /** Restrict to meta rows matching this FTS5 query. */
  match?: string;
  /** Cap the number of ids returned (newest-first). */
  limit?: number;
}

export interface ContactInput {
  account: string;
  address: string;
  displayName?: string | null;
  domain?: string | null;
  curation?: Curation | null;
}

export interface DomainCategoryInput {
  account: string;
  domain: string;
  category: string;
  note?: string | null;
}

/** Input for {@link Repo.saveMessageSummary} (M3.5, ADR-0003). */
export interface MessageSummaryInput {
  account: string;
  gmailMessageId: string;
  /** The agent-authored paraphrase. */
  text: string;
  /** Provenance: model-generated by default (the only writer in v1). */
  isModel?: boolean;
  /** Stamp; defaults to wall clock. */
  at?: string;
}

/** Input for {@link Repo.saveThreadSummary} (M3.5, ADR-0003). */
export interface ThreadSummaryInput {
  account: string;
  threadId: string;
  text: string;
  isModel?: boolean;
  at?: string;
}

/**
 * A message row eligible for compaction (M3.5, ADR-0003). One row per message
 * whose distilled body can be demoted to summary-only. Snake_case (repo
 * convention).
 */
export interface CompactCandidateRow {
  gmail_message_id: string;
  thread_id: string | null;
  summarized_at: string | null;
}

/**
 * The message projection {@link Repo.messagesForAggregation} streams to the
 * aggregation pass. Snake_case rows straight from SQLite (repo convention).
 */
export interface AggregationMessageRow {
  account: string;
  gmail_message_id: string;
  thread_id: string | null;
  internal_date: number | null;
  date_header: string | null;
  from_addr: string | null;
  to_addr: string | null;
  cc_addr: string | null;
  subject: string | null;
  category: Category | null;
  is_list: number;
  direction: Direction;
  unread: number;
  starred: number;
  important: number;
}

/** A computed contact rollup the aggregation pass hands to the repo (camelCase). */
export interface ContactAggregate {
  address: string;
  displayName?: string | null;
  domain?: string | null;
  msgsReceived: number;
  msgsSent: number;
  readCount: number;
  repliedCount: number;
  initiatedCount: number;
  starredCount: number;
  importantCount: number;
  firstSeen?: string | null;
  lastSeen?: string | null;
}

/** A computed domain rollup (camelCase). */
export interface DomainAggregate {
  domain: string;
  msgs: number;
  distinctContacts: number;
  /** Registrable (eTLD+1) form of `domain`; brand-level grouping key. */
  registrableDomain?: string | null;
}

/** A computed thread rollup (camelCase). */
export interface ThreadAggregate {
  threadId: string;
  subject?: string | null;
  participants: string[];
  msgCount: number;
  unreadCount: number;
  userParticipated: boolean;
  firstAt?: string | null;
  lastAt?: string | null;
}

/**
 * The per-contact scoring features the interest engine (M2.2, PLAN §10) reads.
 * The aggregate read columns come straight off the derived `contacts` row;
 * `bulk_count` is the count of *received* messages from this contact classified
 * as bulk (`is_list = 1 OR category IN ('promotions','social')`), computed by
 * joining the raw messages — the only signal the §10 weight table needs that
 * the contact rollup does not already carry. Snake_case rows (repo convention).
 */
export interface ContactScoringRow {
  address: string;
  msgs_received: number;
  msgs_sent: number;
  read_count: number;
  replied_count: number;
  initiated_count: number;
  starred_count: number;
  important_count: number;
  last_seen: string | null;
  bulk_count: number;
}

/** A scored contact the interest engine hands back for persistence (camelCase). */
export interface ScoredContactInput {
  address: string;
  engagementScore: number;
}

/**
 * A non-list thread's participant set, the unit of co-recipiency the graph
 * engine turns into edges (M2.3, D9, PLAN §9). One row per thread that is NOT a
 * bulk-mail thread; `participants` is the deduped set of contact addresses on
 * the thread (already JSON-decoded from `threads.participants_json`). Snake_case
 * is intentionally avoided here because the value is a decoded array, not a raw
 * SQLite scalar.
 */
export interface GraphThread {
  threadId: string;
  participants: string[];
}

/** A computed graph metric the graph engine hands back for persistence (camelCase). */
export interface GraphMetricInput {
  address: string;
  /** PageRank centrality in (0, 1]; how central the contact is to the correspondence. */
  centrality: number;
  /** Louvain community id (a social circle), or null when the contact is isolated. */
  communityId: number | null;
}

/** A persisted contact row (snake_case rows from SQLite). */
export interface ContactRow {
  account: string;
  address: string;
  display_name: string | null;
  domain: string | null;
  msgs_received: number;
  msgs_sent: number;
  read_count: number;
  replied_count: number;
  initiated_count: number;
  starred_count: number;
  important_count: number;
  first_seen: string | null;
  last_seen: string | null;
  curation: Curation | null;
}

/** A persisted domain row. */
export interface DomainRow {
  account: string;
  domain: string;
  msgs: number;
  distinct_contacts: number;
  curation: Curation | null;
  category: string | null;
}

/** A persisted thread row. */
export interface ThreadRow {
  account: string;
  thread_id: string;
  subject: string | null;
  participants_json: string | null;
  msg_count: number;
  unread_count: number;
  user_participated: number;
  first_at: string | null;
  last_at: string | null;
  summary_text: string | null;
  summary_is_model: number;
  summarized_at: string | null;
}

/**
 * A contact row enriched with its derived `engagement_score`, `centrality`, and
 * `community_id` — the shape the MCP `list_contacts` / `get_contact` /
 * `find_person` tools (M3.4, PLAN §12) project. Extends {@link ContactRow} with
 * the derived signals so the agent can rank/sort without a second read.
 * Snake_case rows (repo convention).
 */
export interface ContactDetailRow extends ContactRow {
  engagement_score: number | null;
  centrality: number | null;
  community_id: number | null;
}

/**
 * How {@link Repo.listContacts} orders the contact list (M3.4, PLAN §12). The
 * agent picks the ranking axis; every axis is a stable ORDER BY with a
 * deterministic tiebreak on address.
 */
export type ContactSort = 'engagement' | 'volume' | 'recency' | 'community';

/**
 * A {@link Repo.listContacts} filter (M3.4, PLAN §12). `correspondent` keeps
 * only Contacts the user has written to (`msgs_sent > 0`, CONTEXT.md); a
 * {@link Curation} value keeps only contacts with that disposition. Combine via
 * the options object — both are optional (AND when both supplied).
 */
export interface ContactListFilter {
  correspondent?: boolean;
  curation?: Curation;
}

/**
 * One ranked co-recipiency neighbour of a contact (M3.4 `graph_neighbors`,
 * PLAN §12, D8/D9). `shared_threads` is the number of non-list threads the pair
 * co-occurred in (the edge weight); rows are ranked by it descending so the
 * strongest correspondence partners surface first. Snake_case (repo convention).
 */
export interface GraphNeighborRow {
  address: string;
  display_name: string | null;
  domain: string | null;
  shared_threads: number;
  engagement_score: number | null;
  centrality: number | null;
  community_id: number | null;
}

/**
 * A contact row joined with the curation signals the curation propose() step
 * (M3.1, PLAN §11) ranks on. Aggregate columns + `engagement_score` come
 * straight off `contacts`; `is_list` is a derived 0/1 flag — 1 when the contact
 * is *predominantly* bulk (more than half of received mail is is_list /
 * promotions / social), the same classification signal the scorer penalises.
 * Snake_case rows (repo convention). Ordered by engagement_score desc (NULLs
 * last), then sent then received volume.
 */
export interface CurationContactRow {
  address: string;
  display_name: string | null;
  domain: string | null;
  msgs_received: number;
  msgs_sent: number;
  read_count: number;
  replied_count: number;
  starred_count: number;
  important_count: number;
  last_seen: string | null;
  engagement_score: number | null;
  is_list: number;
  curation: Curation | null;
}

/**
 * A domain row the curation propose() step ranks on. Aggregate columns +
 * `engagement_score` come off `domains`; the domain has no per-contact reply
 * signal so it is ranked by `engagement_score` (NULLs last) then message volume.
 * Snake_case rows (repo convention).
 */
export interface CurationDomainRow {
  domain: string;
  msgs: number;
  distinct_contacts: number;
  engagement_score: number | null;
  category: string | null;
  curation: Curation | null;
}

/**
 * A domain candidate for the categorization write-back loop (M3.5, PLAN §12,
 * CONTEXT.md "Entity category"). One row per domain that has at least one
 * Correspondent contact (`msgs_sent > 0`) — i.e. an entity the user has
 * back-and-forth communication with — and is not yet categorized (unless the
 * caller asks to include categorized domains). Carries volume + the count of
 * Correspondent contacts so the agent can rank. Snake_case (repo convention).
 */
export interface CategorizeCandidateRow {
  domain: string;
  msgs: number;
  distinct_contacts: number;
  correspondent_count: number;
  category: string | null;
  category_note: string | null;
}

/** A sample sender + recent subjects giving the agent context for a domain (M3.5). */
export interface CategorizeSample {
  address: string;
  display_name: string | null;
  msgs_sent: number;
  msgs_received: number;
  subjects: string[];
}

/** The persisted interest profile for an account (M3.1, PLAN §11). */
export interface InterestProfileRow {
  account: string;
  keywords: string[];
  updated_at: string | null;
}

/** A row of `account_identity`: the mailbox a label is pinned to (migration 3). */
export interface AccountIdentityRow {
  account: string;
  address: string;
  provider: string | null;
  first_seen: string | null;
  last_verified: string | null;
}

export class Repo {
  readonly driver: StorageDriver;

  // Prepared statements are cached lazily; node:sqlite caches the parse, and
  // reusing them keeps the hot sync loop tight.
  #stmt = new Map<string, PreparedStatement>();
  #transactionDepth = 0;

  constructor(driver: StorageDriver) {
    this.driver = driver;
  }

  #prepare(sql: string): PreparedStatement {
    let s = this.#stmt.get(sql);
    if (!s) {
      s = this.driver.prepare(sql);
      this.#stmt.set(sql, s);
    }
    return s;
  }

  /**
   * Run `fn` inside an IMMEDIATE transaction; rolls back on throw. Interactive
   * (read-then-decide-then-write) transactions are a node:sqlite capability; the
   * D1 driver (ticket 002) maps the few interactive Repo paths onto
   * {@link StorageDriver.batch}. Pure write groups use `driver.batch` directly.
   */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.#transactionDepth > 0) return await fn();
    await this.driver.exec('BEGIN IMMEDIATE');
    this.#transactionDepth += 1;
    try {
      const result = await fn();
      await this.driver.exec('COMMIT');
      return result;
    } catch (err) {
      await this.driver.exec('ROLLBACK');
      throw err;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  /**
   * Idempotent upsert of a Message by (account, gmail_message_id), keeping the
   * FTS row in sync and honouring the no-downgrade rule. Returns the resulting
   * body_state actually stored (which may differ from the input when an
   * incoming `meta` is held back from clobbering an existing higher state).
   */
  async upsertMessage(input: MessageInput): Promise<BodyState> {
    const incomingState: BodyState = input.bodyState ?? 'meta';
    if (!BODY_STATES.includes(incomingState)) {
      throw new IndexError(`invalid body_state: ${String(incomingState)}`);
    }
    if (input.direction && !DIRECTIONS.includes(input.direction)) {
      throw new IndexError(`invalid direction: ${String(input.direction)}`);
    }
    if (
      input.category != null &&
      !CATEGORIES.includes(input.category)
    ) {
      throw new IndexError(`invalid category: ${String(input.category)}`);
    }

    return await this.transaction(async () => {
      const existing = await this.#prepare(
        `SELECT rowid, body_state, body_text, summary_text, body_fetched_at
           FROM messages WHERE account = ? AND gmail_message_id = ?`,
      ).get(input.account, input.gmailMessageId) as
        | {
            rowid: number;
            body_state: BodyState;
            body_text: string | null;
            summary_text: string | null;
            body_fetched_at: string | null;
          }
        | undefined;

      const now = new Date().toISOString();

      // Resolve the effective body state/text honouring no-downgrade.
      let effectiveState = incomingState;
      let effectiveBody = input.bodyText ?? null;
      let bodyFetchedAt = existing?.body_fetched_at ?? null;

      if (existing) {
        const existingRank = BODY_STATE_RANK[existing.body_state];
        const incomingRank = BODY_STATE_RANK[incomingState];
        if (incomingRank < existingRank) {
          // Downgrade attempt (e.g. a plain metadata re-sync over a `full`
          // row): keep the higher existing state and its body untouched.
          effectiveState = existing.body_state;
          effectiveBody = existing.body_text;
        } else if (incomingState === 'full') {
          // Promotion (or refresh) to full: record the fetch time and take the
          // new body text.
          bodyFetchedAt = now;
        }
      } else if (incomingState === 'full') {
        bodyFetchedAt = now;
      }

      const labelsJson = input.labels ? JSON.stringify(input.labels) : null;

      const rowid = await this.#writeMessageRow(input, {
        effectiveState,
        effectiveBody,
        labelsJson,
        bodyFetchedAt,
        now,
        existingRowid: existing?.rowid,
      });

      await this.#syncFts(rowid, {
        subject: input.subject ?? null,
        sender: input.fromAddr ?? null,
        recipients: projectRecipients(input.toAddr ?? null, input.ccAddr ?? null),
        snippet: input.snippet ?? null,
        bodyText: effectiveState === 'full' ? effectiveBody : null,
        // Preserve any agent-written summary in the FTS body across a re-sync
        // (ADR-0003: summaries are FTS-indexed and improve recall). The upsert
        // never touches the summary columns, so they survive — but the FTS
        // rebuild would drop the summary text unless we re-feed it here.
        summary: existing?.summary_text ?? null,
      });

      return effectiveState;
    });
  }

  async #writeMessageRow(
    input: MessageInput,
    resolved: {
      effectiveState: BodyState;
      effectiveBody: string | null;
      labelsJson: string | null;
      bodyFetchedAt: string | null;
      now: string;
      existingRowid: number | undefined;
    },
  ): Promise<number> {
    // ON CONFLICT keeps the row's rowid stable (so the FTS rowid never drifts)
    // and recomputes only the metadata columns; body_state/body_text are set
    // from the already-resolved (no-downgrade) values.
    await this.#prepare(
      `INSERT INTO messages (
         account, gmail_message_id, rfc_message_id, thread_id, internal_date, date_header,
         from_addr, to_addr, cc_addr, subject, labels_json, category,
         is_list, direction, unread, starred, important, size_estimate,
         snippet, body_state, body_text, gmail_url, indexed_at, body_fetched_at,
         ocr_images_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )
       ON CONFLICT(account, gmail_message_id) DO UPDATE SET
         rfc_message_id  = COALESCE(excluded.rfc_message_id, messages.rfc_message_id),
         thread_id       = excluded.thread_id,
         internal_date   = excluded.internal_date,
         date_header     = excluded.date_header,
         from_addr       = excluded.from_addr,
         to_addr         = excluded.to_addr,
         cc_addr         = excluded.cc_addr,
         subject         = excluded.subject,
         labels_json     = excluded.labels_json,
         category        = excluded.category,
         is_list         = excluded.is_list,
         direction       = excluded.direction,
         unread          = excluded.unread,
         starred         = excluded.starred,
         important       = excluded.important,
         size_estimate   = excluded.size_estimate,
         snippet         = excluded.snippet,
         body_state      = excluded.body_state,
         body_text       = excluded.body_text,
         gmail_url       = excluded.gmail_url,
         indexed_at      = excluded.indexed_at,
         body_fetched_at = excluded.body_fetched_at,
         -- keep existing candidates when an incoming meta sync supplies none
         ocr_images_json = COALESCE(excluded.ocr_images_json, messages.ocr_images_json)`,
    ).run(
      input.account,
      input.gmailMessageId,
      input.rfcMessageId ?? null,
      input.threadId ?? null,
      input.internalDate ?? null,
      input.dateHeader ?? null,
      input.fromAddr ?? null,
      input.toAddr ?? null,
      input.ccAddr ?? null,
      input.subject ?? null,
      resolved.labelsJson,
      input.category ?? null,
      bool(input.isList),
      input.direction ?? 'received',
      bool(input.unread),
      bool(input.starred),
      bool(input.important),
      input.sizeEstimate ?? null,
      input.snippet ?? null,
      resolved.effectiveState,
      resolved.effectiveBody,
      input.gmailUrl ?? null,
      resolved.now,
      resolved.bodyFetchedAt,
      input.ocrImagesJson ?? null,
    );

    if (resolved.existingRowid != null) return resolved.existingRowid;
    const row = await this.#prepare(
      `SELECT rowid FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(input.account, input.gmailMessageId) as { rowid: number };
    return row.rowid;
  }

  /**
   * Replace the FTS row for a message rowid: delete-then-insert at the same
   * rowid so the index stays aligned with the message across the body ladder.
   */
  async #syncFts(
    rowid: number,
    fields: {
      subject: string | null;
      sender: string | null;
      recipients: string | null;
      snippet: string | null;
      bodyText: string | null;
      summary?: string | null;
    },
  ): Promise<void> {
    // The FTS `body` projection across the Body-state ladder is the FTS contract
    // (src/index/fts.ts) — single-sourced so index-time and query-time, and any
    // future index rebuild, can never disagree on what got indexed.
    const body = projectBody(fields);
    await this.#prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(rowid);
    await this.#prepare(
      `INSERT INTO messages_fts(rowid, subject, sender, recipients, body)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(rowid, fields.subject, fields.sender, fields.recipients, body);
  }

  /** Fetch one message row by id (or undefined). */
  async getMessage(account: string, gmailMessageId: string): Promise<MessageRow | undefined> {
    return await this.#prepare(
      `SELECT account, gmail_message_id, rfc_message_id, thread_id, subject, from_addr, to_addr,
              cc_addr, snippet, body_state, body_text, summary_text,
              summary_is_model, summarized_at, is_list, direction,
              unread, starred, important, category, internal_date, indexed_at,
              body_fetched_at, ocr_images_json, labels_json
         FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(account, gmailMessageId) as MessageRow | undefined;
  }

  /**
   * Fetch a message's stored provider URL (`gmail_url`), or null when the row is
   * absent or carries no stored URL. Used by `open` to prefer a recorded
   * provider permalink over a constructed deep link. Kept separate from
   * {@link getMessage} so `open` stays a single, cheap column read.
   */
  async getMessageUrl(account: string, gmailMessageId: string): Promise<string | null> {
    const row = await this.#prepare(
      `SELECT gmail_url FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(account, gmailMessageId) as { gmail_url: string | null } | undefined;
    return row?.gmail_url ?? null;
  }

  /**
   * Apply a label add/remove to one already-indexed message and re-derive the
   * label-driven columns, so the local index reflects an opt-in mailbox write
   * without waiting for the next sync. INDEX-ONLY: this does NOT touch the
   * provider — the caller performs the provider `modify` first (via
   * `MailSource.modify`) and calls this only on success.
   *
   * Mirrors the ingest mapping (ingest/sync.ts): `labels_json` is the raw set;
   * `category`/`direction` come from {@link classifyCategory}/
   * {@link classifyDirection}; `unread`/`starred`/`important` track the
   * `UNREAD`/`STARRED`/`IMPORTANT` labels. `is_list` is header-derived, not
   * label-derived, so it is left untouched.
   *
   * Returns the resulting label array, or `null` if the message is not indexed.
   */
  async applyLabelChange(
    account: string,
    gmailMessageId: string,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): Promise<string[] | null> {
    const row = await this.#prepare(
      `SELECT labels_json, from_addr FROM messages WHERE account = ? AND gmail_message_id = ?`,
    ).get(account, gmailMessageId) as
      | { labels_json: string | null; from_addr: string | null }
      | undefined;
    if (!row) return null;

    const current: string[] = row.labels_json ? (JSON.parse(row.labels_json) as string[]) : [];
    const removeSet = new Set(change.remove ?? []);
    const next = current.filter((l) => !removeSet.has(l));
    for (const add of change.add ?? []) {
      if (add.trim() !== '' && !next.includes(add)) next.push(add);
    }

    await this.#prepare(
      `UPDATE messages SET
         labels_json = ?, category = ?, direction = ?,
         unread = ?, starred = ?, important = ?
       WHERE account = ? AND gmail_message_id = ?`,
    ).run(
      JSON.stringify(next),
      classifyCategory(next),
      classifyDirection(next, row.from_addr),
      bool(next.includes('UNREAD')),
      bool(next.includes('STARRED')),
      bool(next.includes('IMPORTANT')),
      account,
      gmailMessageId,
    );
    return next;
  }

  /**
   * FTS search returning matching message rows ranked by bm25. `query` is raw
   * FTS5 syntax. Optionally scoped to one account.
   */
  async searchMessages(query: string, opts: { account?: string; limit?: number } = {}): Promise<MessageRow[]> {
    const limit = opts.limit ?? 20;
    const accountClause = opts.account ? 'AND m.account = ?' : '';
    const stmt = this.#prepare(
      `SELECT m.account, m.gmail_message_id, m.thread_id, m.subject, m.from_addr,
              m.to_addr, m.cc_addr, m.snippet, m.body_state, m.body_text,
              m.summary_text, m.summary_is_model, m.summarized_at,
              m.is_list, m.direction, m.unread, m.starred, m.important,
              m.category, m.internal_date, m.indexed_at, m.body_fetched_at,
              m.ocr_images_json, m.labels_json
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
        WHERE messages_fts MATCH ? ${accountClause}
        ORDER BY ${bm25Expr()}
        LIMIT ?`,
    );
    const rows = opts.account
      ? await stmt.all(query, opts.account, limit)
      : await stmt.all(query, limit);
    return rows as unknown as MessageRow[];
  }

  /**
   * Messages carrying a given Gmail label, newest-first (label query; CONTEXT.md
   * "Recall"). Tests label *membership* against the stored `labels_json` via
   * `json_each` — so `INBOX` answers "what's in my inbox", `UNREAD` "what's
   * unread", and any user label (e.g. `Label_42`) filters to that label. INBOX
   * membership is kept exact by the per-sync inbox reconcile
   * ({@link reconcileInbox}); other mutable labels reflect the last fetch.
   * Optionally scoped to one account.
   */
  async messagesByLabel(label: string, opts: { account?: string; limit?: number } = {}): Promise<MessageRow[]> {
    const limit = opts.limit ?? 20;
    const accountClause = opts.account ? 'AND m.account = ?' : '';
    const stmt = this.#prepare(
      `SELECT m.account, m.gmail_message_id, m.thread_id, m.subject, m.from_addr,
              m.to_addr, m.cc_addr, m.snippet, m.body_state, m.body_text,
              m.summary_text, m.summary_is_model, m.summarized_at,
              m.is_list, m.direction, m.unread, m.starred, m.important,
              m.category, m.internal_date, m.indexed_at, m.body_fetched_at,
              m.ocr_images_json, m.labels_json
         FROM messages m
        WHERE EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = ?) ${accountClause}
        ORDER BY m.internal_date IS NULL, m.internal_date DESC, m.gmail_message_id ASC
        LIMIT ?`,
    );
    const rows = opts.account
      ? await stmt.all(label, opts.account, limit)
      : await stmt.all(label, limit);
    return rows as unknown as MessageRow[];
  }

  /**
   * Of `ids`, the subset already indexed for `account`. Used by the inbox
   * reconcile to decide which live-inbox ids still need a metadata fetch
   * (absent) versus only a label flip (present). Empty `ids` → empty set.
   */
  async existingMessageIds(account: string, ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (ids.length === 0) return found;
    const stmt = this.#prepare(
      `SELECT gmail_message_id FROM messages WHERE account = ? AND gmail_message_id = ?`,
    );
    for (const id of ids) {
      const row = await stmt.get(account, id) as { gmail_message_id: string } | undefined;
      if (row) found.add(row.gmail_message_id);
    }
    return found;
  }

  /**
   * Ids of every message currently marked `INBOX` in its stored `labels_json`,
   * for `account`. The reconcile diffs this against the live `in:inbox` set to
   * find rows that were archived (drop `INBOX`) since the last fetch.
   */
  async inboxMessageIds(account: string): Promise<string[]> {
    const rows = await this.#prepare(
      `SELECT gmail_message_id FROM messages m
        WHERE m.account = ?
          AND EXISTS (SELECT 1 FROM json_each(m.labels_json) WHERE value = 'INBOX')`,
    ).all(account) as { gmail_message_id: string }[];
    return rows.map((r) => r.gmail_message_id);
  }

  /**
   * Overwrite a message's stored label set + derived `category` (inbox reconcile
   * membership edit). The reconcile mutates the label array in JS (add/remove
   * `INBOX`) and recomputes `category`, then persists both here so `labels_json`
   * and the `category` column stay consistent. No-op-safe on a missing row.
   */
  async setMessageLabels(account: string, id: string, labels: readonly string[], category: Category | null): Promise<void> {
    await this.#prepare(
      `UPDATE messages SET labels_json = ?, category = ?
        WHERE account = ? AND gmail_message_id = ?`,
    ).run(JSON.stringify(labels), category, account, id);
  }

  /**
   * Replace `account`'s cached Gmail label catalogue (id → name → type) with
   * `labels`. Full replace in one transaction so a label deleted provider-side
   * disappears locally too. Refreshed each sync (ingest/sync-labels.ts); read by
   * {@link labelMap} (display) and {@link labelNameToId} (write input). No-op on
   * an empty list only if you intend to clear — callers skip the call on a
   * failed fetch rather than wiping a good catalogue.
   */
  async setLabels(
    account: string,
    labels: readonly { id: string; name: string; type?: string }[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const del = this.#prepare(`DELETE FROM labels WHERE account = ?`);
    const ins = this.#prepare(
      `INSERT INTO labels (account, label_id, name, type, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    await this.transaction(async () => {
      await del.run(account);
      for (const l of labels) await ins.run(account, l.id, l.name, l.type ?? null, now);
    });
  }

  /**
   * `account`'s label id → human name map (display translation). System labels
   * (`INBOX`, `STARRED`, `CATEGORY_*`) map to themselves; opaque user ids
   * (`Label_123…`) map to their display name. Empty when no catalogue is cached
   * yet (callers then fall back to raw ids).
   */
  async labelMap(account: string): Promise<Map<string, string>> {
    const rows = await this.#prepare(
      `SELECT label_id, name FROM labels WHERE account = ?`,
    ).all(account) as { label_id: string; name: string }[];
    return new Map(rows.map((r) => [r.label_id, r.name]));
  }

  /**
   * `account`'s name → id map for write input (case-insensitive on name). Lets a
   * user pass a friendly label name (`"Coverage Review"`) that the gws path must
   * send to the API as an id. System labels and unknown strings have no entry —
   * callers pass those through unchanged.
   */
  async labelNameToId(account: string): Promise<Map<string, string>> {
    const rows = await this.#prepare(
      `SELECT label_id, name FROM labels WHERE account = ?`,
    ).all(account) as { label_id: string; name: string }[];
    return new Map(rows.map((r) => [r.name.toLowerCase(), r.label_id]));
  }

  /**
   * Render a list of label ids to human names for display, via {@link labelMap}.
   * Unknown ids (no cached catalogue, or a label seen on a message but absent
   * from the catalogue) pass through unchanged so nothing is ever dropped.
   */
  async labelNames(account: string, ids: readonly string[]): Promise<string[]> {
    const map = await this.labelMap(account);
    return ids.map((id) => map.get(id) ?? id);
  }

  /**
   * Select `meta`-state message ids for an account that an enrich run should
   * promote (SCOPE 1.1, PLAN §7 phase 2). Only `body_state='meta'` rows are
   * returned — already-enriched (`full`) and demoted (`summary-only`) rows are
   * skipped, which is what makes enrich incremental + idempotent. The `selector`
   * narrows the set:
   *
   *  - `rule: 'direct'` — the pre-curation default: `is_list = 0 AND category
   *    NOT IN ('promotions','social')` (PLAN §7).
   *  - `rule: 'all'` — every meta row (no extra predicate).
   *  - `sender` — exact `from_addr` match, OR (when it looks like a bare
   *    address) a match on the address embedded in a `Name <addr>` from header.
   *  - `match` — an FTS5 query; restrict to meta rows whose FTS row matches.
   *
   * Results are ordered newest-first by `internal_date` so a `limit` keeps the
   * most recent mail. Selector fields combine with AND.
   */
  async selectMetaMessages(account: string, selector: MetaSelector = {}): Promise<string[]> {
    const where: string[] = [`m.account = ?`, `m.body_state = 'meta'`];
    const params: unknown[] = [account];

    if (selector.rule === 'direct') {
      where.push(`m.is_list = 0 AND (m.category IS NULL OR m.category NOT IN ('promotions','social'))`);
    }

    if (selector.sender) {
      // Match the stored from_addr exactly OR by embedded bare address, so
      // `--sender jordan@partner.example.com` matches `Jordan <jordan@...>`.
      where.push(`(m.from_addr = ? OR lower(m.from_addr) LIKE ?)`);
      params.push(selector.sender, `%<${selector.sender.toLowerCase()}>%`);
    }

    let fromClause = `messages m`;
    if (selector.match) {
      // Constrain to meta rows whose FTS row matches the query. Join the FTS
      // table; FTS MATCH applies as a predicate.
      fromClause = `messages_fts f JOIN messages m ON m.rowid = f.rowid`;
      where.push(`messages_fts MATCH ?`);
      params.push(selector.match);
    }

    let sql = `SELECT m.gmail_message_id AS id FROM ${fromClause} WHERE ${where.join(' AND ')} ORDER BY m.internal_date DESC`;
    if (selector.limit != null) {
      sql += ` LIMIT ?`;
      params.push(selector.limit);
    }

    const rows = await this.#prepare(sql).all(...(params as never[])) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Resolve the curated `interest_profile` into the set of `meta` ids an
   * `enrich --profile` run should promote (SCOPE 3.2, PLAN §7 priority-1 policy,
   * D14). The curated profile IS the enrichment policy; this method is the one
   * place that translates it into a deterministic candidate id set, exactly
   * mirroring §7's priority order:
   *
   *  - **important → always.** A meta row whose sender is a curated-`important`
   *    contact, OR whose sender's domain is a curated-`important` domain, is
   *    enriched. (Domain match keys on the `@domain` suffix of `from_addr`,
   *    matching both a bare `addr@dom` and a `Name <addr@dom>` header.)
   *  - **keyword matches → yes.** A meta row matching the FTS query built from
   *    the profile's freeform `keywords` (OR-joined) is enriched.
   *  - **muted / blocked → never.** A meta row whose sender is a curated
   *    `muted`/`blocked` contact, or whose sender domain is a `muted`/`blocked`
   *    domain, is EXCLUDED even when it also matches a keyword — the negative
   *    disposition wins (§7: "muted → never"). This is the dominating filter.
   *
   * Returns newest-first by `internal_date`; `limit` caps the set. Returns an
   * empty array when the profile selects nothing (no important entities and no
   * keyword hits) — the caller treats that as "the profile enriches nothing
   * here", not an error. INDEX-ONLY: reads derived rows + FTS, no provider.
   */
  async selectProfileMetaMessages(account: string, limit?: number): Promise<string[]> {
    // The curated dispositions. `important` entities drive inclusion; `muted`
    // and `blocked` drive exclusion (both mean "never enrich", §7).
    const importantAddrs = await this.#prepare(
      `SELECT address FROM contacts WHERE account = ? AND curation = 'important'`,
    ).all(account) as { address: string }[];
    const importantDomains = await this.#prepare(
      `SELECT domain FROM domains WHERE account = ? AND curation = 'important'`,
    ).all(account) as { domain: string }[];
    const mutedAddrs = await this.#prepare(
      `SELECT address FROM contacts WHERE account = ? AND curation IN ('muted','blocked')`,
    ).all(account) as { address: string }[];
    const mutedDomains = await this.#prepare(
      `SELECT domain FROM domains WHERE account = ? AND curation IN ('muted','blocked')`,
    ).all(account) as { domain: string }[];
    const keywords = (await this.getInterestProfile(account)).keywords;

    // INCLUSION predicate: sender is an important contact OR sender domain is an
    // important domain OR the row matches the keyword FTS query. Each clause is
    // optional — only the ones the profile actually supplies are emitted.
    const include: string[] = [];
    const params: unknown[] = [account];

    for (const { address } of importantAddrs) {
      include.push(`(m.from_addr = ? OR lower(m.from_addr) LIKE ?)`);
      params.push(address, `%<${address.toLowerCase()}>%`);
    }
    for (const { domain } of importantDomains) {
      // Match the @domain suffix of the bare address or the bracketed header.
      include.push(`(lower(m.from_addr) LIKE ? OR lower(m.from_addr) LIKE ?)`);
      params.push(`%@${domain.toLowerCase()}`, `%@${domain.toLowerCase()}>%`);
    }

    // Keywords become an FTS subquery on the self-contained FTS table, so the
    // keyword clause stays a simple `m.rowid IN (...)` against `messages_fts`.
    let keywordClause: string | null = null;
    if (keywords.length > 0) {
      // OR-join the keywords into one FTS query (quote each term so a multi-word
      // keyword is a phrase and punctuation can't break the query).
      const ftsQuery = keywords.map((k) => `"${k.replace(/"/g, '""')}"`).join(' OR ');
      keywordClause = `m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)`;
      // The keyword param is appended AFTER the important-entity params but
      // BEFORE the exclusion params, matching the clause emission order below.
      params.push(ftsQuery);
      include.push(keywordClause);
    }

    // No inclusion clauses at all → the profile selects nothing. Return early so
    // we never emit `WHERE ... AND ()` (which would match every meta row).
    if (include.length === 0) return [];

    const where: string[] = [`m.account = ?`, `m.body_state = 'meta'`, `(${include.join(' OR ')})`];

    // EXCLUSION: muted/blocked sender or sender-domain dominates inclusion.
    for (const { address } of mutedAddrs) {
      where.push(`NOT (m.from_addr = ? OR lower(m.from_addr) LIKE ?)`);
      params.push(address, `%<${address.toLowerCase()}>%`);
    }
    for (const { domain } of mutedDomains) {
      where.push(`NOT (lower(m.from_addr) LIKE ? OR lower(m.from_addr) LIKE ?)`);
      params.push(`%@${domain.toLowerCase()}`, `%@${domain.toLowerCase()}>%`);
    }

    let sql = `SELECT m.gmail_message_id AS id FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.internal_date DESC`;
    if (limit != null) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.#prepare(sql).all(...(params as never[])) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Count messages, optionally scoped to one account. */
  async countMessages(account?: string): Promise<number> {
    const row = account
      ? (await this.#prepare(`SELECT count(*) c FROM messages WHERE account = ?`).get(
          account,
        ) as { c: number })
      : (await this.#prepare(`SELECT count(*) c FROM messages`).get() as { c: number });
    return row.c;
  }

  // ---- sync_runs audit (PLAN §6) ----------------------------------------

  /** Open a sync_runs row; returns its id for the matching finish call. */
  async startSyncRun(input: SyncRunStart): Promise<number> {
    if (!SYNC_PHASES.includes(input.phase)) {
      throw new IndexError(`invalid sync phase: ${String(input.phase)}`);
    }
    const res = await this.#prepare(
      `INSERT INTO sync_runs (account, phase, selector, started_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.account, input.phase, input.selector ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** Atomically acquire the per-Account sync lock across SQLite connections and D1 isolates. */
  async acquireSyncRun(input: SyncRunStart): Promise<number | undefined> {
    if (!SYNC_PHASES.includes(input.phase)) throw new IndexError(`invalid sync phase: ${String(input.phase)}`);
    const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    const row = await this.#prepare(
      `INSERT INTO sync_runs (account, phase, selector, started_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM sync_runs WHERE account = ? AND finished_at IS NULL AND started_at > ?
       )
       RETURNING id`,
    ).get(input.account, input.phase, input.selector ?? null, new Date().toISOString(), input.account, cutoff) as { id: number } | undefined;
    return row?.id;
  }

  /**
   * The id of a LIVE in-progress sync_runs row for `account` (started, not yet
   * finished, and started within {@link STALE_LOCK_MS}), or undefined when none.
   * A live in-progress row is the per-account sync LOCK (ADR-0005): the sync
   * layer refuses a second concurrent run while one exists. When `exceptId` is
   * given it is ignored — so a freshly opened run can ask "is anyone else
   * running?" without seeing itself.
   *
   * A row whose `started_at` is older than {@link STALE_LOCK_MS} is treated as a
   * DEAD lock (the sync process crashed without closing its row) and does NOT
   * block — otherwise one crashed sync would wedge the account forever, blocking
   * both manual syncs and the ADR-0005 auto-refresh. The threshold sits above the
   * longest legitimate run (an initial whole-mailbox sweep) so a live long sync
   * is never mistaken for dead.
   */
  async activeSyncRun(account: string, exceptId?: number): Promise<number | undefined> {
    const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    const row = await this.#prepare(
      `SELECT id FROM sync_runs
        WHERE account = ? AND finished_at IS NULL AND id != ? AND started_at > ?
        ORDER BY id LIMIT 1`,
    ).get(account, exceptId ?? -1, cutoff) as { id: number } | undefined;
    return row?.id;
  }

  /**
   * Count completed (`finished_at` set, no `error`) phase-1 `sync` runs for an
   * account. Used by the CLI to decide whether a sweep is the account's INITIAL
   * sync (count 0 before this run) — one of the two triggers for the auto graph
   * build (D10); the other is an explicit whole-mailbox `--all` sweep.
   */
  async completedSyncCount(account: string): Promise<number> {
    const row = await this.#prepare(
      `SELECT count(*) c FROM sync_runs
        WHERE account = ? AND phase = 'sync' AND finished_at IS NOT NULL AND error IS NULL`,
    ).get(account) as { c: number };
    return row.c;
  }

  /** Close a sync_runs row with counts and optional error. */
  async finishSyncRun(id: number, result: SyncRunFinish = {}): Promise<void> {
    await this.#prepare(
      `UPDATE sync_runs
          SET finished_at = ?, fetched = ?, indexed = ?, error = ?
        WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      result.fetched ?? 0,
      result.indexed ?? 0,
      result.error ?? null,
      id,
    );
  }

  // ---- contacts / domains (curation surfaces; full population is M2) ------

  /** Upsert a contact's identity/curation fields (idempotent). */
  async upsertContact(input: ContactInput): Promise<void> {
    if (input.curation != null && !CURATIONS.includes(input.curation)) {
      throw new IndexError(`invalid curation: ${String(input.curation)}`);
    }
    await this.#prepare(
      `INSERT INTO contacts (account, address, display_name, domain, curation)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, address) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, contacts.display_name),
         domain       = COALESCE(excluded.domain, contacts.domain),
         curation     = excluded.curation`,
    ).run(
      input.account,
      input.address,
      input.displayName ?? null,
      input.domain ?? null,
      input.curation ?? null,
    );
  }

  /** Write back an agent-assigned domain category (PLAN §6, write-back loop). */
  async setDomainCategory(input: DomainCategoryInput): Promise<void> {
    await this.#prepare(
      `INSERT INTO domains (account, domain, category, category_note, categorized_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, domain) DO UPDATE SET
         category       = excluded.category,
         category_note  = excluded.category_note,
         categorized_at = excluded.categorized_at`,
    ).run(
      input.account,
      input.domain,
      input.category,
      input.note ?? null,
      new Date().toISOString(),
    );
  }

  // ---- write-back loops: summaries + compaction (M3.5, ADR-0003/0004) -----
  //
  // The agent reading the mail is itself an LLM (ADR-0004); the tool ships no
  // intelligence (ADR-0002). These methods persist agent-authored summaries —
  // provenance-marked, FTS-indexed (so a paraphrase improves recall), and
  // NEVER overwriting the source fields (subject/from/snippet/body stay intact;
  // the summary lands in its own columns). `saveMessageSummary` only marks the
  // body *eligible* for demotion (sets `summarized_at`); the demotion itself is
  // `compactEligible` + `demoteMessage`, gated by a grace window (ADR-0003).

  /**
   * Persist an agent-authored summary onto a message (ADR-0003). Writes
   * `summary_text` / `summary_is_model` / `summarized_at` only — the source
   * columns (subject, body_text, body_state, …) are untouched. Re-indexes the
   * message's FTS row so the summary feeds recall immediately. The
   * `summarized_at` stamp is what makes the body eligible for compaction after
   * the grace window; saving a summary does NOT demote (ADR-0003: a bad summary
   * gets a week of retry-against-source first). Throws {@link IndexError} when
   * the message does not exist (no row to attach to) or the text is empty.
   * Returns the stamped `summarized_at`.
   */
  async saveMessageSummary(input: MessageSummaryInput): Promise<string> {
    const text = input.text?.trim() ?? '';
    if (text === '') {
      throw new IndexError('saveMessageSummary requires non-empty summary text');
    }
    const at = input.at ?? new Date().toISOString();
    return await this.transaction(async () => {
      const row = await this.#prepare(
        `SELECT rowid, subject, from_addr, to_addr, cc_addr, snippet,
                body_state, body_text
           FROM messages WHERE account = ? AND gmail_message_id = ?`,
      ).get(input.account, input.gmailMessageId) as
        | {
            rowid: number;
            subject: string | null;
            from_addr: string | null;
            to_addr: string | null;
            cc_addr: string | null;
            snippet: string | null;
            body_state: BodyState;
            body_text: string | null;
          }
        | undefined;
      if (!row) {
        throw new IndexError(
          `cannot summarize unknown message ${input.account}:${input.gmailMessageId}`,
        );
      }

      await this.#prepare(
        `UPDATE messages
            SET summary_text = ?, summary_is_model = ?, summarized_at = ?
          WHERE account = ? AND gmail_message_id = ?`,
      ).run(
        text,
        bool(input.isModel ?? true),
        at,
        input.account,
        input.gmailMessageId,
      );

      await this.#syncFts(row.rowid, {
        subject: row.subject,
        sender: row.from_addr,
        recipients: [row.to_addr, row.cc_addr].filter(Boolean).join(' ') || null,
        snippet: row.snippet,
        // A summary on a still-full row is additive — keep indexing the body too.
        bodyText: row.body_state === 'full' ? row.body_text : null,
        summary: text,
      });

      return at;
    });
  }

  /**
   * Persist an agent-authored summary onto a thread (ADR-0003). Threads carry
   * no FTS row of their own (per-message FTS already covers the conversation),
   * so this is a pure column write — provenance-marked, never overwriting the
   * thread's source fields. Throws {@link IndexError} when the thread does not
   * exist or the text is empty. Returns the stamped `summarized_at`.
   */
  async saveThreadSummary(input: ThreadSummaryInput): Promise<string> {
    const text = input.text?.trim() ?? '';
    if (text === '') {
      throw new IndexError('saveThreadSummary requires non-empty summary text');
    }
    const at = input.at ?? new Date().toISOString();
    const res = await this.#prepare(
      `UPDATE threads
          SET summary_text = ?, summary_is_model = ?, summarized_at = ?
        WHERE account = ? AND thread_id = ?`,
    ).run(text, bool(input.isModel ?? true), at, input.account, input.threadId);
    if (res.changes === 0) {
      throw new IndexError(
        `cannot summarize unknown thread ${input.account}:${input.threadId}`,
      );
    }
    return at;
  }

  /**
   * The messages eligible for compaction (ADR-0003): `body_state='full'` rows
   * that (1) have an agent-written summary (`summarized_at IS NOT NULL`),
   * (2) were summarized before `before` (the grace cutoff), and (3) are bulk /
   * non-curated and NOT in a user-participated thread — the demotion never
   * touches curated-important contacts or threads the user took part in:
   *
   *  - SPARED: the sender is a curated-`important` contact, OR the sender's
   *    domain is a curated-`important` domain, OR the message's thread has
   *    `user_participated = 1`.
   *  - ELIGIBLE among the rest: `is_list = 1` OR `category IN
   *    ('promotions','social')` (bulk mail) — the only mail whose body is safe
   *    to drop (ADR-0003: summary-only is the end state for bulk / non-curated
   *    mail). Direct human mail the user never replied to is left at `full`.
   *
   * Returns compact candidate rows; the caller demotes via {@link demoteMessage}.
   */
  async compactEligible(account: string, before: string, limit?: number): Promise<CompactCandidateRow[]> {
    const sql =
      `SELECT m.gmail_message_id, m.thread_id, m.summarized_at
         FROM messages m
        WHERE m.account = ?
          AND m.body_state = 'full'
          AND m.summary_text IS NOT NULL
          AND m.summarized_at IS NOT NULL
          AND m.summarized_at <= ?
          -- bulk only: newsletters / notifications (ADR-0003)
          AND (m.is_list = 1 OR m.category IN ('promotions','social'))
          -- never demote a thread the user took part in
          AND NOT EXISTS (
            SELECT 1 FROM threads t
             WHERE t.account = m.account AND t.thread_id = m.thread_id
               AND t.user_participated = 1
          )
          -- never demote a curated-important sender (contact or its domain)
          AND NOT EXISTS (
            SELECT 1 FROM contacts c
             WHERE c.account = m.account AND c.curation = 'important'
               AND (
                 m.from_addr = c.address
                 OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%'
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM domains d
             WHERE d.account = m.account AND d.curation = 'important'
               AND (
                 lower(m.from_addr) LIKE '%@' || lower(d.domain)
                 OR lower(m.from_addr) LIKE '%@' || lower(d.domain) || '>%'
               )
          )
        ORDER BY m.summarized_at ASC, m.gmail_message_id ASC` +
      (limit != null ? ` LIMIT ?` : ``);
    const rows =
      limit != null
        ? await this.#prepare(sql).all(account, before, limit)
        : await this.#prepare(sql).all(account, before);
    return rows as unknown as CompactCandidateRow[];
  }

  /**
   * Demote one message from `full` to `summary-only` (ADR-0003): drop the
   * distilled `body_text`, advance `body_state`, and re-index FTS so the body
   * column now holds the snippet + summary (the dropped body is gone). The
   * no-downgrade ladder treats `summary-only` as the top state, so a later
   * `meta`/`full` re-sync will not clobber it. INDEX-ONLY; the provider remains
   * the archive (Working set), so this is never data loss — the body can be
   * re-enriched by id. Returns whether a row was demoted (false when the row is
   * absent or not in `full` state).
   */
  async demoteMessage(account: string, gmailMessageId: string): Promise<boolean> {
    return await this.transaction(async () => {
      const row = await this.#prepare(
        `SELECT rowid, subject, from_addr, to_addr, cc_addr, snippet,
                body_state, summary_text
           FROM messages WHERE account = ? AND gmail_message_id = ?`,
      ).get(account, gmailMessageId) as
        | {
            rowid: number;
            subject: string | null;
            from_addr: string | null;
            to_addr: string | null;
            cc_addr: string | null;
            snippet: string | null;
            body_state: BodyState;
            summary_text: string | null;
          }
        | undefined;
      if (!row || row.body_state !== 'full' || !row.summary_text) return false;

      await this.#prepare(
        `UPDATE messages
            SET body_state = 'summary-only', body_text = NULL
          WHERE account = ? AND gmail_message_id = ?`,
      ).run(account, gmailMessageId);

      await this.#syncFts(row.rowid, {
        subject: row.subject,
        sender: row.from_addr,
        recipients: [row.to_addr, row.cc_addr].filter(Boolean).join(' ') || null,
        snippet: row.snippet,
        bodyText: null, // body dropped
        summary: row.summary_text,
      });
      return true;
    });
  }

  /**
   * Domain candidates for the categorization write-back loop (M3.5, PLAN §12).
   * Returns domains that have at least one Correspondent contact (`msgs_sent >
   * 0`) — the entities the user has back-and-forth communication with — ranked
   * by Correspondent count then volume. By default excludes already-categorized
   * domains (`category IS NULL`); pass `includeCategorized` to surface all.
   */
  async domainsToCategorize(
    account: string,
    opts: { includeCategorized?: boolean; limit?: number } = {},
  ): Promise<CategorizeCandidateRow[]> {
    const catClause = opts.includeCategorized ? `` : `AND d.category IS NULL`;
    const sql =
      `SELECT d.domain, d.msgs, d.distinct_contacts, d.category, d.category_note,
              (
                SELECT count(*) FROM contacts c
                 WHERE c.account = d.account AND c.domain = d.domain
                   AND c.msgs_sent > 0
              ) AS correspondent_count
         FROM domains d
        WHERE d.account = ? ${catClause}
          AND EXISTS (
            SELECT 1 FROM contacts c
             WHERE c.account = d.account AND c.domain = d.domain
               AND c.msgs_sent > 0
          )
        ORDER BY correspondent_count DESC, d.msgs DESC, d.domain ASC` +
      (opts.limit != null ? ` LIMIT ?` : ``);
    const rows =
      opts.limit != null
        ? await this.#prepare(sql).all(account, opts.limit)
        : await this.#prepare(sql).all(account);
    return rows as unknown as CategorizeCandidateRow[];
  }

  /**
   * Sample senders + recent subjects for a domain (M3.5), the CONTEXT the
   * categorization loop hands the agent's LLM. Up to `senderLimit` contacts on
   * the domain (Correspondents first), each with up to `subjectLimit` of their
   * most recent subjects. INDEX-ONLY.
   */
  async categorizeSamples(
    account: string,
    domain: string,
    opts: { senderLimit?: number; subjectLimit?: number } = {},
  ): Promise<CategorizeSample[]> {
    const senderLimit = opts.senderLimit ?? 5;
    const subjectLimit = opts.subjectLimit ?? 3;
    const contacts = await this.#prepare(
      `SELECT address, display_name, msgs_sent, msgs_received
         FROM contacts
        WHERE account = ? AND domain = ?
        ORDER BY msgs_sent DESC, msgs_received DESC, address ASC
        LIMIT ?`,
    ).all(account, domain, senderLimit) as {
      address: string;
      display_name: string | null;
      msgs_sent: number;
      msgs_received: number;
    }[];

    const subjectStmt = this.#prepare(
      `SELECT subject FROM messages
        WHERE account = ?
          AND (from_addr = ? OR lower(from_addr) LIKE '%<' || lower(?) || '>%')
          AND subject IS NOT NULL AND subject != ''
        ORDER BY internal_date DESC
        LIMIT ?`,
    );
    return Promise.all(
      contacts.map(async (c) => {
        const subjects = (
          (await subjectStmt.all(account, c.address, c.address, subjectLimit)) as {
            subject: string;
          }[]
        ).map((r) => r.subject);
        return {
          address: c.address,
          display_name: c.display_name,
          msgs_sent: c.msgs_sent,
          msgs_received: c.msgs_received,
          subjects,
        };
      }),
    );
  }

  // ---- aggregation read surface (M2.1, PLAN §6) ---------------------------
  //
  // The intelligence layer reads the INDEX ONLY (PLAN §4) — never the provider.
  // These methods expose the message rows the aggregation pass rolls up, plus
  // typed accessors for the derived contact/domain/thread tables it writes.

  /**
   * Stream the message fields the aggregation pass (`intelligence/aggregate.ts`)
   * needs to roll messages up into contacts/domains/threads. Scoped to one
   * account; ordered oldest-first by `internal_date` so first/last-seen and the
   * thread "who started it" (initiated) signal fall out of a single forward
   * pass. NULL `internal_date` rows sort first (oldest) deterministically.
   */
  async messagesForAggregation(account: string): Promise<AggregationMessageRow[]> {
    return await this.#prepare(
      `SELECT account, gmail_message_id, thread_id, internal_date, date_header,
              from_addr, to_addr, cc_addr, subject, category, is_list, direction,
              unread, starred, important
         FROM messages
        WHERE account = ?
        ORDER BY internal_date IS NULL DESC, internal_date ASC, gmail_message_id ASC`,
    ).all(account) as unknown as AggregationMessageRow[];
  }

  /**
   * Replace the derived contact/domain/thread rows for `account` in one
   * transaction, so aggregation is idempotent and re-runnable: a re-run produces
   * the same tables with no stale rows and no duplicates. Identity/curation
   * columns the aggregation does not own — `person_id`, `curation`,
   * `centrality`, `community_id` (contacts); `curation`, `category`,
   * `category_note`, `categorized_at` (domains) — are preserved across the
   * rebuild by carrying the existing values forward (an UPSERT, not a wipe), so
   * a user's curation survives every aggregation.
   */
  async replaceAggregates(
    account: string,
    aggregates: {
      contacts: readonly ContactAggregate[];
      domains: readonly DomainAggregate[];
      threads: readonly ThreadAggregate[];
    },
  ): Promise<void> {
    await this.transaction(async () => {
      await this.#replaceContacts(account, aggregates.contacts);
      await this.#replaceDomains(account, aggregates.domains);
      await this.#replaceThreads(account, aggregates.threads);
    });
  }

  async #replaceContacts(account: string, contacts: readonly ContactAggregate[]): Promise<void> {
    // Drop contacts that no longer aggregate (none of their mail remains), but
    // keep curation/identity for any that persist via the UPSERT below.
    const keep = new Set(contacts.map((c) => c.address));
    const existing = await this.#prepare(
      `SELECT address FROM contacts WHERE account = ?`,
    ).all(account) as { address: string }[];
    const del = this.#prepare(`DELETE FROM contacts WHERE account = ? AND address = ?`);
    for (const row of existing) {
      if (!keep.has(row.address)) await del.run(account, row.address);
    }

    const up = this.#prepare(
      `INSERT INTO contacts (
         account, address, display_name, domain,
         msgs_received, msgs_sent, read_count, replied_count, initiated_count,
         starred_count, important_count, first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, address) DO UPDATE SET
         display_name    = COALESCE(excluded.display_name, contacts.display_name),
         domain          = COALESCE(excluded.domain, contacts.domain),
         msgs_received   = excluded.msgs_received,
         msgs_sent       = excluded.msgs_sent,
         read_count      = excluded.read_count,
         replied_count   = excluded.replied_count,
         initiated_count = excluded.initiated_count,
         starred_count   = excluded.starred_count,
         important_count = excluded.important_count,
         first_seen      = excluded.first_seen,
         last_seen       = excluded.last_seen`,
    );
    for (const c of contacts) {
      await up.run(
        account,
        c.address,
        c.displayName ?? null,
        c.domain ?? null,
        c.msgsReceived,
        c.msgsSent,
        c.readCount,
        c.repliedCount,
        c.initiatedCount,
        c.starredCount,
        c.importantCount,
        c.firstSeen ?? null,
        c.lastSeen ?? null,
      );
    }
  }

  async #replaceDomains(account: string, domains: readonly DomainAggregate[]): Promise<void> {
    const keep = new Set(domains.map((d) => d.domain));
    const existing = await this.#prepare(
      `SELECT domain FROM domains WHERE account = ?`,
    ).all(account) as { domain: string }[];
    const del = this.#prepare(`DELETE FROM domains WHERE account = ? AND domain = ?`);
    for (const row of existing) {
      if (!keep.has(row.domain)) await del.run(account, row.domain);
    }

    const up = this.#prepare(
      `INSERT INTO domains (account, domain, msgs, distinct_contacts, registrable_domain)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account, domain) DO UPDATE SET
         msgs               = excluded.msgs,
         distinct_contacts  = excluded.distinct_contacts,
         registrable_domain = excluded.registrable_domain`,
    );
    for (const d of domains) {
      await up.run(account, d.domain, d.msgs, d.distinctContacts, d.registrableDomain ?? null);
    }
  }

  async #replaceThreads(account: string, threads: readonly ThreadAggregate[]): Promise<void> {
    // Threads now carry an agent-written summary (M3.5, ADR-0003) that the
    // aggregation does not own — so a clean wipe would drop it. Drop only
    // threads that no longer aggregate, and UPSERT the rest so the summary
    // columns survive a rebuild (matching contacts/domains).
    const keep = new Set(threads.map((t) => t.threadId));
    const existing = await this.#prepare(
      `SELECT thread_id FROM threads WHERE account = ?`,
    ).all(account) as { thread_id: string }[];
    const del = this.#prepare(`DELETE FROM threads WHERE account = ? AND thread_id = ?`);
    for (const row of existing) {
      if (!keep.has(row.thread_id)) await del.run(account, row.thread_id);
    }

    const up = this.#prepare(
      `INSERT INTO threads (
         account, thread_id, subject, participants_json,
         msg_count, unread_count, user_participated, first_at, last_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, thread_id) DO UPDATE SET
         subject           = excluded.subject,
         participants_json = excluded.participants_json,
         msg_count         = excluded.msg_count,
         unread_count      = excluded.unread_count,
         user_participated = excluded.user_participated,
         first_at          = excluded.first_at,
         last_at           = excluded.last_at`,
    );
    for (const t of threads) {
      await up.run(
        account,
        t.threadId,
        t.subject ?? null,
        JSON.stringify(t.participants),
        t.msgCount,
        t.unreadCount,
        bool(t.userParticipated),
        t.firstAt ?? null,
        t.lastAt ?? null,
      );
    }
  }

  /**
   * Per-host domain metadata for the cadence read: the raw sender host, its
   * registrable (eTLD+1) brand key (migration 6; NULL until the next
   * aggregation), and any agent-assigned entity `category`. Lets the cadence
   * pass map a message's sender host to its brand + category without re-deriving
   * either. Scoped to one account.
   */
  async domainsMeta(account: string): Promise<{ domain: string; registrable_domain: string | null; category: string | null }[]> {
    return await this.#prepare(
      `SELECT domain, registrable_domain, category FROM domains WHERE account = ?`,
    ).all(account) as { domain: string; registrable_domain: string | null; category: string | null }[];
  }

  /** Fetch one aggregated contact row (or undefined). */
  async getContact(account: string, address: string): Promise<ContactRow | undefined> {
    return await this.#prepare(
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation
         FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as ContactRow | undefined;
  }

  /**
   * List Correspondents — contacts the user has ever written to (`msgs_sent >
   * 0`, CONTEXT.md). The sharpest human-vs-noise separator: people remember by
   * who they talked to. Ordered by sent volume then received volume, newest
   * correspondence first on ties.
   */
  async listCorrespondents(account: string, limit?: number): Promise<ContactRow[]> {
    const sql =
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation
         FROM contacts
        WHERE account = ? AND msgs_sent > 0
        ORDER BY msgs_sent DESC, msgs_received DESC, last_seen DESC` +
      (limit != null ? ` LIMIT ?` : ``);
    const rows = limit != null
      ? await this.#prepare(sql).all(account, limit)
      : await this.#prepare(sql).all(account);
    return rows as unknown as ContactRow[];
  }

  /** Fetch one aggregated domain row (or undefined). */
  async getDomain(account: string, domain: string): Promise<DomainRow | undefined> {
    return await this.#prepare(
      `SELECT account, domain, msgs, distinct_contacts, curation, category
         FROM domains WHERE account = ? AND domain = ?`,
    ).get(account, domain) as DomainRow | undefined;
  }

  /** Fetch one aggregated thread row (or undefined). */
  async getThread(account: string, threadId: string): Promise<ThreadRow | undefined> {
    return await this.#prepare(
      `SELECT account, thread_id, subject, participants_json, msg_count,
              unread_count, user_participated, first_at, last_at,
              summary_text, summary_is_model, summarized_at
         FROM threads WHERE account = ? AND thread_id = ?`,
    ).get(account, threadId) as ThreadRow | undefined;
  }

  // ---- MCP read surface (M3.4, PLAN §12) ----------------------------------
  //
  // INDEX-ONLY (PLAN §4): the MCP server reads these derived rows to answer
  // recall-shaped questions (CONTEXT.md "Recall") — ranked contact lists, fuzzy
  // person resolution (Correspondents first), thread listings, and graph
  // neighbours/communities. None touch a provider. Shapes stay compact +
  // token-conscious (SCOPE 3.4(b)): bounded by `limit`, snippet/metadata only.
  // An optional `account` scopes to one mailbox; omit it for cross-account.

  /**
   * List contacts ranked by `sort` and narrowed by `filter` (M3.4, PLAN §12,
   * DESIGN TEST recall). Projects the derived `engagement_score` / `centrality`
   * / `community_id` alongside the aggregate columns. Sorts:
   *  - `engagement` — engagement_score desc (NULLs last), then sent/received;
   *  - `volume` — received + sent desc;
   *  - `recency` — last_seen desc;
   *  - `community` — community_id asc (NULLs last), then engagement desc.
   * All have a stable `address` tiebreak. `limit` defaults at the call site.
   */
  async listContacts(
    opts: {
      account?: string;
      sort?: ContactSort;
      filter?: ContactListFilter;
      limit?: number;
    } = {},
  ): Promise<ContactDetailRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.account) {
      where.push(`account = ?`);
      params.push(opts.account);
    }
    if (opts.filter?.correspondent) where.push(`msgs_sent > 0`);
    if (opts.filter?.curation) {
      where.push(`curation = ?`);
      params.push(opts.filter.curation);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderBy: string;
    switch (opts.sort ?? 'engagement') {
      case 'volume':
        orderBy = `(msgs_received + msgs_sent) DESC, address ASC`;
        break;
      case 'recency':
        orderBy = `last_seen IS NULL, last_seen DESC, address ASC`;
        break;
      case 'community':
        orderBy = `community_id IS NULL, community_id ASC, engagement_score IS NULL, engagement_score DESC, address ASC`;
        break;
      case 'engagement':
      default:
        orderBy = `engagement_score IS NULL, engagement_score DESC, msgs_sent DESC, msgs_received DESC, address ASC`;
        break;
    }

    const limit = opts.limit ?? 20;
    const rows = await this.#prepare(
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation,
              engagement_score, centrality, community_id
         FROM contacts
        ${whereSql}
        ORDER BY ${orderBy}
        LIMIT ?`,
    ).all(...(params as never[]), limit) as unknown as ContactDetailRow[];
    return rows;
  }

  /** Fetch one contact with its derived signals (M3.4 `get_contact`). */
  async getContactDetail(account: string, address: string): Promise<ContactDetailRow | undefined> {
    return await this.#prepare(
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation,
              engagement_score, centrality, community_id
         FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as ContactDetailRow | undefined;
  }

  /**
   * Fuzzy contact resolution from a vague hint (M3.4 `find_person`, PLAN §12,
   * CONTEXT.md "Recall"). Matches the hint as a case-insensitive substring of
   * the display name, the address, or the domain — so a name fragment, a bare
   * handle, or a company domain all resolve. CRITICAL ranking (PLAN §12, DESIGN
   * TEST): **Correspondents first** — people remember by who they talked to —
   * so rows are ordered `msgs_sent > 0` desc, then engagement_score (NULLs
   * last), then sent/received volume, then address. Never returns a bare empty
   * set where a substring near-miss exists. `limit` defaults at the call site.
   */
  async findContacts(hint: string, opts: { account?: string; limit?: number } = {}): Promise<ContactDetailRow[]> {
    const needle = `%${hint.trim().toLowerCase()}%`;
    const where: string[] = [
      `(lower(display_name) LIKE ? OR lower(address) LIKE ? OR lower(domain) LIKE ?)`,
    ];
    const params: unknown[] = [needle, needle, needle];
    if (opts.account) {
      where.push(`account = ?`);
      params.push(opts.account);
    }
    const limit = opts.limit ?? 10;
    const rows = await this.#prepare(
      `SELECT account, address, display_name, domain, msgs_received, msgs_sent,
              read_count, replied_count, initiated_count, starred_count,
              important_count, first_seen, last_seen, curation,
              engagement_score, centrality, community_id
         FROM contacts
        WHERE ${where.join(' AND ')}
        ORDER BY (msgs_sent > 0) DESC, engagement_score IS NULL, engagement_score DESC,
                 msgs_sent DESC, msgs_received DESC, address ASC
        LIMIT ?`,
    ).all(...(params as never[]), limit) as unknown as ContactDetailRow[];
    return rows;
  }

  /**
   * Threads a contact participates in, newest-first (M3.4 `list_threads` by
   * contact, `get_contact` recent threads). A thread "involves" the contact when
   * the contact is its sender or recipient on any message — matched by the bare
   * address or the bracketed `Name <addr>` header form. `limit` defaults at the
   * call site.
   */
  async threadsForContact(account: string, address: string, limit = 20): Promise<ThreadRow[]> {
    const bare = address.toLowerCase();
    const bracket = `%<${bare}>%`;
    const rows = await this.#prepare(
      `SELECT t.account, t.thread_id, t.subject, t.participants_json, t.msg_count,
              t.unread_count, t.user_participated, t.first_at, t.last_at,
              t.summary_text, t.summary_is_model, t.summarized_at
         FROM threads t
        WHERE t.account = ?
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.account = t.account AND m.thread_id = t.thread_id
               AND (
                 m.from_addr = ? OR lower(m.from_addr) LIKE ?
                 OR m.to_addr = ? OR lower(m.to_addr) LIKE ?
                 OR m.cc_addr = ? OR lower(m.cc_addr) LIKE ?
               )
          )
        ORDER BY t.last_at IS NULL, t.last_at DESC, t.thread_id ASC
        LIMIT ?`,
    ).all(account, address, bracket, address, bracket, address, bracket, limit) as unknown as ThreadRow[];
    return rows;
  }

  /**
   * Threads whose messages match an FTS query, ranked best-first (M3.4
   * `list_threads` by query). Resolves the FTS hits to their distinct threads,
   * ordered by the best (lowest bm25) hit in each thread. `limit` defaults at the
   * call site.
   */
  async threadsForQuery(query: string, opts: { account?: string; limit?: number } = {}): Promise<ThreadRow[]> {
    const limit = opts.limit ?? 20;
    // FTS5's bm25() is an auxiliary function usable only in the direct FTS query
    // context (an ORDER BY over the matched FTS table) — selecting it through a
    // JOIN/GROUP BY raises "unable to use function bm25". So fold thread ranking
    // in JS: walk the bm25-ordered message hits (reusing the proven
    // {@link searchMessages} path) and keep each thread's FIRST (best-ranked)
    // appearance, preserving rank order, then fetch the thread rows in that
    // order. A generous hit cap keeps it bounded.
    const hits = await this.searchMessages(query, {
      ...(opts.account ? { account: opts.account } : {}),
      limit: Math.max(limit * 5, 50),
    });
    const seen = new Set<string>();
    const ordered: { account: string; threadId: string }[] = [];
    for (const h of hits) {
      if (!h.thread_id) continue;
      const key = `${h.account} ${h.thread_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push({ account: h.account, threadId: h.thread_id });
      if (ordered.length >= limit) break;
    }
    const out: ThreadRow[] = [];
    for (const { account, threadId } of ordered) {
      const t = await this.getThread(account, threadId);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * The messages of a thread, oldest-first (M3.4 `get_thread`). Compact
   * projection — the snippet + summary feed the agent without dumping bodies
   * (token-conscious, SCOPE 3.4(b)); a body is opt-in via `get_message`.
   */
  async threadMessages(account: string, threadId: string): Promise<MessageRow[]> {
    return await this.#prepare(
      `SELECT account, gmail_message_id, thread_id, subject, from_addr, to_addr,
              cc_addr, snippet, body_state, body_text, summary_text,
              summary_is_model, summarized_at, is_list, direction,
              unread, starred, important, category, internal_date, indexed_at,
              body_fetched_at
         FROM messages
        WHERE account = ? AND thread_id = ?
        ORDER BY internal_date IS NULL DESC, internal_date ASC, gmail_message_id ASC`,
    ).all(account, threadId) as unknown as MessageRow[];
  }

  /**
   * Ranked co-recipiency neighbours of a contact (M3.4 `graph_neighbors`,
   * PLAN §12, D9). Walks the non-list threads the contact shares with others and
   * counts, per other contact, how many such threads they co-occur in — the same
   * co-recipiency signal the graph engine's edges encode. Ranked by shared-thread
   * count desc then engagement. Reads `threads.participants_json` (already
   * restricted to non-list threads here) so it never re-walks raw messages
   * beyond the is_list guard. Returns `[]` when the contact has no non-list
   * co-recipients — the caller then falls back to a ranked near-miss set so a
   * miss is never a bare empty answer (DESIGN TEST recall).
   */
  async graphNeighbors(account: string, address: string, limit = 15): Promise<GraphNeighborRow[]> {
    const contactRows = await this.#prepare(
      `SELECT address FROM contacts WHERE account = ?`,
    ).all(account) as { address: string }[];
    const contactSet = new Set(contactRows.map((r) => r.address));

    const threads = await this.#prepare(
      `SELECT t.participants_json AS participants_json
         FROM threads t
        WHERE t.account = ?
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.account = t.account AND m.thread_id = t.thread_id
               AND m.is_list = 1
          )`,
    ).all(account) as { participants_json: string | null }[];

    const counts = new Map<string, number>();
    for (const t of threads) {
      if (!t.participants_json) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t.participants_json);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const addrs = parsed.filter((p): p is string => typeof p === 'string' && contactSet.has(p));
      if (!addrs.includes(address)) continue;
      for (const other of new Set(addrs)) {
        if (other === address) continue;
        counts.set(other, (counts.get(other) ?? 0) + 1);
      }
    }
    if (counts.size === 0) return [];

    const detail = this.#prepare(
      `SELECT display_name, domain, engagement_score, centrality, community_id
         FROM contacts WHERE account = ? AND address = ?`,
    );
    const out: GraphNeighborRow[] = [];
    for (const [other, shared] of counts) {
      const d = await detail.get(account, other) as
        | {
            display_name: string | null;
            domain: string | null;
            engagement_score: number | null;
            centrality: number | null;
            community_id: number | null;
          }
        | undefined;
      out.push({
        address: other,
        display_name: d?.display_name ?? null,
        domain: d?.domain ?? null,
        shared_threads: shared,
        engagement_score: d?.engagement_score ?? null,
        centrality: d?.centrality ?? null,
        community_id: d?.community_id ?? null,
      });
    }
    out.sort(
      (a, b) =>
        b.shared_threads - a.shared_threads ||
        (b.engagement_score ?? -Infinity) - (a.engagement_score ?? -Infinity) ||
        a.address.localeCompare(b.address),
    );
    return out.slice(0, limit);
  }

  /**
   * The detected social circles (M3.4 `graph_communities`, PLAN §12, D8). Groups
   * contacts by their persisted `community_id` (set by the graph engine's
   * Louvain pass), returning one entry per community with its top members ranked
   * by centrality. Contacts with a null `community_id` (graph never built, or
   * isolated) are omitted. `memberLimit` caps members per community
   * (token-conscious). Communities are ordered by size desc.
   */
  async graphCommunities(account: string, memberLimit = 10): Promise<
    {
      communityId: number;
      size: number;
      members: { address: string; display_name: string | null; centrality: number | null }[];
    }[]
  > {
    const rows = await this.#prepare(
      `SELECT community_id, address, display_name, centrality
         FROM contacts
        WHERE account = ? AND community_id IS NOT NULL
        ORDER BY community_id ASC, centrality IS NULL, centrality DESC, address ASC`,
    ).all(account) as {
      community_id: number;
      address: string;
      display_name: string | null;
      centrality: number | null;
    }[];

    const byCommunity = new Map<
      number,
      { address: string; display_name: string | null; centrality: number | null }[]
    >();
    for (const r of rows) {
      let members = byCommunity.get(r.community_id);
      if (!members) {
        members = [];
        byCommunity.set(r.community_id, members);
      }
      members.push({ address: r.address, display_name: r.display_name, centrality: r.centrality });
    }

    const out = [...byCommunity.entries()].map(([communityId, members]) => ({
      communityId,
      size: members.length,
      members: members.slice(0, memberLimit),
    }));
    out.sort((a, b) => b.size - a.size || a.communityId - b.communityId);
    return out;
  }

  // ---- interest engine surface (M2.2, PLAN §10, D12) ----------------------
  //
  // INDEX-ONLY (PLAN §4): the interest engine reads these derived rows and
  // writes back `engagement_score` + a `contact_stats_snapshot`, never touching
  // a provider.

  /**
   * The per-contact scoring features the interest engine blends (PLAN §10). One
   * row per aggregated contact for `account`. The aggregate columns are read
   * straight off `contacts`; `bulk_count` is computed with a correlated
   * subquery counting this contact's *received* bulk mail (is_list OR
   * promotions/social) from the raw `messages`, matching either the exact
   * `from_addr` or the bare address embedded in a `Name <addr>` header — the one
   * §10 signal the contact rollup does not already carry.
   */
  async contactScoringRows(account: string): Promise<ContactScoringRow[]> {
    const rows = await this.#prepare(
      `SELECT c.address, c.msgs_received, c.msgs_sent, c.read_count,
              c.replied_count, c.initiated_count, c.starred_count,
              c.important_count, c.last_seen,
              (
                SELECT count(*) FROM messages m
                 WHERE m.account = c.account
                   AND m.direction = 'received'
                   AND (m.is_list = 1 OR m.category IN ('promotions','social'))
                   AND (
                     m.from_addr = c.address
                     OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%'
                   )
              ) AS bulk_count
         FROM contacts c
        WHERE c.account = ?`,
    ).all(account) as unknown as ContactScoringRow[];
    return rows;
  }

  /**
   * Persist the interest engine's output for `account` (D12): set each contact's
   * `engagement_score` and append one `contact_stats_snapshot` row per contact
   * stamped `taken_at`. Both in one transaction so a run is atomic. The snapshot
   * is append-only — re-running the pass adds a new generation (distinct
   * `taken_at`) rather than overwriting, which is what makes trend a v1.1 query
   * with no migration. Scores are written only for contacts that still exist
   * (the aggregation owns row lifecycle); a snapshot mirrors the score's source
   * aggregates (msgs_received / read_count / replied_count) so a snapshot is
   * self-describing without a join back to a mutable `contacts` row.
   */
  async persistEngagementScores(
    account: string,
    scored: readonly ScoredContactInput[],
    takenAt: string,
  ): Promise<void> {
    const setScore = this.#prepare(
      `UPDATE contacts SET engagement_score = ? WHERE account = ? AND address = ?`,
    );
    const snapshot = this.#prepare(
      `INSERT INTO contact_stats_snapshot (
         account, address, taken_at,
         msgs_received, read_count, replied_count, engagement_score
       )
       SELECT account, address, ?, msgs_received, read_count, replied_count, ?
         FROM contacts WHERE account = ? AND address = ?
       ON CONFLICT(account, address, taken_at) DO UPDATE SET
         msgs_received    = excluded.msgs_received,
         read_count       = excluded.read_count,
         replied_count    = excluded.replied_count,
         engagement_score = excluded.engagement_score`,
    );
    await this.transaction(async () => {
      for (const s of scored) {
        await setScore.run(s.engagementScore, account, s.address);
        await snapshot.run(takenAt, s.engagementScore, account, s.address);
      }
    });
  }

  /** Fetch a contact's current engagement_score (or null/undefined). */
  async getEngagementScore(account: string, address: string): Promise<number | null | undefined> {
    const row = await this.#prepare(
      `SELECT engagement_score FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as { engagement_score: number | null } | undefined;
    return row ? row.engagement_score : undefined;
  }

  /** Count `contact_stats_snapshot` rows for a contact (snapshot generations). */
  async countSnapshots(account: string, address: string): Promise<number> {
    const row = await this.#prepare(
      `SELECT count(*) c FROM contact_stats_snapshot WHERE account = ? AND address = ?`,
    ).get(account, address) as { c: number };
    return row.c;
  }

  // ---- graph engine surface (M2.3, PLAN §9, D8/D9) ------------------------
  //
  // INDEX-ONLY (PLAN §4): the graph engine reads non-list threads' participant
  // sets and writes back `centrality` + `community_id` onto contacts, never
  // touching a provider. Kept here (not in the graph module) so the graph layer
  // depends only on the repo, and the core index never imports graphology (D8).

  /**
   * The co-recipiency input for the graph engine (D9, PLAN §9): the participant
   * set of every **non-list** thread for `account`. A thread is treated as
   * bulk (and excluded) when ANY of its messages is classified `is_list = 1` —
   * mailing-list / announcement threads form dense cliques that would poison
   * community detection, so D9 drops them wholesale. Threads with fewer than two
   * participants carry no co-recipiency edge and are omitted. Participants come
   * straight off the already-aggregated `threads.participants_json` (the
   * aggregation pass, M2.1, owns building that set), so this is a pure derived
   * read — the graph engine never re-walks raw messages.
   *
   * Participants are intersected with the account's `contacts` set: the
   * aggregation records the user's own address among thread participants, but
   * the user is never a contact (they sit on every thread by definition, which
   * would otherwise make the user the universally-central node and merge every
   * social circle). Restricting nodes to actual contacts yields the graph of
   * "who is central to YOUR correspondence" (PLAN §9) rather than to you.
   */
  async graphThreads(account: string): Promise<GraphThread[]> {
    const contactRows = await this.#prepare(
      `SELECT address FROM contacts WHERE account = ?`,
    ).all(account) as { address: string }[];
    const contactSet = new Set(contactRows.map((r) => r.address));

    // A thread is "list" if any of its messages is is_list; exclude those.
    const rows = await this.#prepare(
      `SELECT t.thread_id AS thread_id, t.participants_json AS participants_json
         FROM threads t
        WHERE t.account = ?
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.account = t.account
               AND m.thread_id = t.thread_id
               AND m.is_list = 1
          )`,
    ).all(account) as { thread_id: string; participants_json: string | null }[];

    const out: GraphThread[] = [];
    for (const row of rows) {
      if (!row.participants_json) continue;
      let participants: unknown;
      try {
        participants = JSON.parse(row.participants_json);
      } catch {
        continue;
      }
      if (!Array.isArray(participants)) continue;
      const addrs = [
        ...new Set(
          participants.filter(
            (p): p is string => typeof p === 'string' && contactSet.has(p),
          ),
        ),
      ];
      if (addrs.length < 2) continue;
      out.push({ threadId: row.thread_id, participants: addrs });
    }
    return out;
  }

  /**
   * Persist the graph engine's output for `account` (D8, PLAN §9): set each
   * contact's `centrality` and `community_id`. One transaction so a build is
   * atomic. Scores are written only for contacts that still exist (the
   * aggregation owns row lifecycle); contacts absent from `metrics` keep their
   * prior values, so a rebuild over a narrower graph never silently clears a
   * contact that simply had no non-list edges this run — callers that want a
   * clean slate pass every contact. `community_id` may be null for an isolated
   * contact.
   */
  async persistGraphMetrics(account: string, metrics: readonly GraphMetricInput[]): Promise<void> {
    const set = this.#prepare(
      `UPDATE contacts SET centrality = ?, community_id = ?
        WHERE account = ? AND address = ?`,
    );
    await this.transaction(async () => {
      for (const m of metrics) {
        await set.run(m.centrality, m.communityId, account, m.address);
      }
    });
  }

  /** Fetch a contact's derived graph metrics (centrality + community_id). */
  async getGraphMetrics(
    account: string,
    address: string,
  ): Promise<{ centrality: number | null; community_id: number | null } | undefined> {
    return await this.#prepare(
      `SELECT centrality, community_id FROM contacts WHERE account = ? AND address = ?`,
    ).get(account, address) as
      | { centrality: number | null; community_id: number | null }
      | undefined;
  }

  // ---- curation surface (M3.1, PLAN §11, D13/D14) -------------------------
  //
  // INDEX-ONLY (PLAN §4): the curation loop reads the derived/scored rows to
  // PROPOSE a ranked shortlist (the seed, D13) and writes the user's disposition
  // back onto `contacts.curation` / `domains.curation` and the freeform
  // `interest_profile` keywords. Touches no provider; triggers no enrichment.

  /**
   * Top contacts for the curation shortlist (D13, PLAN §11). Ordered by
   * `engagement_score` descending with NULL scores last (an unscored contact
   * has never been through the interest pass), then by sent then received
   * volume so ties resolve toward Correspondents. `is_list` is derived: 1 when
   * MORE THAN HALF the contact's received mail is bulk (is_list / promotions /
   * social) — the same signal the scorer penalises — so the agent can suggest
   * `muted` for predominantly-bulk senders. `limit` caps the shortlist
   * (token-conscious; default 20).
   */
  async curationContacts(account: string, limit = 20): Promise<CurationContactRow[]> {
    const rows = await this.#prepare(
      `SELECT c.address, c.display_name, c.domain, c.msgs_received, c.msgs_sent,
              c.read_count, c.replied_count, c.starred_count, c.important_count,
              c.last_seen, c.engagement_score, c.curation,
              CASE
                WHEN c.msgs_received > 0 AND (
                  SELECT count(*) FROM messages m
                   WHERE m.account = c.account
                     AND m.direction = 'received'
                     AND (m.is_list = 1 OR m.category IN ('promotions','social'))
                     AND (
                       m.from_addr = c.address
                       OR lower(m.from_addr) LIKE '%<' || lower(c.address) || '>%'
                     )
                ) * 2 > c.msgs_received
                THEN 1 ELSE 0
              END AS is_list
         FROM contacts c
        WHERE c.account = ?
        ORDER BY c.engagement_score IS NULL, c.engagement_score DESC,
                 c.msgs_sent DESC, c.msgs_received DESC, c.address ASC
        LIMIT ?`,
    ).all(account, limit) as unknown as CurationContactRow[];
    return rows;
  }

  /**
   * Top domains for the curation shortlist (D13, PLAN §11). Ordered by
   * `engagement_score` descending (NULLs last) then message volume. `limit`
   * caps the shortlist (token-conscious; default 20).
   */
  async curationDomains(account: string, limit = 20): Promise<CurationDomainRow[]> {
    const rows = await this.#prepare(
      `SELECT domain, msgs, distinct_contacts, engagement_score, category, curation
         FROM domains
        WHERE account = ?
        ORDER BY engagement_score IS NULL, engagement_score DESC,
                 msgs DESC, domain ASC
        LIMIT ?`,
    ).all(account, limit) as unknown as CurationDomainRow[];
    return rows;
  }

  /**
   * Set a contact's curation label (null clears it). The contact must already
   * exist (the aggregation owns row lifecycle); a missing address is a no-op so
   * the caller can apply a shortlist without first checking presence. Returns
   * whether a row was updated.
   */
  async setContactCuration(account: string, address: string, curation: Curation | null): Promise<boolean> {
    if (curation != null && !CURATIONS.includes(curation)) {
      throw new IndexError(`invalid curation: ${String(curation)}`);
    }
    const res = await this.#prepare(
      `UPDATE contacts SET curation = ? WHERE account = ? AND address = ?`,
    ).run(curation, account, address);
    return res.changes > 0;
  }

  /**
   * Set a domain's curation label (null clears it). Unlike a contact, a domain
   * the user wants to curate may not yet have an aggregated row (e.g. blocking a
   * domain pre-emptively), so this UPSERTS the domain row, preserving any
   * existing aggregate/category columns. Returns nothing (always succeeds).
   */
  async setDomainCuration(account: string, domain: string, curation: Curation | null): Promise<void> {
    if (curation != null && !CURATIONS.includes(curation)) {
      throw new IndexError(`invalid curation: ${String(curation)}`);
    }
    await this.#prepare(
      `INSERT INTO domains (account, domain, curation) VALUES (?, ?, ?)
       ON CONFLICT(account, domain) DO UPDATE SET curation = excluded.curation`,
    ).run(account, domain, curation);
  }

  /**
   * The contacts that currently carry a curation label, for reading back the
   * profile (M3.1, PLAN §11). Ordered by address for a stable shape. `curation`
   * is non-null by the WHERE clause.
   */
  async curatedContacts(account: string): Promise<{ address: string; curation: Curation }[]> {
    return await this.#prepare(
      `SELECT address, curation FROM contacts
        WHERE account = ? AND curation IS NOT NULL
        ORDER BY address ASC`,
    ).all(account) as unknown as { address: string; curation: Curation }[];
  }

  /** The domains that currently carry a curation label (see {@link curatedContacts}). */
  async curatedDomains(account: string): Promise<{ domain: string; curation: Curation }[]> {
    return await this.#prepare(
      `SELECT domain, curation FROM domains
        WHERE account = ? AND curation IS NOT NULL
        ORDER BY domain ASC`,
    ).all(account) as unknown as { domain: string; curation: Curation }[];
  }

  /**
   * Read the account's interest profile: the freeform curation keywords and the
   * `updated_at` stamp. Returns an empty (no keywords, null timestamp) profile
   * when the account has never been curated, so callers never special-case
   * absence. Keywords are JSON-decoded from `keywords_json`.
   */
  async getInterestProfile(account: string): Promise<InterestProfileRow> {
    const row = await this.#prepare(
      `SELECT keywords_json, updated_at FROM interest_profile WHERE account = ?`,
    ).get(account) as { keywords_json: string | null; updated_at: string | null } | undefined;
    let keywords: string[] = [];
    if (row?.keywords_json) {
      try {
        const parsed: unknown = JSON.parse(row.keywords_json);
        if (Array.isArray(parsed)) {
          keywords = parsed.filter((k): k is string => typeof k === 'string');
        }
      } catch {
        keywords = [];
      }
    }
    return { account, keywords, updated_at: row?.updated_at ?? null };
  }

  /**
   * Persist the account's freeform interest keywords and bump `updated_at`
   * (M3.1, PLAN §11). Keywords are stored as a JSON array in `keywords_json`;
   * the write is idempotent (same keywords → same row, fresh `updated_at`).
   * Returns the stamped `updated_at`.
   */
  async setInterestKeywords(account: string, keywords: readonly string[], at?: string): Promise<string> {
    const updatedAt = at ?? new Date().toISOString();
    await this.#prepare(
      `INSERT INTO interest_profile (account, keywords_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         keywords_json = excluded.keywords_json,
         updated_at    = excluded.updated_at`,
    ).run(account, JSON.stringify([...keywords]), updatedAt);
    return updatedAt;
  }

  /**
   * The authenticated mailbox identity an account label is bound to, or null if
   * the label has never recorded one (its first sync). Used by the sync identity
   * guard to keep a label pinned to one mailbox across an adapter switch.
   */
  async getAccountIdentity(account: string): Promise<AccountIdentityRow | null> {
    const row = await this.#prepare(
      `SELECT account, address, provider, first_seen, last_verified
         FROM account_identity WHERE account = ?`,
    ).get(account) as AccountIdentityRow | undefined;
    return row ?? null;
  }

  /**
   * Record (or refresh) the authenticated mailbox identity for an account label.
   * On first sight stamps `first_seen`; every call refreshes `last_verified` and
   * the verifying `provider`. The bound `address` itself is never rewritten once
   * set (the guard blocks a mismatch before this is called), so a transport
   * switch to the same mailbox just updates `provider`/`last_verified`.
   */
  async setAccountIdentity(account: string, address: string, provider: string, at?: string): Promise<void> {
    const now = at ?? new Date().toISOString();
    await this.#prepare(
      `INSERT INTO account_identity (account, address, provider, first_seen, last_verified)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         provider      = excluded.provider,
         last_verified = excluded.last_verified`,
    ).run(account, address, provider, now, now);
  }
}
