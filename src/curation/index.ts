/**
 * Curation core (SCOPE 3.1, PLAN §11, D13/D14, CONTEXT.md "Interest profile").
 *
 * The curation loop is the v1.0 product thesis made concrete: the index RANKS
 * (the engagement score is a *seed*, D13) and the human DISPOSES. This module is
 * the index-side half of that loop — three pure, INDEX-ONLY operations the agent
 * (or the CLI wizard) drives:
 *
 *  - {@link propose} — the SEED. A ranked shortlist of the top contacts and
 *    domains by `engagement_score`, each carrying its stats and a SUGGESTED
 *    action (`important` | `muted` | `none`) derived from the score. The agent
 *    presents this conversationally and takes fuzzy edits (PLAN §11).
 *  - {@link set} — the DISPOSITION. Persist the user's chosen contact/domain
 *    `curation` labels and freeform interest `keywords` onto the index. Editable
 *    and recoverable: curation lives on the durable `contacts`/`domains` rows and
 *    keywords on `interest_profile` with a bumped `updated_at`.
 *  - {@link get} — read back the current profile (curation selections +
 *    keywords) so the loop is round-trippable.
 *
 * This module touches NO `MailSource` and triggers NO enrichment (D13): it only
 * reads the derived/scored index rows and writes curation back. The curated
 * `interest_profile` is the enrichment POLICY (PLAN §7) consumed downstream by
 * profile-driven enrichment (M3.2) — never here.
 *
 * Shapes are deliberately COMPACT and token-conscious (SCOPE 3.4(b)): the
 * shortlist is a small array of flat records with rounded scores, not full
 * message bodies; `limit` defaults keep it small.
 */

import type {
  CurationContactRow,
  CurationDomainRow,
  Curation,
  Repo,
} from '../index/index.js';

/**
 * Score thresholds that map an `engagement_score` to a SUGGESTED action (D13).
 * The score is unbounded by design but lands in a stable range (≈ −4 … +9, see
 * `interest.ts`); only ordering is load-bearing, so these cutoffs are coarse
 * priors the human overrides:
 *
 *  - score ≥ {@link SUGGEST_IMPORTANT_AT} → suggest `important` (a clear
 *    Correspondent: replied-to / starred / read);
 *  - score ≤ {@link SUGGEST_MUTED_AT} → suggest `muted` (net-negative: bulk /
 *    never-opened);
 *  - in between → suggest `none` (leave it to the human).
 */
export const SUGGEST_IMPORTANT_AT = 2.0;
export const SUGGEST_MUTED_AT = -0.5;

/** A suggested curation action the shortlist proposes (D13). */
export type SuggestedAction = 'important' | 'muted' | 'none';

/**
 * Derive the suggested action from a contact/domain's engagement score (D13).
 * An unscored row (null — never through the interest pass) suggests `none`: the
 * index has no prior, so it defers entirely to the human. A predominantly-bulk
 * contact (`isList`) is nudged toward `muted` regardless of a marginal score.
 */
export function suggestAction(score: number | null, isList = false): SuggestedAction {
  if (score == null) return 'none';
  if (score >= SUGGEST_IMPORTANT_AT) return 'important';
  if (isList || score <= SUGGEST_MUTED_AT) return 'muted';
  return 'none';
}

/** Round a score to 2 decimals (or null), keeping the shortlist compact. */
function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100;
}

/** A contact entry in the {@link propose} shortlist. Compact, flat record. */
export interface ProposedContact {
  address: string;
  displayName: string | null;
  domain: string | null;
  msgsReceived: number;
  msgsSent: number;
  /** Read-rate over received mail in [0, 1], rounded; null when none received. */
  readRate: number | null;
  repliedCount: number;
  starredCount: number;
  importantCount: number;
  isList: boolean;
  lastSeen: string | null;
  engagementScore: number | null;
  /** The current persisted curation (so the agent can show / diff state). */
  curation: Curation | null;
  /** The index's suggested action (D13). */
  suggested: SuggestedAction;
}

/** A domain entry in the {@link propose} shortlist. */
export interface ProposedDomain {
  domain: string;
  msgs: number;
  distinctContacts: number;
  category: string | null;
  engagementScore: number | null;
  curation: Curation | null;
  suggested: SuggestedAction;
}

/** The ranked shortlist {@link propose} returns — the curation SEED (D13). */
export interface CurationProposal {
  account: string;
  contacts: ProposedContact[];
  domains: ProposedDomain[];
}

/** Options for {@link propose}. */
export interface ProposeOptions {
  /** Max contacts in the shortlist (token-conscious; default 20). */
  contactLimit?: number;
  /** Max domains in the shortlist (default 20). */
  domainLimit?: number;
}

function readRate(received: number, read: number): number | null {
  if (received <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, read / received)) * 100) / 100;
}

function toProposedContact(row: CurationContactRow): ProposedContact {
  const isList = row.is_list === 1;
  return {
    address: row.address,
    displayName: row.display_name,
    domain: row.domain,
    msgsReceived: row.msgs_received,
    msgsSent: row.msgs_sent,
    readRate: readRate(row.msgs_received, row.read_count),
    repliedCount: row.replied_count,
    starredCount: row.starred_count,
    importantCount: row.important_count,
    isList,
    lastSeen: row.last_seen,
    engagementScore: round2(row.engagement_score),
    curation: row.curation,
    suggested: suggestAction(row.engagement_score, isList),
  };
}

function toProposedDomain(row: CurationDomainRow): ProposedDomain {
  return {
    domain: row.domain,
    msgs: row.msgs,
    distinctContacts: row.distinct_contacts,
    category: row.category,
    engagementScore: round2(row.engagement_score),
    curation: row.curation,
    suggested: suggestAction(row.engagement_score),
  };
}

/**
 * Build the curation shortlist for an account: the top contacts and domains by
 * engagement score, each with a suggested action (D13, PLAN §11). This is the
 * SEED the agent presents — pure, INDEX-ONLY, no provider contact, no
 * enrichment. Empty arrays when the account has no aggregated rows yet.
 */
export async function propose(
  repo: Repo,
  account: string,
  options: ProposeOptions = {},
): Promise<CurationProposal> {
  const contacts = (await repo.curationContacts(account, options.contactLimit ?? 20)).map(
    toProposedContact,
  );
  const domains = (await repo.curationDomains(account, options.domainLimit ?? 20)).map(
    toProposedDomain,
  );
  return { account, contacts, domains };
}

/**
 * A curation selection the user dispositions back (D14). `curation` of `null`
 * CLEARS any existing label (an explicit "uncurate"); a `Curation` value sets
 * it. The agent sends only the rows the user actually touched — unmentioned
 * contacts/domains keep their prior state.
 */
export interface CurationSelection {
  curation: Curation | null;
}

/** A contact selection: the address plus its disposition. */
export interface ContactSelection extends CurationSelection {
  address: string;
}

/** A domain selection: the domain plus its disposition. */
export interface DomainSelection extends CurationSelection {
  domain: string;
}

/**
 * The disposition {@link set} persists: contact + domain curation labels and the
 * freeform interest keywords. Every field is optional so a caller can persist
 * just keywords, just contacts, or any mix. When `keywords` is provided it
 * REPLACES the stored set (the agent sends the full intended list); omitting it
 * leaves keywords untouched.
 */
export interface CurationSelections {
  contacts?: readonly ContactSelection[];
  domains?: readonly DomainSelection[];
  /** Freeform interest keywords; REPLACES the stored set when provided. */
  keywords?: readonly string[];
}

/** Options for {@link set} (mostly for deterministic testing). */
export interface SetOptions {
  /** `updated_at` stamp for the keywords write. Defaults to the wall clock. */
  at?: string;
}

/** What {@link set} actually changed, so callers can report concisely. */
export interface SetResult {
  account: string;
  /** Contact rows whose curation was updated (a missing contact is skipped). */
  contactsSet: number;
  /** Domain selections persisted (each upserts, so always counted). */
  domainsSet: number;
  /** Whether the keyword set was written this call. */
  keywordsSet: boolean;
  /** The `updated_at` stamp when keywords were written, else the prior stamp. */
  updatedAt: string | null;
}

/**
 * Persist the user's curation disposition (D14, PLAN §11): set contact/domain
 * `curation` labels and replace the freeform interest `keywords`, all in one
 * transaction so a disposition is atomic. Editable + recoverable: curation lives
 * on the durable contact/domain rows; keywords on `interest_profile` with a
 * bumped `updated_at`. Idempotent — re-applying the same selections yields the
 * same state (a fresh `updated_at` only when keywords are written).
 *
 * INDEX-ONLY: no provider contact, no enrichment (D13). The curated profile is
 * the enrichment policy (PLAN §7) consumed downstream, not here.
 */
export async function set(
  repo: Repo,
  account: string,
  selections: CurationSelections,
  options: SetOptions = {},
): Promise<SetResult> {
  return await repo.transaction(async () => {
    let contactsSet = 0;
    for (const sel of selections.contacts ?? []) {
      if (await repo.setContactCuration(account, sel.address, sel.curation)) contactsSet += 1;
    }

    let domainsSet = 0;
    for (const sel of selections.domains ?? []) {
      await repo.setDomainCuration(account, sel.domain, sel.curation);
      domainsSet += 1;
    }

    let keywordsSet = false;
    let updatedAt = (await repo.getInterestProfile(account)).updated_at;
    if (selections.keywords != null) {
      updatedAt = await repo.setInterestKeywords(account, selections.keywords, options.at);
      keywordsSet = true;
    }

    return { account, contactsSet, domainsSet, keywordsSet, updatedAt };
  });
}

/** The current curation state {@link get} returns. */
export interface CurationProfile {
  account: string;
  /** Contacts that carry a curation label (address + label). */
  contacts: { address: string; curation: Curation }[];
  /** Domains that carry a curation label (domain + label). */
  domains: { domain: string; curation: Curation }[];
  /** The freeform interest keywords. */
  keywords: string[];
  /** When the keyword set was last written (ISO), or null. */
  updatedAt: string | null;
}

/**
 * Read back the account's current curation profile (PLAN §11): the curated
 * contacts/domains and the freeform keywords. Round-trips {@link set} — the loop
 * is editable and inspectable. INDEX-ONLY.
 */
export async function get(repo: Repo, account: string): Promise<CurationProfile> {
  const profile = await repo.getInterestProfile(account);
  // Map the snake_case null-prototype SQLite rows to plain objects so callers
  // (and structural equality) see ordinary records.
  return {
    account,
    contacts: (await repo.curatedContacts(account)).map((r) => ({
      address: r.address,
      curation: r.curation,
    })),
    domains: (await repo.curatedDomains(account)).map((r) => ({
      domain: r.domain,
      curation: r.curation,
    })),
    keywords: profile.keywords,
    updatedAt: profile.updated_at,
  };
}
