/**
 * Correspondent cadence (frequency) — a deterministic answer to "how often does
 * <brand / category of sender> email this account, and over what span".
 *
 * This exists because that question kept being answered ad hoc: hand-written SQL
 * over `messages.from_addr` (fragile host parsing) plus an LLM eyeballing which
 * senders are, say, expedition operators. Both the host normalization (→
 * `intelligence/domain.ts`) and the operator classification (→ the agent's
 * `save_domain_category` write-back, read here as `domains.category`) are now
 * persisted, so cadence is a pure fold over the index: group received mail by
 * registrable (brand) domain, optionally filtered to one entity `category`,
 * counting messages + distinct senders and the first/last timestamps.
 *
 * INDEX-ONLY (PLAN §4): reads derived `domains` + the `messages` projection the
 * aggregation pass already streams; never touches the provider. Reuses the SAME
 * helpers aggregation uses (`extractAddress`, host/registrable derivation) so a
 * sender maps to the same brand key cadence and the contact/domain rollups do.
 */

import type { Repo } from '../index/repo.js';
import { extractAddress } from '../ingest/classify.js';
import { hostOf, registrableDomain } from './domain.js';

export interface CadenceOptions {
  /** Restrict to senders whose domain carries this agent-assigned entity `category`. */
  category?: string;
  /** Only count messages with `internal_date >= sinceMs` (epoch ms). */
  sinceMs?: number;
  /** Cap the number of brand rows returned (newest-volume-first). */
  limit?: number;
}

/** One brand's inbound cadence over the (optionally `since`-bounded) window. */
export interface CadenceRow {
  /** Registrable (eTLD+1) brand domain. */
  domain: string;
  /** Received-message count. */
  msgs: number;
  /** Distinct sender addresses under this brand. */
  senders: number;
  /** First / last received timestamp (epoch ms), or null when undated. */
  firstMs: number | null;
  lastMs: number | null;
  /** Average messages per week / per 30-day month across the active span. */
  perWeek: number;
  perMonth: number;
}

interface Acc {
  msgs: number;
  senders: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Compute inbound cadence per registrable domain for one account. Received mail
 * only (cadence is about who reaches IN to the mailbox). When `category` is set,
 * a sender is included only if its host's `domains.category` equals it.
 */
export async function computeCadence(
  repo: Repo,
  account: string,
  opts: CadenceOptions = {},
): Promise<CadenceRow[]> {
  // host → entity category + durable registrable domain (NULL pre-aggregation).
  const catByHost = new Map<string, string | null>();
  const regByHost = new Map<string, string | null>();
  for (const m of await repo.domainsMeta(account)) {
    catByHost.set(m.domain, m.category);
    regByHost.set(m.domain, m.registrable_domain);
  }

  const acc = new Map<string, Acc>();
  for (const row of await repo.messagesForAggregation(account)) {
    if (row.direction !== 'received' || !row.from_addr) continue;
    const bare = extractAddress(row.from_addr);
    if (!bare) continue;
    const host = hostOf(bare);
    if (!host) continue;
    if (opts.category != null && (catByHost.get(host) ?? null) !== opts.category) continue;

    const ms = row.internal_date ?? null;
    if (opts.sinceMs != null && (ms == null || ms < opts.sinceMs)) continue;

    const brand = regByHost.get(host) ?? registrableDomain(host) ?? host;
    let a = acc.get(brand);
    if (!a) {
      a = { msgs: 0, senders: new Set(), firstMs: null, lastMs: null };
      acc.set(brand, a);
    }
    a.msgs += 1;
    a.senders.add(bare.toLowerCase());
    if (ms != null) {
      if (a.firstMs == null || ms < a.firstMs) a.firstMs = ms;
      if (a.lastMs == null || ms > a.lastMs) a.lastMs = ms;
    }
  }

  const rows: CadenceRow[] = [...acc.entries()].map(([domain, a]) => {
    const spanDays =
      a.firstMs != null && a.lastMs != null ? Math.max(1, (a.lastMs - a.firstMs) / DAY_MS) : 1;
    return {
      domain,
      msgs: a.msgs,
      senders: a.senders.size,
      firstMs: a.firstMs,
      lastMs: a.lastMs,
      perWeek: (a.msgs * 7) / spanDays,
      perMonth: (a.msgs * 30) / spanDays,
    };
  });
  rows.sort((x, y) => y.msgs - x.msgs || x.domain.localeCompare(y.domain));
  return opts.limit != null ? rows.slice(0, opts.limit) : rows;
}
