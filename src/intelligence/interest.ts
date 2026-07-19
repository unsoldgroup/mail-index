/**
 * Interest engine — per-contact engagement score + append-only snapshots
 * (SCOPE 2.2, PLAN §10 the weight table, D12, D13, CONTEXT.md "Engagement
 * score").
 *
 * This is a **derived, INDEX-ONLY** pass (PLAN §4): it reads the aggregated
 * `contacts` rows (built by the M2.1 aggregation pass) plus a small per-contact
 * classification rollup, computes a weighted `engagement_score` from
 * CURRENT-STATE aggregates each run (D12 — Gmail exposes only the current
 * `UNREAD`/`STARRED`/`IMPORTANT` labels, never a read timestamp, so the score is
 * recomputed wholesale every sync, not incrementally accumulated), persists the
 * score back onto `contacts`, and appends one `contact_stats_snapshot` row per
 * contact so trend becomes a v1.1 *query* with no migration.
 *
 * The score is a **seed for curation, never an autonomous fetch trigger** (D13):
 * computing it touches no `MailSource` and triggers no enrichment. It only ranks
 * contacts so the curation loop (M3) has a prior to propose from.
 *
 * The scoring math ({@link scoreContact}) is a pure function of a feature record
 * so it is unit-testable in isolation from the DB; {@link interestPass} is the
 * thin DB-reading/-writing wrapper over it.
 *
 * ## The weight table (PLAN §10)
 *
 * The score is a weighted blend of normalized signals. Each signal contributes
 * `weight × value`, where `value` is in `[0, 1]` (rates) or a saturating
 * transform of a count/volume so a handful of strong signals dominates without a
 * single prolific contact running away to infinity. The weights below encode the
 * PLAN §10 magnitudes (strong+ / medium+ / + / small+ / −):
 *
 *  | Signal              | PLAN weight | Constant            | Sign |
 *  |---------------------|-------------|---------------------|------|
 *  | replied             | strong +    | W_REPLIED   = 3.0   |  +   |
 *  | initiated           | strong +    | W_INITIATED = 3.0   |  +   |
 *  | starred             | +           | W_STARRED   = 1.0   |  +   |
 *  | important           | medium +    | W_IMPORTANT = 1.5   |  +   |
 *  | read-rate           | medium +    | W_READ_RATE = 1.5   |  +   |
 *  | recency × volume    | small +     | W_RECENCY_VOL = 0.5 |  +   |
 *  | is_list/promo/social| −           | W_BULK     = -2.0   |  −   |
 *  | never-opened        | −           | W_NEVER_OPENED = -2.0|  − |
 *
 * The replied/initiated signals saturate on *count* (a correspondent the user
 * has replied to ten times is comfortably maxed); read-rate and the bulk
 * fraction are already rates in `[0, 1]`; recency×volume blends a recency decay
 * with a saturating volume term. The exact transforms live beside each term
 * below so the magnitudes are auditable.
 */

import type { ContactScoringRow, Repo } from '../index/repo.js';

// ---- weights (PLAN §10) ---------------------------------------------------

/** replied — user sent into the contact's thread (needs Sent index, D11). strong + */
export const W_REPLIED = 3.0;
/** initiated — user started the thread. strong + */
export const W_INITIATED = 3.0;
/** important — `IMPORTANT` label. medium + */
export const W_IMPORTANT = 1.5;
/** read-rate — 1 − (unread / received). medium + */
export const W_READ_RATE = 1.5;
/** starred — `STARRED` label. + */
export const W_STARRED = 1.0;
/** recency × volume — last_seen × msgs_received. small + */
export const W_RECENCY_VOL = 0.5;
/** is_list / promotions / social — classification. − */
export const W_BULK = -2.0;
/** never-opened — all received mail still unread. − */
export const W_NEVER_OPENED = -2.0;

/** Half-life (days) for the recency decay: a contact last seen this long ago
 *  contributes half its recency weight; older decays geometrically. */
const RECENCY_HALF_LIFE_DAYS = 60;

/** Volume saturates: this many received messages reaches ~half the volume term;
 *  the curve is `v / (v + K)`, so no single prolific contact runs away. */
const VOLUME_SATURATION = 10;

/** Count saturation for replied/initiated: `c / (c + K)`. A few replies max it. */
const COUNT_SATURATION = 3;

/**
 * The features {@link scoreContact} blends. All counts are CURRENT-STATE
 * aggregates (D12). `nowMs`/`lastSeenMs` drive the recency decay; when either is
 * null the recency×volume term contributes 0 (we cannot date the contact).
 */
export interface ContactFeatures {
  /** Messages the user received from this contact. */
  msgsReceived: number;
  /** Messages the user sent to this contact (Correspondent signal, D11). */
  msgsSent: number;
  /** Received messages that are NOT unread (read snapshot, D12). */
  readCount: number;
  /** Times the user replied to this contact within a thread. */
  repliedCount: number;
  /** Times the user initiated a thread with this contact. */
  initiatedCount: number;
  /** Received messages carrying the STARRED label. */
  starredCount: number;
  /** Received messages carrying the IMPORTANT label. */
  importantCount: number;
  /** Received messages classified as bulk (is_list OR promotions OR social). */
  bulkCount: number;
  /** Epoch-ms of the contact's most recent message, or null if undated. */
  lastSeenMs: number | null;
  /** "Now" reference for the recency decay (epoch-ms). */
  nowMs: number;
}

const MS_PER_DAY = 86_400_000;

/** Saturating transform `c / (c + k)` → `[0, 1)`; negatives clamp to 0. */
function saturate(count: number, k: number): number {
  if (count <= 0) return 0;
  return count / (count + k);
}

/**
 * Compute a contact's engagement score from its current-state features (PLAN
 * §10). PURE: no I/O, no clock read (the caller supplies `nowMs`), so it is
 * unit-testable in isolation. Higher = more engaged. The score is unbounded by
 * design (weights are additive) but, because every term is normalized to a
 * bounded transform, it lands in a stable range (roughly −4 … +9) that ranks
 * cleanly; only the *ordering* is load-bearing for curation (D13).
 */
export function scoreContact(f: ContactFeatures): number {
  let score = 0;

  // Strong +: the user wrote back / reached out. Saturate on count.
  score += W_REPLIED * saturate(f.repliedCount, COUNT_SATURATION);
  score += W_INITIATED * saturate(f.initiatedCount, COUNT_SATURATION);

  // +: explicit user signals on received mail. Saturate on count.
  score += W_STARRED * saturate(f.starredCount, COUNT_SATURATION);
  score += W_IMPORTANT * saturate(f.importantCount, COUNT_SATURATION);

  // Medium +: read-rate = 1 − (unread / received), a rate in [0, 1]. Only
  // meaningful when the user has actually received mail from the contact.
  if (f.msgsReceived > 0) {
    const readRate = Math.min(1, Math.max(0, f.readCount / f.msgsReceived));
    score += W_READ_RATE * readRate;
  }

  // Small +: recency × volume. A recency decay (half-life) times a saturating
  // volume term, so recent + frequent correspondents get a small lift and old
  // one-offs get almost none.
  if (f.lastSeenMs != null && f.msgsReceived + f.msgsSent > 0) {
    const ageDays = Math.max(0, (f.nowMs - f.lastSeenMs) / MS_PER_DAY);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS); // (0, 1]
    const volume = saturate(f.msgsReceived + f.msgsSent, VOLUME_SATURATION);
    score += W_RECENCY_VOL * recency * volume;
  }

  // −: bulk mail (is_list / promotions / social). Penalize by the fraction of
  // received mail that is bulk, so a pure newsletter is fully penalized and an
  // occasional list mail from a real correspondent barely is.
  if (f.msgsReceived > 0) {
    const bulkFraction = Math.min(1, f.bulkCount / f.msgsReceived);
    score += W_BULK * bulkFraction;

    // −: never-opened — every received message is still unread AND the user has
    // never written back. The sharpest "noise" signal; stacks on the bulk
    // penalty for a never-read newsletter.
    if (f.readCount === 0 && f.repliedCount === 0 && f.initiatedCount === 0) {
      score += W_NEVER_OPENED;
    }
  }

  return score;
}

/** Map a repo scoring row (snake_case) onto the pure {@link ContactFeatures}. */
function featuresFromRow(row: ContactScoringRow, nowMs: number): ContactFeatures {
  const lastSeenMs = row.last_seen ? Date.parse(row.last_seen) : NaN;
  return {
    msgsReceived: row.msgs_received,
    msgsSent: row.msgs_sent,
    readCount: row.read_count,
    repliedCount: row.replied_count,
    initiatedCount: row.initiated_count,
    starredCount: row.starred_count,
    importantCount: row.important_count,
    bulkCount: row.bulk_count,
    lastSeenMs: Number.isNaN(lastSeenMs) ? null : lastSeenMs,
    nowMs,
  };
}

/** A scored contact ready for persistence: address + its computed score. */
export interface ScoredContact {
  address: string;
  engagementScore: number;
}

/** Outcome of an {@link interestPass} run. */
export interface InterestResult {
  /** The account scored. */
  account: string;
  /** The scored contacts (address + engagement_score), in input order. */
  scored: ScoredContact[];
  /** The ISO timestamp stamped on this run's snapshot rows. */
  takenAt: string;
}

/** Options for {@link interestPass} (mostly for deterministic testing). */
export interface InterestOptions {
  /** "Now" reference for recency decay + the snapshot timestamp. Defaults to
   *  the wall clock. Injectable so scoring is deterministic in tests. */
  now?: Date;
}

/**
 * Run the interest engine for one account against the index (D12, D13):
 *
 *  1. read each contact's current-state scoring features (a derived,
 *     INDEX-ONLY read — {@link Repo.contactScoringRows});
 *  2. compute its {@link scoreContact};
 *  3. persist the scores onto `contacts.engagement_score` AND append one
 *     `contact_stats_snapshot` row per contact (account, address, taken_at,
 *     msgs_received, read_count, replied_count, engagement_score) — both in one
 *     transaction so a run is atomic and idempotent (re-running with the same
 *     index state recomputes the same scores; each run adds exactly one snapshot
 *     generation, distinguished by `taken_at`).
 *
 * Touches no `MailSource` and triggers no enrichment (D13). Returns the scored
 * contacts so callers (sync, CLI) can report without re-reading.
 */
export async function interestPass(
  repo: Repo,
  account: string,
  options: InterestOptions = {},
): Promise<InterestResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const takenAt = now.toISOString();

  const rows = await repo.contactScoringRows(account);
  const scored: ScoredContact[] = rows.map((row) => ({
    address: row.address,
    engagementScore: scoreContact(featuresFromRow(row, nowMs)),
  }));

  await repo.persistEngagementScores(account, scored, takenAt);

  return { account, scored, takenAt };
}
