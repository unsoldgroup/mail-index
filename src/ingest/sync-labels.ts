/**
 * Label-catalogue refresh (display + write name↔id resolution).
 *
 * Messages carry opaque label *ids* (`Label_123…`); the human name lives only
 * in the provider's labels resource. This pass fetches that small, stable
 * catalogue once per sync (through the adapter spawn seam — zero-egress core)
 * and caches it in the `labels` table, so:
 *   - display can translate id→name (CLI / MCP label arrays), and
 *   - opt-in writes can translate a friendly name→id for the gws REST path.
 *
 * Mirrors reconcile-inbox.ts: a cheap, INDEX-ONLY per-sync refresh. Best-effort
 * — an adapter without {@link MailSource.listLabels}, or a failed fetch, simply
 * leaves the prior catalogue in place (callers fall back to raw ids).
 */

import type { MailSource } from '../source/index.js';
import type { Repo } from '../index/repo.js';

/** Options for {@link syncLabels}. */
export interface SyncLabelsOptions {
  account: string;
  source: MailSource;
  repo: Repo;
}

/**
 * Refresh one account's cached label catalogue from the provider. Returns the
 * number of labels stored, or 0 when the adapter can't list labels. Never wipes
 * a good catalogue on an empty/failed fetch.
 */
export async function syncLabels(options: SyncLabelsOptions): Promise<number> {
  const { account, source, repo } = options;
  if (typeof source.listLabels !== 'function') return 0;

  const labels = await source.listLabels();
  if (labels.length === 0) return 0; // don't clobber a previously-good catalogue
  await repo.setLabels(account, labels);
  return labels.length;
}
