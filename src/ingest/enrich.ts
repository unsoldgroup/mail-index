/**
 * Enrich — phase 2 of progressive sync (SCOPE 1.1, PLAN §7 phase 2,
 * CONTEXT.md "Enrichment", ADR-0003).
 *
 * Phase 1 (`ingest/sync.ts`) sweeps metadata for every Message in scope and
 * leaves them at `body_state='meta'`. Enrich is the selective second pass: it
 * promotes a chosen subset of `meta` rows to `full` by fetching the provider
 * body, DISTILLING it (`ingest/distill.ts` — raw provider bytes are never
 * persisted), and upserting at `body_state='full'` with `body_text` set. The
 * repo (`index/repo.ts`) re-indexes FTS with the distilled body and enforces
 * the no-downgrade invariant; this module never touches the FTS table directly.
 *
 * Properties this guarantees:
 *  - **Selective** — only rows matching the {@link EnrichSelector} are promoted
 *    (PLAN §7: curated profile → `--rule direct` → on-demand). M1.1 ships the
 *    deterministic selectors: `rule`, `sender`, `match`, `limit`.
 *  - **Incremental + idempotent** — only `meta` rows are candidates (the repo's
 *    `selectMetaMessages` filters out `full`/`summary-only`), so a re-run
 *    promotes only what is still un-enriched and never re-fetches a full body.
 *  - **Audited** — writes a `sync_runs` row with `phase='enrich'` and the
 *    selector summary, mirroring phase 1.
 *
 * Provider-neutral: speaks only the {@link MailSource} contract and the
 * {@link Repo}. The CLI wires a concrete adapter; tests wire the fake.
 */

import type { MailSource } from '../source/index.js';
import type { MetaSelector, Repo } from '../index/repo.js';
import { IndexError } from '../index/db.js';
import { distill } from './distill.js';
import { selectOcrCandidates } from '../intelligence/images.js';

/** Error thrown when an enrich run cannot start or run. */
export class EnrichError extends Error {
  override name = 'EnrichError';
}

/**
 * Which `meta` rows to promote. Mirrors the CLI surface (PLAN §13):
 * `--rule direct|all`, `--sender <addr>`, `--match <fts>`, `--limit N`. Fields
 * combine with AND. An empty selector defaults to `rule: 'direct'` — the
 * pre-curation heuristic (PLAN §7).
 */
export interface EnrichSelector {
  rule?: 'direct' | 'all';
  sender?: string;
  match?: string;
  limit?: number;
  /**
   * Profile-driven enrichment (M3.2, PLAN §7 priority-1 policy, D14): resolve
   * the candidate set from the curated `interest_profile` instead of the
   * heuristic — curated-`important` contacts/domains → always; `muted`/`blocked`
   * → never; interest-keyword FTS matches → yes. When set, `rule`/`sender`/
   * `match` are ignored (the profile IS the policy); only `limit` still caps the
   * resolved set. The selector resolution lives in
   * `repo.selectProfileMetaMessages`.
   */
  profile?: boolean;
}

/** Options for {@link enrich}. */
export interface EnrichOptions {
  /** The account label whose meta rows to promote. */
  account: string;
  /** The provider adapter to fetch full bodies from. */
  source: MailSource;
  /** The repo to read candidates from and persist into. */
  repo: Repo;
  /** Which meta rows to promote. Defaults to `{ rule: 'direct' }`. */
  selector?: EnrichSelector;
}

/** Outcome of a completed (or failed-then-recorded) enrich run. */
export interface EnrichResult {
  /** The `sync_runs.id` of the audit row written for this run. */
  runId: number;
  /** The account this run enriched. */
  account: string;
  /** Number of full records fetched from the source. */
  fetched: number;
  /** Number of Messages promoted to `full` in the index. */
  enriched: number;
  /** The selector recorded for the run. */
  selector: string | null;
}

/**
 * Render an {@link EnrichSelector} into the compact `sync_runs.selector` string.
 * Stable key order; omits empty fields. Defaults the rule so the audit row
 * records what actually ran.
 */
function describeSelector(selector: EnrichSelector): string {
  const parts: string[] = [];
  if (selector.profile) parts.push('profile');
  if (selector.rule) parts.push(`rule=${selector.rule}`);
  if (selector.sender) parts.push(`sender=${selector.sender}`);
  if (selector.match) parts.push(`match=${selector.match}`);
  if (selector.limit != null) parts.push(`limit=${selector.limit}`);
  return parts.join(' ');
}

/**
 * Promote one already-known id to `full`: fetch its full record, distil the
 * body, and upsert at `body_state='full'` with the distilled `body_text`. The
 * single shared step both the bulk {@link enrich} loop and the O(1) inline
 * {@link enrichOne} drive, so the fetch→distil→upsert path (and its metadata
 * preservation) lives in exactly one place.
 *
 * Returns `true` when the row was promoted, `false` when the provider can no
 * longer return the id (`getFull` → null) and the meta row was left as-is. The
 * repo's no-downgrade invariant + FTS lockstep are enforced by `upsertMessage`;
 * an id already at `full`/`summary-only` is harmlessly refreshed/held by it.
 */
async function promoteOne(account: string, id: string, source: MailSource, repo: Repo): Promise<boolean> {
  const full = await source.getFull(id);
  if (!full) return false; // gone from the provider — leave the meta row as-is.

  const bodyText = distill({
    bodyText: full.bodyText,
    bodyHtml: full.bodyHtml,
    mimeType: full.mimeType,
  });

  // Deterministically pick which images plausibly carry readable content (the
  // offer may live in a hero graphic, not text). mail-index never OCRs — it
  // stores the candidate URLs so the local agent can read them. Pure + local
  // (no network); stored only when the HTML yields content-bearing images.
  const ocrCandidates = full.bodyHtml ? selectOcrCandidates(full.bodyHtml) : [];
  const ocrImagesJson = ocrCandidates.length > 0 ? JSON.stringify(ocrCandidates) : null;

  // Promote to full. The repo's upsert overwrites every metadata column from
  // the input (ON CONFLICT DO UPDATE SET …), so we re-supply the full metadata
  // the provider just returned rather than a sparse {id, bodyText} — otherwise
  // the existing subject/sender/labels/etc. would be nulled out. Classification
  // fields (category/is_list/direction) and snapshot flags are already correct
  // on the row from phase 1, so we carry the existing row's values forward to
  // stay provider-neutral and avoid re-running classification here.
  const existing = await repo.getMessage(account, id);
  await repo.upsertMessage({
    account,
    gmailMessageId: id,
    threadId: full.threadId,
    internalDate: full.internalDate,
    dateHeader: full.dateHeader,
    fromAddr: full.from,
    toAddr: full.to,
    ccAddr: full.cc,
    subject: full.subject,
    labels: full.labels,
    category: existing?.category ?? null,
    isList: existing ? existing.is_list === 1 : false,
    direction: existing?.direction ?? 'received',
    unread: existing ? existing.unread === 1 : false,
    starred: existing ? existing.starred === 1 : false,
    important: existing ? existing.important === 1 : false,
    sizeEstimate: full.sizeEstimate,
    snippet: full.snippet,
    bodyState: 'full',
    bodyText,
    ocrImagesJson,
  });
  return true;
}

/** Options for {@link enrichOne}. */
export interface EnrichOneOptions {
  /** The account label the message belongs to. */
  account: string;
  /** The id of the message to promote. */
  id: string;
  /** The provider adapter to fetch the full body from. */
  source: MailSource;
  /** The repo to read the existing row from and persist into. */
  repo: Repo;
}

/**
 * Lazily enrich a SINGLE message in place (SCOPE 1.2, ADR-0001 — the O(1)
 * inline pattern). One bounded `getFull` → distil → upsert; no `sync_runs` row
 * and no account lock, because a single bounded fetch is the very operation
 * ADR-0001 permits inline ("answering what did that email say? mid-conversation
 * is the product promise"). Used by `show <ref>` to auto-enrich a `meta` row
 * before printing, and per-hit by `search --enrich`.
 *
 * Idempotent and no-downgrade-safe: an id already at `full`/`summary-only` is
 * left at its higher state by the repo, and a missing id is skipped. Returns
 * whether a fetch + promotion actually occurred.
 */
export async function enrichOne(options: EnrichOneOptions): Promise<boolean> {
  const { account, id, source, repo } = options;
  if (!account || account.trim() === '') {
    throw new EnrichError('enrichOne requires a non-empty account label');
  }
  if (!id || id.trim() === '') {
    throw new EnrichError('enrichOne requires a non-empty message id');
  }
  const existing = await repo.getMessage(account, id);
  // Already past meta — nothing to fetch (no-downgrade means a re-promotion
  // would be a no-op anyway). Keep it O(0) in the common already-enriched case.
  if (existing && existing.body_state !== 'meta') return false;
  try {
    return await promoteOne(account, id, source, repo);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EnrichError || err instanceof IndexError) throw err;
    throw new EnrichError(`enrich failed for ${account}:${id}: ${message}`);
  }
}

/**
 * Acquire the per-account lock by opening an `enrich` `sync_runs` row, refusing
 * if another run for the account is already in flight (ADR-0005), exactly like
 * phase-1 sync. Returns the new run's id.
 */
async function acquireLock(repo: Repo, account: string, selector: string): Promise<number> {
  return await repo.transaction(async () => {
    const held = await repo.activeSyncRun(account);
    if (held != null) {
      throw new EnrichError(
        `a sync/enrich for account "${account}" is already in progress (sync_runs id ${held}); refusing to start a second concurrent run`,
      );
    }
    return await repo.startSyncRun({ account, phase: 'enrich', selector });
  });
}

/**
 * Promote `meta` Messages matching `selector` to `full` for one account.
 *
 * Steps: resolve the selector to a default of `rule: 'direct'`, acquire the
 * lock, select the candidate meta ids, then for each: fetch the full record,
 * distil its body, and upsert at `body_state='full'` with the distilled
 * `body_text`. Finally close the audit row with counts. On any failure the
 * audit row is still closed (with `error`) and the lock released, then the
 * error rethrown.
 *
 * Candidates are resolved once up front (a snapshot of the meta rows), so a
 * mid-run upsert never reshapes the working set. Ids the provider can no longer
 * return (`getFull` → null) are skipped (counted as neither fetched nor
 * enriched) rather than failing the run.
 */
export async function enrich(options: EnrichOptions): Promise<EnrichResult> {
  const { account, source, repo } = options;
  if (!account || account.trim() === '') {
    throw new EnrichError('enrich requires a non-empty account label');
  }

  // Resolve the selector. Three modes, in precedence order:
  //  - `profile` — the curated interest_profile IS the policy (M3.2, §7
  //    priority 1). It ignores rule/sender/match entirely (only `limit` still
  //    applies) so the profile alone decides the candidate set.
  //  - explicit `--sender`/`--match` — the user asked for exactly those rows, so
  //    the `direct` heuristic must NOT also filter them out.
  //  - otherwise — `--rule direct` is the pre-curation DEFAULT.
  const provided = options.selector ?? {};
  let selector: EnrichSelector;
  if (provided.profile) {
    selector = { profile: true, ...(provided.limit != null ? { limit: provided.limit } : {}) };
  } else {
    const hasNarrowing = provided.sender != null || provided.match != null;
    selector =
      provided.rule != null || !hasNarrowing ? { rule: 'direct', ...provided } : { ...provided };
  }
  const selectorStr = describeSelector(selector);

  const runId = await acquireLock(repo, account, selectorStr);

  let fetched = 0;
  let enriched = 0;
  try {
    // Profile mode resolves candidates from the curated interest_profile; every
    // other mode resolves them from the deterministic MetaSelector.
    let ids: string[];
    if (selector.profile) {
      ids = await repo.selectProfileMetaMessages(account, selector.limit);
    } else {
      const candidate: MetaSelector = {
        ...(selector.rule ? { rule: selector.rule } : {}),
        ...(selector.sender ? { sender: selector.sender } : {}),
        ...(selector.match ? { match: selector.match } : {}),
        ...(selector.limit != null ? { limit: selector.limit } : {}),
      };
      ids = await repo.selectMetaMessages(account, candidate);
    }

    for (const id of ids) {
      const promoted = await promoteOne(account, id, source, repo);
      if (!promoted) continue; // gone from the provider — leave the meta row as-is.
      fetched += 1;
      enriched += 1;
    }

    await repo.finishSyncRun(runId, { fetched, indexed: enriched });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await repo.finishSyncRun(runId, { fetched, indexed: enriched, error: message });
    } catch {
      // Nothing more to do if even closing the row fails; surface the original.
    }
    if (err instanceof EnrichError || err instanceof IndexError) throw err;
    throw new EnrichError(`enrich failed for account "${account}": ${message}`);
  }

  return { runId, account, fetched, enriched, selector: selectorStr };
}
