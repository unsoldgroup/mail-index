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
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  body_window_months: 3,
  retention: 'window',
  onboarding_completed_at: null,
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
