/**
 * `mail-index graph build` (SCOPE 2.3, PLAN §9, §13, D8/D9/D10).
 *
 * Runs the lazy, derived graph engine over the index for one account (or every
 * configured account): co-recipiency edges over non-list threads → PageRank
 * centrality + Louvain communities, persisted back onto `contacts`. INDEX-ONLY
 * (PLAN §4) — it never builds a `MailSource`, so unlike `sync`/`enrich` it needs
 * only the account *labels* from the operator config, not the adapter bindings.
 *
 * `graph build` is a separate, explicit step (D10): it is heavy relative to an
 * incremental sweep, so sync auto-runs it only after a full/initial sync, never
 * on every incremental sync. This CLI command is the manual entry point.
 */

import type { OperatorConfig } from '../config/index.js';
import type { Repo } from '../index/repo.js';
import { buildGraph, type GraphBuildResult } from '../graph/index.js';

/** Build the graph for a single account label. */
export async function runGraphBuildOne(repo: Repo, account: string): Promise<GraphBuildResult> {
  return buildGraph(repo, account);
}

/**
 * Build the graph for every configured account (each independent; the derived
 * tables are per-account). Returns one result per account, in config order.
 */
export async function runGraphBuildAll(
  config: OperatorConfig,
  repo: Repo,
): Promise<GraphBuildResult[]> {
  return Promise.all(Object.keys(config.accounts).map((label) => buildGraph(repo, label)));
}

/** Format a completed graph build as the one-line CLI summary. */
export function formatGraphResult(result: GraphBuildResult): string {
  return `${result.account}: ${result.nodes} contacts, ${result.edges} co-recipiency edges, ${result.communities} communities`;
}
