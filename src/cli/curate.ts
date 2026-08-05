/**
 * `mail-index curate` — the minimal interactive curation wizard (SCOPE 3.3,
 * PLAN §11, D14).
 *
 * This is the FALLBACK curation path for a user with no agent. The PRIMARY path
 * is the agent-mediated MCP loop (M3.4, D14): the index proposes a ranked
 * shortlist, the user's LLM judges it conversationally, and the write-back tool
 * persists the disposition. This CLI wizard walks the SAME shortlist by hand —
 * it reuses `curation.propose()` for the seed and `curation.set()` for the
 * disposition, so the two paths persist identically. It stays deliberately
 * small.
 *
 * Architecture (so the core is testable without a TTY): the wizard logic is a
 * pure async function {@link runCurate} driven by an injected {@link Prompter}
 * — an abstraction over "ask the user a question, get a line back". Production
 * wires a `node:readline` prompter ({@link readlinePrompter}); tests inject a
 * scripted prompter that returns canned answers. The readline glue is the only
 * untested seam, and it is thin.
 *
 * The walk: for each proposed contact then each proposed domain, show its stats
 * + the index's SUGGESTED action and ask for a decision (keep / mute / important
 * / skip / quit). Accept the suggestion on an empty line. After the entities,
 * collect freeform interest keywords. Finally apply everything through
 * `set()` in one atomic transaction (INDEX-ONLY: no provider, no enrichment).
 */

import * as readline from 'node:readline';

import {
  propose,
  set,
  type ContactSelection,
  type DomainSelection,
  type ProposedContact,
  type ProposedDomain,
  type SuggestedAction,
  type SetResult,
} from '../curation/index.js';
import type { Curation, Repo } from '../index/index.js';

/**
 * The wizard's I/O seam. {@link ask} prints a prompt and resolves to the user's
 * (trimmed) line; {@link write} emits a line of context/feedback. Both are
 * async-friendly so a readline implementation and a scripted test double share
 * one shape.
 */
export interface Prompter {
  ask(question: string): Promise<string>;
  write(line: string): void;
}

/**
 * A single keep/mute/important/skip decision parsed from a user's answer.
 * `keep` clears any curation (an explicit "this is fine, uncurate it"); `mute`
 * and `important` set the matching label; `skip` leaves the entity untouched;
 * `quit` aborts the remaining walk (already-made decisions are still applied).
 */
export type Decision = 'keep' | 'mute' | 'important' | 'skip' | 'quit';

/**
 * Parse a user's raw answer into a {@link Decision}, defaulting to the
 * index-suggested action on an empty line (the affordance that makes accepting
 * the shortlist a single keystroke). A `muted` suggestion maps to `mute`, an
 * `important` suggestion to `important`, and `none` to `skip`. Unrecognised
 * input is treated as `skip` so a fat-fingered answer never mis-curates.
 */
export function parseDecision(raw: string, suggested: SuggestedAction): Decision {
  const a = raw.trim().toLowerCase();
  if (a === '') return suggested === 'muted' ? 'mute' : suggested === 'important' ? 'important' : 'skip';
  if (a === 'k' || a === 'keep') return 'keep';
  if (a === 'm' || a === 'mute') return 'mute';
  if (a === 'i' || a === 'important') return 'important';
  if (a === 's' || a === 'skip' || a === '') return 'skip';
  if (a === 'q' || a === 'quit') return 'quit';
  return 'skip';
}

/** Map a non-skip/quit {@link Decision} to the {@link Curation} value `set` persists. */
function decisionToCuration(d: Decision): Curation | null {
  if (d === 'mute') return 'muted';
  if (d === 'important') return 'important';
  return null; // 'keep' clears the label.
}

/** Parse a comma-separated keyword line into a trimmed, de-duped, non-empty list. */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const k = part.trim();
    if (k !== '' && !seen.has(k.toLowerCase())) {
      seen.add(k.toLowerCase());
      out.push(k);
    }
  }
  return out;
}

/** Compact one-line summary of a proposed contact, for the walk prompt. */
function describeContact(c: ProposedContact): string {
  const name = c.displayName ? `${c.displayName} <${c.address}>` : c.address;
  const cur = c.curation ? ` [now: ${c.curation}]` : '';
  return `${name} — ${c.msgsReceived} recv / ${c.msgsSent} sent, replied ${c.repliedCount}, score ${c.engagementScore ?? '—'}${cur}`;
}

/** Compact one-line summary of a proposed domain. */
function describeDomain(d: ProposedDomain): string {
  const cur = d.curation ? ` [now: ${d.curation}]` : '';
  const cat = d.category ? `, ${d.category}` : '';
  return `${d.domain} — ${d.msgs} msgs / ${d.distinctContacts} contacts${cat}, score ${d.engagementScore ?? '—'}${cur}`;
}

/** Options for {@link runCurate} (limits forwarded to `propose`). */
export interface CurateOptions {
  /** Max contacts to walk (token-conscious; forwarded to propose). */
  contactLimit?: number;
  /** Max domains to walk. */
  domainLimit?: number;
  /** `updated_at` stamp for the keywords write (deterministic testing). */
  at?: string;
}

/** What {@link runCurate} resolved to, so the CLI can report concisely. */
export interface CurateResult {
  account: string;
  /** Number of contacts the user dispositioned (keep/mute/important). */
  contactsDecided: number;
  /** Number of domains the user dispositioned. */
  domainsDecided: number;
  /** The keywords the user entered (replaces the stored set when non-null). */
  keywords: string[];
  /** Whether the walk was aborted early via `quit`. */
  quit: boolean;
  /** The underlying `set()` result (what actually persisted). */
  applied: SetResult;
}

const WALK_HELP =
  '  [k]eep (clear)  [m]ute  [i]mportant  [s]kip  [q]uit — Enter accepts the suggestion';

/**
 * Run the wizard against `account`, driven by `prompter`. Walks the proposed
 * contacts then domains, collects keywords, and applies the accumulated
 * disposition via `set()` in one transaction. Returns a {@link CurateResult}.
 * Pure with respect to I/O: every interaction goes through `prompter`, so the
 * decision-application core is fully testable with a scripted prompter.
 */
export async function runCurate(
  repo: Repo,
  account: string,
  prompter: Prompter,
  options: CurateOptions = {},
): Promise<CurateResult> {
  const proposal = await propose(repo, account, {
    ...(options.contactLimit != null ? { contactLimit: options.contactLimit } : {}),
    ...(options.domainLimit != null ? { domainLimit: options.domainLimit } : {}),
  });

  const contacts: ContactSelection[] = [];
  const domains: DomainSelection[] = [];
  let quit = false;

  prompter.write(`Curating ${account}: ${proposal.contacts.length} contacts, ${proposal.domains.length} domains.`);
  prompter.write(WALK_HELP);

  for (const c of proposal.contacts) {
    prompter.write('');
    prompter.write(describeContact(c));
    const answer = await prompter.ask(`  ${c.suggested}? `);
    const decision = parseDecision(answer, c.suggested);
    if (decision === 'quit') {
      quit = true;
      break;
    }
    if (decision === 'skip') continue;
    contacts.push({ address: c.address, curation: decisionToCuration(decision) });
  }

  if (!quit) {
    for (const d of proposal.domains) {
      prompter.write('');
      prompter.write(describeDomain(d));
      const answer = await prompter.ask(`  ${d.suggested}? `);
      const decision = parseDecision(answer, d.suggested);
      if (decision === 'quit') {
        quit = true;
        break;
      }
      if (decision === 'skip') continue;
      domains.push({ domain: d.domain, curation: decisionToCuration(decision) });
    }
  }

  // Keywords come last so a `quit` in the entity walk also skips them.
  let keywords: string[] = [];
  let keywordsTouched = false;
  if (!quit) {
    prompter.write('');
    const raw = await prompter.ask('Interest keywords (comma-separated, blank to leave unchanged): ');
    if (raw.trim() !== '') {
      keywords = parseKeywords(raw);
      keywordsTouched = true;
    }
  }

  const applied = await set(
    repo,
    account,
    {
      contacts,
      domains,
      // Only replace the keyword set when the user actually entered a line;
      // an empty answer (or an early quit) leaves the stored keywords intact.
      ...(keywordsTouched ? { keywords } : {}),
    },
    options.at != null ? { at: options.at } : {},
  );

  return {
    account,
    contactsDecided: contacts.length,
    domainsDecided: domains.length,
    keywords,
    quit,
    applied,
  };
}

/**
 * A `node:readline`-backed {@link Prompter} over stdin/stdout — the production
 * I/O seam. Thin by design: it forwards `ask` to `rl.question` (promisified)
 * and `write` to stdout. The caller owns closing it via {@link close}.
 */
export function readlinePrompter(): Prompter & { close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question: string): Promise<string> {
      return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
    },
    write(line: string): void {
      process.stdout.write(line + '\n');
    },
    close(): void {
      rl.close();
    },
  };
}

/** Render the wizard outcome the CLI prints after applying. */
export function formatCurate(result: CurateResult): string {
  const lines: string[] = [];
  if (result.quit) lines.push('Quit early — applying decisions made so far.');
  lines.push(
    `${result.account}: set ${result.applied.contactsSet} contact(s), ${result.applied.domainsSet} domain(s)` +
      (result.applied.keywordsSet ? `, ${result.keywords.length} keyword(s)` : ''),
  );
  lines.push('The curated profile is now the enrichment policy. Run: mail-index enrich --account ' + result.account + ' --profile');
  return lines.join('\n') + '\n';
}
