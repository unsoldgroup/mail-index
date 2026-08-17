/**
 * Per-Account settings — the operator knobs that shape the working set.
 *
 * mail-index indexes metadata wide and bodies narrow (ADR-0003: the index is a
 * working set, the provider is the archive). Which bodies are worth holding is
 * the one part of that policy only the operator can answer, so it lives here
 * rather than in code constants.
 *
 * Defaults are applied on read, so an Account with no stored row behaves
 * exactly like one saved with the defaults — mailboxes connected before this
 * existed need no backfill.
 */

/** The body-retention policy for an Account. */
export interface AccountSettings {
  /**
   * How many months of mail keep full bodies. Mail newer than this is enriched
   * proactively; mail older has its body evicted unless protected (see
   * `Repo.retentionEligible`). `0` disables the window entirely — bodies are
   * then selected only by the interest profile, the pre-window behaviour.
   */
  body_window_months: number;
  /**
   * `'window'` runs the eviction sweep; `'off'` enriches forward but never
   * evicts, letting the index grow without bound.
   */
  retention: 'window' | 'off';
  /** Set once the guided first run has completed for this Account. */
  onboarding_completed_at: string | null;
  /**
   * How far back the historical backfill has swept, as `YYYY-MM-DD`. Each slice
   * moves it earlier; `null` means it has not started, and it stops at
   * {@link BACKFILL_FLOOR}. Persisted so the sweep resumes where it stopped
   * rather than restarting after every Worker restart.
   */
  backfill_cursor: string | null;
  /** Set when the sweep has reached the floor; no further slices are queued. */
  backfill_done: boolean;
}

/**
 * The earliest date a backfill will reach. Gmail launched in 2004, so nothing
 * older exists to find, and an unbounded floor would sweep empty years forever.
 */
export const BACKFILL_FLOOR = '2004-01-01';

/** How much history one backfill slice covers. */
export const BACKFILL_SLICE_MONTHS = 12;

/**
 * The [since, until) bounds of the next backfill slice, or null when the sweep
 * is finished. Slices run NEWEST-first: the mail just outside the synced window
 * is the most likely to be asked about, so coverage becomes useful immediately
 * instead of after the whole history lands.
 */
export function nextBackfillSlice(
  settings: AccountSettings,
  now: Date = new Date(),
): { since: string; until: string } | null {
  if (settings.backfill_done) return null;
  const until = settings.backfill_cursor ?? isoDay(now);
  if (until <= BACKFILL_FLOOR) return null;
  const since = new Date(`${until}T00:00:00.000Z`);
  since.setUTCMonth(since.getUTCMonth() - BACKFILL_SLICE_MONTHS);
  const sinceDay = isoDay(since);
  return { since: sinceDay < BACKFILL_FLOOR ? BACKFILL_FLOOR : sinceDay, until };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  body_window_months: 3,
  retention: 'window',
  onboarding_completed_at: null,
  backfill_cursor: null,
  backfill_done: false,
};

/** The largest window we accept, so a typo cannot turn into a full-mailbox body fetch. */
const MAX_WINDOW_MONTHS = 120;

/**
 * Coerce stored/user-supplied JSON into a valid {@link AccountSettings}.
 * Unknown keys are dropped and invalid values fall back to the default, so a
 * hand-edited row can never wedge a Job with a NaN cutoff.
 */
export function normalizeSettings(input: unknown): AccountSettings {
  const raw = (input ?? {}) as Partial<Record<keyof AccountSettings, unknown>>;
  const months = Number(raw.body_window_months);
  return {
    body_window_months:
      Number.isInteger(months) && months >= 0 && months <= MAX_WINDOW_MONTHS
        ? months
        : DEFAULT_ACCOUNT_SETTINGS.body_window_months,
    retention: raw.retention === 'off' ? 'off' : DEFAULT_ACCOUNT_SETTINGS.retention,
    onboarding_completed_at:
      typeof raw.onboarding_completed_at === 'string' ? raw.onboarding_completed_at : null,
    backfill_cursor:
      typeof raw.backfill_cursor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.backfill_cursor)
        ? raw.backfill_cursor
        : null,
    backfill_done: raw.backfill_done === true,
  };
}

/**
 * The epoch-ms boundary of the working set: mail at or after it keeps a body,
 * mail before it is evictable.
 *
 * Enrichment and eviction MUST derive their cutoff from this one function. If
 * they disagree by even a day, the boundary messages are re-fetched by one Job
 * and dropped by the other on every cycle — an invisible, permanent loop of
 * provider calls. Returns null when the window is disabled (`0` months), which
 * means "no time bound", not "everything is expired".
 */
export function windowCutoff(settings: AccountSettings, now: Date = new Date()): number | null {
  if (settings.body_window_months <= 0) return null;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - settings.body_window_months);
  return cutoff.getTime();
}
