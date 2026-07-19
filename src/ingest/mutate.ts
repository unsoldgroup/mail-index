/**
 * Mutate — the OPT-IN mailbox-write path (archive + label edit).
 *
 * This is the ONE place mail-index writes to the provider mailbox, and it is
 * NEVER reached by sync/enrich. It exists only behind the explicit
 * `mail-index archive`/`label` CLI commands and the `archive_message`/
 * `modify_labels` MCP tools. The default `gmail.readonly` install cannot reach
 * the provider here: `MailSource.modify` is absent on read-only adapters, and a
 * scope-limited grant makes the adapter throw {@link InsufficientScopeError}.
 *
 * Order matters: the provider write happens FIRST; only on its success do we
 * update the local index ({@link Repo.applyLabelChange}) so the index never
 * claims a change the mailbox rejected.
 *
 * Provider-neutral: speaks only the {@link MailSource} contract + the {@link Repo}.
 * See docs/adr/0007-opt-in-mailbox-writes.md.
 */

import type { LabelChange, MailSource } from '../source/index.js';
import type { Repo } from '../index/repo.js';

/** Thrown when the wired adapter does not support writes at all (read-only). */
export class MailboxWriteUnsupportedError extends Error {
  override name = 'MailboxWriteUnsupportedError';
}

/** Inputs for {@link applyLabelChange}. */
export interface MutateInput {
  account: string;
  id: string;
  source: MailSource;
  repo: Repo;
  change: LabelChange;
}

/** Outcome: the resulting label set and whether the local index had the row. */
export interface MutateResult {
  account: string;
  id: string;
  /** Resulting label ids after the change, when the message is in the index. */
  labels: string[] | null;
  /** {@link labels} rendered to human names (opaque ids → names via the cached
   * catalogue; system labels/unknowns pass through). Null when not indexed. */
  labelNames: string[] | null;
  /** False when the provider write succeeded but no local row existed to update. */
  indexed: boolean;
}

/**
 * Apply a label {@link LabelChange} to one message: provider write first, then
 * the local index. Throws {@link MailboxWriteUnsupportedError} if the adapter is
 * read-only, or {@link InsufficientScopeError} (from the adapter) if the grant
 * lacks write scope — both carry actionable guidance for the surface to relay.
 */
export async function applyLabelChange(input: MutateInput): Promise<MutateResult> {
  const { account, id, source, repo, change } = input;

  if (typeof source.modify !== 'function') {
    throw new MailboxWriteUnsupportedError(
      `the "${source.provider}" adapter is read-only — mailbox writes are not supported`,
    );
  }

  // Resolve friendly label NAMES → ids before the provider write. A user may
  // pass "Coverage Review" instead of Label_123…; the gws REST path requires the
  // id (gog accepts either). System labels (INBOX/STARRED), raw ids, and unknown
  // strings have no name entry and pass through unchanged. Both add + remove.
  const nameToId = await repo.labelNameToId(account);
  const add = resolveNames(change.addLabelIds ?? [], nameToId);
  const remove = resolveNames(change.removeLabelIds ?? [], nameToId);

  // Minimal payload — only the non-empty side(s), so archive stays
  // `{ removeLabelIds: ['INBOX'] }`.
  const resolved: LabelChange = {};
  if (add.length > 0) resolved.addLabelIds = add;
  if (remove.length > 0) resolved.removeLabelIds = remove;

  // Provider write FIRST (may throw InsufficientScopeError on a readonly grant).
  await source.modify(id, resolved);

  // Then reflect it locally so search/recall stay consistent before next sync.
  const labels = await repo.applyLabelChange(account, id, { add, remove });
  const labelNames = labels ? await repo.labelNames(account, labels) : null;

  return { account, id, labels, labelNames, indexed: labels !== null };
}

/** Map any label that matches a known name (case-insensitive) to its id; pass
 * system labels, raw ids, and unknown strings through unchanged. */
function resolveNames(labels: readonly string[], nameToId: Map<string, string>): string[] {
  return labels.map((l) => nameToId.get(l.toLowerCase()) ?? l);
}

/** Archive = drop the INBOX label. The one well-known compound. */
export function archiveChange(): LabelChange {
  return { removeLabelIds: ['INBOX'] };
}
