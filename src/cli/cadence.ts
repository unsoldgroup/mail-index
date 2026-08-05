/**
 * `mail-index cadence` (deterministic correspondent-frequency read).
 *
 * Answers "how often does <brand / category of sender> email this account, over
 * what span" without ad-hoc SQL or per-query LLM classification — it folds the
 * index by registrable (brand) domain (see `intelligence/cadence.ts`),
 * optionally filtered to one agent-assigned entity `--category` (e.g.
 * `expedition-operator`). Human table on stdout; `--json` for the tray/agent.
 */

import type { Repo } from '../index/repo.js';
import { computeCadence, type CadenceRow } from '../intelligence/index.js';
import { parseSince } from '../mcp/tools.js';

export interface CadenceFlags {
  account: string;
  /** Restrict to senders whose domain carries this entity category. */
  category?: string | undefined;
  /** Relative token (`30d`, `1mo`) or ISO timestamp lower bound. */
  since?: string | undefined;
  limit?: number | undefined;
}

/** Run the cadence read, translating CLI flags into compute options. */
export async function runCadence(
  repo: Repo,
  flags: CadenceFlags,
  now: Date = new Date(),
): Promise<CadenceRow[]> {
  const opts: Parameters<typeof computeCadence>[2] = {};
  if (flags.category != null) opts.category = flags.category;
  if (flags.since != null) opts.sinceMs = parseSince(flags.since, now);
  if (flags.limit != null) opts.limit = flags.limit;
  return computeCadence(repo, flags.account, opts);
}

function isoDay(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/** Format cadence rows as an aligned table (or a one-line empty notice). */
export function formatCadence(rows: CadenceRow[], flags: CadenceFlags): string {
  const scope = flags.category ? ` category=${flags.category}` : '';
  if (rows.length === 0) {
    return `No inbound mail for ${flags.account}${scope}${flags.since ? ` since ${flags.since}` : ''}.\n`;
  }
  const domW = Math.max(6, ...rows.map((r) => r.domain.length));
  const head =
    `${pad('DOMAIN', domW)}  ${padLeft('MSGS', 5)}  ${padLeft('SNDRS', 5)}  ` +
    `${pad('FIRST', 10)}  ${pad('LAST', 10)}  ${padLeft('/MO', 6)}`;
  const lines = rows.map(
    (r) =>
      `${pad(r.domain, domW)}  ${padLeft(String(r.msgs), 5)}  ${padLeft(String(r.senders), 5)}  ` +
      `${pad(isoDay(r.firstMs), 10)}  ${pad(isoDay(r.lastMs), 10)}  ${padLeft(r.perMonth.toFixed(1), 6)}`,
  );
  const total = rows.reduce((n, r) => n + r.msgs, 0);
  return (
    `Inbound cadence — ${flags.account}${scope} (${rows.length} brands, ${total} messages)\n\n` +
    `${head}\n${lines.join('\n')}\n`
  );
}

/** Format cadence rows as JSON for the tray/agent ladder. */
export function formatCadenceJson(rows: CadenceRow[]): string {
  return JSON.stringify({ cadence: rows }, null, 2) + '\n';
}
