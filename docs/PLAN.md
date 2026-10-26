# mail-index — Architecture & Data Model

> A local, agent-queryable mail intelligence layer. It indexes a user's mailbox
> progressively (metadata first, bodies on demand), builds a graph of who and
> what they correspond with, infers interest from engagement signals, lets the
> user curate who/what matters, and exposes the whole thing to AI agents
> (Claude, Codex, any MCP client) through a local MCP server.

Status: **v1.0, shipped.** This document describes the architecture, data model,
and the key design decisions (ADR digest). It's a reference for contributors; the
decisions themselves live as ADRs in [`adr/`](adr/).

---

## 1. The problem

AI agents have no memory of a user's mailbox. Gmail's own search is weak, and
handing an agent raw IMAP/API access is both a privacy hazard and useless at
scale — you can't put 200k messages in a context window.

Existing Gmail/Google MCPs don't fix this, because they are **query-based and
exact**: the agent must already know precisely what it's looking for
(`from:x subject:y after:z`), every call is a slow remote round-trip, and a
miss returns nothing — no ranking, no neighbors, no structure to orient by.
They answer "fetch me this exact thing" but fail at how people actually ask:
*"what did we agree about the deposit?"*, *"who was that contact from last
spring?"* **Query-based MCPs answer exact queries; an agent needs to answer
vague questions.**

What an agent actually needs is a **local, queryable index** that supports
*recall*, not just lookup:

- who this person hears from, and who they actually *engage* with;
- what threads and topics matter to them;
- the full text of the messages worth reading, and only those;
- fuzzy, ranked, instant search — so a half-remembered detail still finds the
  message, and exploring three angles on a vague question costs nothing.

`mail-index` is that layer. It is **local-first** (the index never leaves the
machine), **progressive** (cheap metadata for everything, expensive bodies only
where they earn their place), and **agent-native** (the primary interface is an
MCP server, so the agent *is* the UI).

---

## 2. Two audiences — the boundary that shapes everything

This is the single most important framing in the project. There are two distinct
things, and they must never bleed into each other:

### 2a. The distributable tool (this repo)
Generic product. Source adapters, schema, graph + interest engines, MCP/CLI
surfaces, and install docs that work for **anyone**. It contains **none** of any
particular user's data: no real email addresses, no GCP project IDs, no OAuth
clients, no curated interest profiles, no send-as aliases, no scheduled
routines. All examples use placeholders (`you@example.com`, `acct-a`).

### 2b. An operator's instance (private, per-user)
The configuration an individual stands up *on top of* the tool: which mail
accounts, which OAuth app / credentials, the account wrappers, the curated
interest profile, and any agent instructions or scheduled routines. **This lives
in the operator's own private dotfiles and data directory — never in this
repo.**

| Concern | Distributable tool (repo) | Operator instance (private) |
|---|---|---|
| Code, schema, adapters, MCP/CLI | ✅ | — |
| Install & onboarding docs (placeholders) | ✅ | — |
| Real account addresses / aliases | ❌ | ✅ `~/.config/...` |
| OAuth client / GCP project | ❌ | ✅ provider console + local creds |
| The SQLite index (`mail.sqlite`) | ❌ (gitignored) | ✅ `~/.local/share/mail-index/` |
| Curated `interest_profile` | ❌ | ✅ in the local DB |
| Agent instructions / routines | ❌ | ✅ operator's `CLAUDE.md` / agent config |

**Design rule:** every feature is built for 2a. If something only makes sense
for one operator, it is configuration, and it belongs in 2b. The reference
operator instance (the maintainer's own 3-account setup) is documented privately
and used only as a real-world test of the generic tool.

---

## 3. Goals & non-goals

### Goals
1. **Repeatable install** for any user on macOS/Linux with Node 24+.
2. **Progressive sync** — metadata for the whole mailbox cheaply; bodies fetched
   selectively, driven by an interest policy.
3. **Correspondence graph** — contacts, domains, threads, with centrality and
   community structure over *human* (non-bulk) mail.
4. **Interest inference** — an engagement score per contact from read/reply/star/
   importance signals, used as a *seed* for human curation.
5. **Curation** — the user (via their agent, or a CLI fallback) confirms who and
   what matters; that curated profile becomes the enrichment policy.
6. **Agent-native access** — a local MCP server exposing search/graph/contact/
   curation tools, addable to Claude or Codex.
7. **Ship as OSS** — own repo, license, docs, clean onboarding.

### Non-goals (v1)
- Not an email client; never sends or deletes mail. Mutation is limited to the
  opt-in archive + label-edit writers (ADR-0007), off by default.
- No server, no cloud, no account — strictly local.
- No embeddings/topic clustering (deferred).
- No cross-person identity resolution in v1 (deferred).
- Not provider-locked; two Gmail adapters ship — `gog` (recommended) and `gws`.

---

## 4. Architecture

Layered, with hard boundaries so each layer is independently testable and
replaceable:

```
┌──────────────────────────────────────────────────────────────┐
│  Agent surface                                                 │
│   • MCP server (primary)        • CLI (ops + fallback wizard)  │
├──────────────────────────────────────────────────────────────┤
│  Intelligence                                                  │
│   • Graph engine (Graphology, derived)                         │
│   • Interest engine (scoring + snapshots)                      │
│   • Curation (interest_profile → enrichment policy)            │
├──────────────────────────────────────────────────────────────┤
│  Index (source of truth)                                       │
│   • SQLite + FTS5  (messages, contacts, domains, threads, …)   │
├──────────────────────────────────────────────────────────────┤
│  Ingest                                                        │
│   • Progressive sync (metadata → selective body enrichment)    │
│   • Classification (category, is_list, direction)              │
├──────────────────────────────────────────────────────────────┤
│  MailSource adapter interface                                  │
│   • GogAdapter (v1)  • GwsAdapter (v1)  • ImapAdapter (v1.x) │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. The MCP/CLI surfaces never touch a mail
provider directly — they go through the index and engines. The engines never
touch a provider — they read the index. Only the ingest layer talks to the
`MailSource` adapter.

---

## 5. Key decisions (ADR digest)

Resolved during design review. Each is a one-line decision + the reasoning.

| # | Decision | Why |
|---|---|---|
| D1 | **`MailSource` adapter interface; two Gmail adapters ship (`gog` recommended, `gws`).** | Keeps the OAuth setup tax (GCP project, consent screen) a *swappable* concern; both adapters share the Gmail-REST mapping. `listIds/getMetadata/getFull` already exist implicitly in the prototype. |
| D2 | **TypeScript + `node:sqlite` (built-in) + npm/npx.** | Kills both the `/usr/bin/sqlite3` path dependency and the `better-sqlite3` native-compile friction. `npx mail-index` works on any Node 24+ machine. |
| D3 | **Two bins** — `mail-index` (CLI) and `mail-index-mcp` (server) on `@modelcontextprotocol/sdk`. | Clean separation of ops vs agent surface. |
| D4 | **Single-binary distribution (Bun `--compile` / Node SEA) is a v1.x goal, not v1.** | Solves "no runtime to manage" without leaving TS. Real desire behind "use Rust" was distribution, not speed. |
| D5 | **Rust deferred** to a possible port of the *settled* core once a bottleneck is measured. | The bottleneck is Gmail network I/O (≈99% of wall-clock), not local CPU. Rust optimizes the 1%. Iterating a churning schema in Rust is misery. |
| D6 | **Graph = Contact + Domain + Thread as materialized tables for v1.** | 90% of agent value via SQL `GROUP BY`, ~zero algorithmic complexity. |
| D7 | **Person-unification and Topic deferred to v1.1.** | Identity resolution and embeddings are each their own subsystem. A nullable `person_id` and an `interest keywords` stand-in keep the doors open. |
| D8 | **Graphology as a lazy, derived analysis layer; SQLite stays source of truth.** | Pure-JS (fits D2), MIT, full algorithm suite. Persist `centrality`/`community_id` back to `contacts`. Core index never depends on it. |
| D9 | **Graph edges = co-recipiency on `is_list=0` threads only.** | Excludes bulk-mail cliques that would poison community detection. Reuses classification. |
| D10 | **`graph build` is a separate step**, auto-run only on full/initial sync. | Heavy; don't run on every incremental sync. |
| D11 | **Index Sent mail (metadata) too.** | Unlocks the two strongest interest signals: *replied* and *user-initiated*. Cheap (metadata-only). |
| D12 | **`engagement_score` from current-state aggregates each sync + append-only snapshots from day one.** | Gmail exposes only current `UNREAD`, never a read timestamp; we engineer the temporal axis ourselves. Snapshots make trend a v1.1 *query*, not a migration. |
| D13 | **The score is a *seed for human curation*, not an autonomous fetch trigger.** | Machine ranks, human disposes. The curated profile is the source of truth that opens the body-fetch floodgate. |
| D14 | **Curation is agent-mediated (primary) + a minimal CLI wizard (fallback); MCP elicitation deferred.** | The agent is the UI — exactly the product thesis. Elicitation client-support is too immature to depend on in v1. |
| D15 | **Local-first, read-only on the mailbox by default, no network beyond the provider API.** | Privacy posture. The tool never sends or deletes mail; archive + label edits (ADR-0007) and remote drafts (ADR-0011) are opt-in only. Their scopes can send, so no-send is enforced in code and by `test/drafts.test.ts`. |

---

## 6. Data model

SQLite, single file at `${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`.
One DB per machine; accounts are namespaced by an `account` column (see §15).

```
messages
  account TEXT, gmail_message_id TEXT          -- PK (account, gmail_message_id)
  thread_id TEXT, internal_date INTEGER, date_header TEXT
  from_addr, to_addr, cc_addr, subject TEXT
  labels_json TEXT
  category TEXT            -- promotions|social|updates|forums|personal|primary|null
  is_list INTEGER          -- List-Id / List-Unsubscribe present
  direction TEXT           -- 'received' | 'sent'
  unread INTEGER           -- snapshot of UNREAD label
  starred INTEGER, important INTEGER
  size_estimate INTEGER
  snippet TEXT
  body_state TEXT          -- 'meta' | 'full'
  body_text TEXT           -- NULL until enriched
  gmail_url TEXT
  indexed_at TEXT, body_fetched_at TEXT

messages_fts (FTS5)        -- subject, sender, recipients, body
                           -- body = snippet (meta) → snippet+body_text (full)

contacts
  account, address TEXT     -- PK (account, address)
  display_name TEXT
  domain TEXT
  person_id INTEGER         -- nullable; v1.1 identity resolution
  msgs_received, msgs_sent INTEGER
  read_count, replied_count, initiated_count, starred_count, important_count INT
  first_seen, last_seen TEXT
  engagement_score REAL     -- derived (interest engine)
  centrality REAL, community_id INTEGER   -- derived (graph engine)
  curation TEXT             -- null | 'important' | 'muted' | 'blocked'

domains
  account, domain TEXT      -- PK; rollup of contacts
  msgs, distinct_contacts INTEGER, engagement_score REAL
  curation TEXT
  category TEXT             -- agent-assigned entity category (write-back loop)
  category_note TEXT, categorized_at TEXT

threads
  account, thread_id TEXT   -- PK
  subject, participants_json TEXT
  msg_count, unread_count INTEGER
  user_participated INTEGER -- did the user send into this thread
  first_at, last_at TEXT

interest_profile             -- the curated policy (one logical profile/account)
  account TEXT
  keywords_json TEXT         -- freeform interest terms
  updated_at TEXT
  -- contact/domain selections live on contacts.curation / domains.curation

contact_stats_snapshot       -- append-only; enables trend (v1.1)
  account, address, taken_at TEXT
  msgs_received, read_count, replied_count, engagement_score REAL

sync_runs                    -- audit
  id, account, phase, selector, started_at, finished_at,
  fetched, indexed, error
```

---

## 7. Ingest — progressive two-phase sync

**Phase 1 — `sync` (metadata).** For every message in scope, one
`messages.get` with `format=metadata` (all headers, no body). Stores headers +
snippet + labels, classifies (§8), sets `body_state='meta'`. FTS indexes
subject/sender/recipients/snippet. Cost ≈ **~2 KB/msg**; a full mailbox of tens
of thousands of messages is single-digit-to-low-tens-of-MB and finishes in
minutes. Snapshot `unread/starred/important` here.

**Phase 2 — `enrich` (selective body).** Promotes `body_state='meta'` rows
matching a policy to a `format=full` fetch, extracts plain text (falls back to
stripped HTML), re-indexes FTS with the body, sets `body_state='full'`. Policy
sources, in priority order:
1. the curated `interest_profile` (important contacts/domains → always; muted →
   never; keyword matches → yes);
2. `--rule direct` heuristic (`is_list=0 AND category NOT IN (promotions,social)`)
   as the pre-curation default;
3. **lazy / on-demand**: `show <ref>` auto-enriches a single message; `search
   --enrich` enriches the hits it returns.

Both phases are incremental and idempotent (upsert by `(account, message_id)`;
never overwrite a `full` body with `meta`).

---

## 8. Classification

Per message, from labels + headers (no body needed):
- **`category`** — from Gmail `CATEGORY_*` labels → `promotions|social|updates|
  forums|personal`, else `primary` if in inbox.
- **`is_list`** — presence of `List-Id` or `List-Unsubscribe`. (Note: must use
  plain `format=metadata`; restricting via `metadataHeaders` is unreliable
  through gws and silently drops headers.)
- **`direction`** — `sent` if the message carries the `SENT` label / is from a
  known account address, else `received`.

These three fields drive the graph (D9), the interest model (§10), and the
enrichment policy (§7).

---

## 9. Graph layer

A **lazy, derived** layer (D8). `mail-index graph build`:
1. loads contacts and **edges = co-recipiency over `is_list=0` threads** (D9)
   into an in-memory Graphology graph;
2. runs **eigenvector/PageRank centrality** (→ "who is central to your
   correspondence") and **Louvain community detection** (→ social circles);
3. persists `centrality` and `community_id` back onto `contacts`.

The index never depends on this step; skipping it leaves search/sync fully
functional. Auto-triggered only after a full/initial sync (D10).

---

## 10. Interest model

Per-contact `engagement_score`, a weighted blend computed from **current-state
aggregates each sync** (D12):

| Signal | Source | Weight |
|---|---|---|
| replied | user sent into the contact's thread (needs Sent index, D11) | strong + |
| initiated | user started the thread | strong + |
| starred | `STARRED` label | + |
| important | `IMPORTANT` label | medium + |
| read-rate | 1 − (unread / received) | medium + |
| recency × volume | last_seen, msgs_received | small + |
| is_list / promotions / social | classification | − |
| never-opened | all received unread | − |

Each sync also writes a `contact_stats_snapshot` row (cheap), so **trend**
(rising/falling engagement) becomes a v1.1 *query* with no migration. The score
is a **prior** whose only job is to seed curation (D13).

---

## 11. Curation

**Agent-mediated (primary, D14).** MCP tools let the agent run the loop:
`interest.propose()` returns the ranked shortlist (top contacts/domains by score,
with stats and a suggested action); the agent presents it conversationally and
takes fuzzy edits ("keep the travel partners, mute the forum digests, I care
about Antarctica logistics"); the agent calls `interest.set(...)` to persist
contact/domain `curation` values + freeform `keywords`.

**CLI wizard (fallback).** `mail-index curate` runs a minimal interactive prompt
for users with no agent, so the tool is not useless without an MCP client.

**The curated `interest_profile` is the enrichment policy** (§7): it directly
drives which bodies get fetched. Curation is editable and the change history is
recoverable (snapshots + `updated_at`).

It curates **contacts, domains, and freeform interest keywords** — no clustering.

---

## 12. MCP server surface

`mail-index-mcp` (stdio). Agreed v1 surface (see ADR-0001/0003/0004 and
CONTEXT.md). Read-only on the mailbox; inline provider fetches are O(1) only —
anything O(N) returns a **command handback** (the exact `mail-index` CLI
command the agent runs itself).

**Primitives:**
- `search(query, account?, limit?)` — ranked FTS over subject/sender/snippet/
  body/summaries; snippet-first, compact result shapes.
- `get_message(ref, level?)` — summary → distilled body → inline-enriches if
  still `meta` (one O(1) fetch).
- `get_thread(ref)` — thread metadata + messages + thread summary if present.
- `list_contacts(sort?, filter?, limit?)` — by engagement/volume/recency/community.
- `get_contact(address)` — stats, curation, recent threads.
- `find_person(hint)` — fuzzy contact resolution from a vague hint (name
  fragment, domain, time period, context) — the entry point for "who was that
  insurance contact from last spring?". Ranks **Correspondents** (contacts the
  user has written to) first: people remember by who they talked to. `search`
  likewise boosts user-participated threads.
- `list_threads(contact?|query?)` — conversations.
- `graph_neighbors(address)` / `graph_communities()` — derived graph queries.
- `interest_propose()` / `interest_set(selections)` / `interest_get()` — curation.
- `save_summary(ref, text)` — write-back of an agent-authored summary at
  message or thread level (ADR-0003); provenance-marked, FTS-indexed.
- `domains_to_categorize(filter?)` / `save_domain_category(domain, category,
  note?)` — user-triggered categorization of entities/companies with
  back-and-forth communication: the tool extracts candidate domains (those
  with Correspondent contacts) plus sample senders/subjects as context, the
  agent's LLM assigns a category (client, vendor, travel operator, finance,
  publisher, …), and the result is saved back onto `domains.category`.
  Categories become filters/grouping across contact, search, and graph tools.
- `sync_status()` — counts, last run, meta/full/summary-only split, freshness.

**Use-case composites** (SQL views over the index):
- `catch_up(since, account?)` — the "what did I miss" briefing feed: new mail
  from curated-important contacts, new replies in user-participated threads,
  interest-keyword hits; compact rows + handbacks for anything needing bodies.
  If the index is stale, returns current data immediately AND spawns a
  detached incremental sync (ADR-0005); same for `digest_sources`.
- `digest_sources(since?, account?)` — newsletter/list senders ranked by
  engagement + interest match, with unread/unsummarized issue counts. Digest
  routine loop: `digest_sources` → `get_message` per issue → `save_summary` →
  compose digest → bodies demote (ADR-0003).

Write-to-mailbox tools are **out of scope** by design (D15). Sync/enrich are
CLI operations; the MCP never blocks an agent call on a multi-minute fetch —
it hands back the command instead (ADR-0001 supersedes the earlier
`request_enrich` queue idea).

---

## 13. CLI surface

```
mail-index init
mail-index sync   --account <a> [--since <30d|1mo>] [--all] [--query <q>] [--limit N]
mail-index sync   --all-accounts                 # policy presets per account
mail-index enrich --account <a> [--rule direct|all] [--sender <s>] [--match <fts>] [--limit N]
mail-index enrich --profile                      # enrich per curated interest_profile
mail-index graph  build [--account <a>]
mail-index curate [--account <a>]                # interactive wizard (fallback)
mail-index compact [--now] [--account <a>]       # demote summary-eligible bodies (ADR-0003)
mail-index search <terms> [--account <a>] [--limit N] [--enrich]
mail-index show   <account:message-id>           # lazy body-fetch
mail-index open   <account:message-id>           # print provider web URL
mail-index status [--json]                       # machine-readable for tray/scheduler use
mail-index mcp                                    # = mail-index-mcp (server)
```

---

## 14. Privacy & security

- **Local-first.** The index, bodies, and profile never leave the machine. No
  telemetry, no account, no cloud.
- **Read-only on the mailbox by default.** The tool never sends or deletes.
  Archive + label edits are opt-in (ADR-0007), gated on a `gmail.modify` grant;
  remote drafts are opt-in (ADR-0011), gated on a `gmail.compose` grant;
  provider scope stays read-only otherwise. Both opt-in scopes can send at the
  token level, so no-send is enforced in code (runner send guard plus
  `test/drafts.test.ts`), not by the scope.
- **Secret hygiene.** OAuth tokens/credentials are the adapter's concern and live
  in the provider tool's own store, never in this repo or the index DB. The DB
  itself contains message text — treat `~/.local/share/mail-index/` as sensitive;
  document optional at-rest encryption (e.g. SQLCipher / OS-level FileVault) and
  never commit it.
- **`.gitignore`** excludes any `*.sqlite`, local config, and credentials.

---

## 15. Multi-account

One DB, `account`-namespaced rows. An **account** is a (label → adapter config)
mapping owned by the operator instance (2b), not the tool. The tool only needs:
a stable label and a way to invoke the adapter for that label. For the gws
adapter, that's a per-account config dir / wrapper. Cross-account queries are
just "omit the `account` filter"; per-account is "pass `--account`".

---

## 16. Onboarding — generic vs operator-specific

**Generic (in the repo, placeholders only):**
1. Install from source now (`pnpm build`); `npm i -g mail-index` once published.
2. Install + authenticate a `MailSource` (`gog` recommended, or `gws`): install
   the CLI, supply a Google OAuth client, authenticate each mailbox read-only.
3. `mail-index sync --account acct-a --all` (metadata), then `graph build`.
4. Curate (agent or `curate` wizard).
5. `mail-index enrich --profile`.
6. Add the MCP server to the agent.

**Operator-specific (private, NOT in the repo):** the actual account labels,
addresses, send-as aliases, OAuth project, curated profile, and any agent
instructions/routines. The maintainer's own multi-account setup is the reference
deployment used to dogfood the generic tool — documented in private dotfiles.

---

## 17. Repo structure

```
mail-index/
  README.md                 # overview + the 2a/2b boundary up front
  LICENSE                   # MIT
  docs/
    PLAN.md                 # this document
    INSTALL.md              # generic onboarding (placeholders)
    MCP.md                  # tool reference for agent integrators
    ADAPTERS.md             # MailSource contract + writing an adapter
  src/
    index/                  # schema, migrations, repo (node:sqlite)
    ingest/                 # sync, enrich, classify
    source/                 # MailSource interface + adapters/{gog,gws}
    graph/                  # graphology build + persistence
    interest/               # scoring + snapshots
    curation/               # profile + wizard
    cli/                    # mail-index
    mcp/                    # mail-index-mcp
  test/
  package.json              # bins: mail-index, mail-index-mcp
  .gitignore                # *.sqlite, creds, local config
```

---

## 18. Testing

- **Unit:** classification (category/is_list/direction), HTML→text extraction,
  scoring math, query builders.
- **Adapter contract test:** a `MailSource` fixture (recorded fixtures, no live
  network) every adapter must pass.
- **Index integration:** sync→enrich→search→graph over a synthetic fixture
  mailbox; assert counts, FTS hits, score ordering, community assignment.
- **MCP:** tool schema + golden-response tests against a seeded fixture DB.
- No live-mailbox tests in CI; an operator instance (2b) is the live
  end-to-end smoke.
