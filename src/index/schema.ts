/**
 * Schema constants and shared types for the index layer.
 *
 * The full data model is defined in PLAN.md §6. Migrations (see
 * `migrations.ts`) are the executable, versioned source of truth for the SQL;
 * this module holds the TypeScript-facing shapes and the small set of closed
 * enums that the repo layer enforces (ADR-0003 body-state ladder, message
 * direction, curation labels).
 */

/** The current (latest) schema version. Bumped whenever a migration is added. */
export const SCHEMA_VERSION = 11;

/**
 * Body state — where a Message sits on the compaction ladder (CONTEXT.md,
 * ADR-0003). `meta` = headers + snippet only; `full` = distilled body text,
 * FTS-indexed; `summary-only` = body demoted after summarization.
 */
export const BODY_STATES = ['meta', 'full', 'summary-only'] as const;
export type BodyState = (typeof BODY_STATES)[number];

/**
 * Rank of each body state on the ladder. Higher = more content. Used by the
 * repo's no-downgrade invariant: a re-sync may only move a Message up the
 * ladder (meta → full → summary-only is the lifecycle, but a plain re-sync
 * delivering `meta` must never clobber an existing `full`/`summary-only`).
 *
 * `full` and `summary-only` both sit above `meta`. `summary-only` is the end
 * state reached *after* `full` via deliberate demotion (compact), so it ranks
 * highest; an incoming `full` re-sync must not downgrade a `summary-only` row.
 */
export const BODY_STATE_RANK: Record<BodyState, number> = {
  meta: 0,
  full: 1,
  'summary-only': 2,
};

/** Message direction (PLAN §8). */
export const DIRECTIONS = ['received', 'sent'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Gmail-derived message category (PLAN §8); null when unknown. */
export const CATEGORIES = [
  'promotions',
  'social',
  'updates',
  'forums',
  'personal',
  'primary',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Curation label on a Contact or Domain (PLAN §6, §11). */
export const CURATIONS = ['important', 'muted', 'blocked'] as const;
export type Curation = (typeof CURATIONS)[number];

/** Sync-run phase (PLAN §7). */
export const SYNC_PHASES = ['sync', 'enrich', 'graph'] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];
