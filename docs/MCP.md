# mail-index MCP tool reference

The agent surface. `mail-index-mcp` is a **stdio** MCP server
(`@modelcontextprotocol/sdk`) over the local index. This document is the
reference for agent integrators: every tool, its arguments, its compact result
shape, and the two contracts that hold across the whole surface — **freshness**
(`index_as_of`) and **command handbacks**.

See [INSTALL.md §7](INSTALL.md) to register the server with your client.

---

## Design principles

These are not decoration — every tool is built to satisfy them, and they are the
differentiator versus query-based Gmail MCPs.

### Recall, not lookup

Every tool works from a **vague** starting point. Search is fuzzy, ranked
full-text — a half-remembered phrase still surfaces ranked neighbours. Entity
entry points (`find_person`, `list_contacts`) resolve substrings of name /
address / domain and rank **Correspondents** (people you have written to) first,
because people remember by who they talked to. A near-miss never returns a bare
empty set where a near-miss exists: `get_contact` and `graph_neighbors` fall
back to ranked candidates. Query-based MCPs answer exact queries; these tools
answer vague questions.

### Token-budget-conscious by default

Result shapes are compact and **snippet-first** — never a body dump. Full bodies
are **opt-in** (`get_message` with `level: "body"`). Every list tool has a
sensible default limit. Refs (`<account>:<id>`) are stable handles the CLI's
`show`/`open` accept, so the agent can pass them straight through.

---

## The two cross-cutting contracts

### Freshness — a `freshness` block on every response

Every tool response carries a `freshness` block so the agent never has to guess
how current the data is or how to refresh it:

```jsonc
"freshness": {
  "index_as_of": "2026-07-01T11:53:00.951Z", // latest error-free sync for the scope (null = never synced)
  "age_seconds": 420,                          // how old that is (null = never synced)
  "stale": false,                              // true when older than the ~3h threshold
  "syncing": true,                             // a sync for this account is running now
  "refresh_command": "mail-index sync --account unsold-group" // how to refresh manually
}
```

`index_as_of` is also mirrored at the top level for back-compat. Cross-account
(no `account` arg on a multi-mailbox install) `index_as_of` is the **oldest**
such timestamp across accounts — the index is only as fresh as its stalest
mailbox. On a single-mailbox install, a call that omits `account` is scoped to
that sole mailbox.

### Command handbacks — O(N) work is never inline

The server is **read-only on the mailbox by default** ([D15](PLAN.md)) — the
exceptions are the two opt-in writers `archive_message` / `modify_labels`
([ADR-0007](adr/0007-opt-in-mailbox-writes.md)). The single permitted read-side
provider contacts are bounded single-Message reads: `get_message`'s inline O(1)
body fetch and `get_message_attachment`'s list/download calls
([ADR-0001](adr/0001-inline-enrichment-is-o1-only.md)). Anything bulk — sync,
bulk enrich, graph build, compact — is returned as a **command handback**: the
exact `mail-index` CLI command string the agent runs itself. The CLI is the
execution engine; the MCP is the brain that knows which command to run.

### Any stale read spawns a background sync

When an account-scoped call finds the index stale (older than ~3 hours), it
returns current data **immediately** and spawns a **detached** incremental
`mail-index sync` ([ADR-0005](adr/0005-stale-reads-trigger-background-sync.md)),
reporting `sync_started: true` and `eta_seconds` (and flipping `freshness.syncing`
to true). This is not limited to `catch_up` / `digest_sources` — every response
funnels through the same freshness stamp, so a plain `search` on a day-old index
kicks off a refresh too. It never blocks. The agent polls `sync_status` or
re-calls the tool after the ETA. At most one sync per account runs at a time (the
in-progress `sync_runs` row is the lock); WAL mode means the single background
writer never blocks reads.

---

## Common shapes

A **hit** (search / thread message — snippet-first, never the body):

```jsonc
{
  "ref": "acct-a:18f0a1b2c3", "account": "acct-a",
  "from": "Jordan <jordan@partner.example.com>",
  "subject": "Re: deposit terms", "date": "2026-05-31T...",
  "snippet": "the deposit is due Friday…",
  "body_state": "meta",      // meta | full | summary-only
  "has_summary": false, "unread": true, "direction": "received"
}
```

A **contact**:

```jsonc
{
  "address": "jordan@partner.example.com", "account": "acct-a",
  "displayName": "Jordan", "domain": "partner.example.com",
  "msgsReceived": 12, "msgsSent": 4, "correspondent": true,
  "repliedCount": 3, "starredCount": 1, "importantCount": 5,
  "lastSeen": "2026-05-31T...", "engagementScore": 0.82,
  "centrality": 0.14, "communityId": 2, "curation": "important"
}
```

A **thread**:

```jsonc
{
  "ref": "acct-a:thread-xyz", "account": "acct-a",
  "subject": "deposit terms", "msgCount": 6, "unreadCount": 1,
  "userParticipated": true, "firstAt": "...", "lastAt": "...",
  "hasSummary": false
}
```

All of the above also carry `index_as_of` on the top-level response object.

---

## Tools

The surface includes read-only recall and attachment tools, local write-backs,
remote administration, plus the two opt-in mailbox writers `archive_message` /
`modify_labels`. Account resolution: tools that need an
account take an optional `account`; when omitted and exactly one account is
configured / indexed, it is used, otherwise the tool errors asking for one.

### Primitives

#### `search`
Ranked fuzzy full-text recall over subject / sender / snippet / body /
summaries.

| Arg | Type | Notes |
|-----|------|-------|
| `query` | string (required) | terms are prefix-matched and OR-combined |
| `account` | string | restrict to one account |
| `limit` | integer | default 15 |

Returns `{ hits: Hit[], index_as_of }`.

#### `get_message`
One message by `<account:id>`. The summary → distilled body → inline-enrich
ladder.

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<message-id>` |
| `level` | `"summary"` \| `"body"` \| `"meta"` | default `"summary"` |

- `summary` (default, cheapest): the agent summary if present, else the snippet.
- `body`: the distilled body. If the row is still `meta`, performs the **one**
  permitted inline O(1) provider fetch (ADR-0001), gated on a source being
  wired in; `enriched: true` flags that it did.
- `meta`: headers + snippet only, no fetch.

Returns a full message detail incl. `bodyState`, `summary`, `body` (only at
`level: "body"`), `enriched`, and `index_as_of`.

#### `get_message_attachment`
List or download attachments from one indexed Message without persisting the
raw bytes.

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<message-id>` |
| `attachment` | string | exact filename or provider attachment id; omit to list |

With only `ref`, returns attachment metadata (`id`, `filename`, `mimeType`,
`size`). With `attachment`, the selected file is returned as an embedded MCP
blob resource; the text metadata intentionally omits the base64 payload so it
does not consume the model's text context. This is a bounded read-only provider
fetch and is available through the same tool in local and remote Deployments.

**Offers in images — `ocr_images` + `needs_ocr`.** Marketing email often puts the
offer/price/deadline inside an image, leaving the distilled text near-empty.
mail-index **never OCRs** (that would need a vision model + network, breaking the
local-first contract). Instead, at enrich time it deterministically picks which
images plausibly carry readable content — dropping tracking pixels, spacers,
dividers, logos, and icons (see `intelligence/images.ts`) — and returns them on
`get_message`:

- `ocr_images`: ranked array of `{ src, width, height, alt, score, reason }` —
  the content-bearing images (URLs only; mail-index does not fetch them).
- `needs_ocr`: deterministic boolean — `true` when the meaningful body text is
  thin **and** content images exist, i.e. the offer is in the images, not the
  text. This is the "when needed" trigger.

When `needs_ocr` is true, the **agent** (which has vision) reads `ocr_images` —
e.g. fetch and view them — to recover the offer. mail-index stays zero-network.

#### `get_thread`
A thread by `<account:thread-id>`: metadata, its messages (compact hits), and
the thread summary if present.

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<thread-id>` |

Returns `{ thread, summary, messages: Hit[], index_as_of }`.

#### `list_contacts`
Ranked, filterable contacts.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | |
| `sort` | `engagement`(default) \| `volume` \| `recency` \| `community` | |
| `filter` | string | `correspondent` \| `important` \| `muted` \| `blocked` |
| `limit` | integer | default 20 |

Returns `{ contacts: Contact[], index_as_of }`.

#### `get_contact`
One contact by address: stats, curation, recent threads.

| Arg | Type | Notes |
|-----|------|-------|
| `address` | string (required) | |
| `account` | string | resolves across accounts when omitted |

Returns `{ contact, recentThreads: Thread[], index_as_of }`. **On a near-miss**
returns `{ contact: null, recentThreads: [], candidates: Contact[] }` — ranked
candidates, never a bare empty.

#### `find_person`
Fuzzy contact resolution from a vague hint — the entry point for "who was that
contact from last spring?". Ranks Correspondents first; matches substrings of
name / address / domain.

| Arg | Type | Notes |
|-----|------|-------|
| `hint` | string (required) | |
| `account` | string | |
| `limit` | integer | default 10 |

Returns `{ matches: Contact[], index_as_of }`.

#### `list_threads`
Conversations by contact **or** by query (one of the two is required).

| Arg | Type | Notes |
|-----|------|-------|
| `contact` | string | an address; threads this contact took part in |
| `query` | string | FTS over threads |
| `account` | string | |
| `limit` | integer | default 20 |

Returns `{ threads: Thread[], index_as_of }`.

#### `graph_neighbors`
Co-recipiency neighbours of a contact, ranked by shared non-list threads
([D8/D9](PLAN.md)).

| Arg | Type | Notes |
|-----|------|-------|
| `address` | string (required) | |
| `account` | string | |
| `limit` | integer | default 15 |

Returns `{ neighbors, fallback, index_as_of }`. **On a miss** (no co-recipients
or no graph built) `fallback: true` and `neighbors` is a ranked near-miss
contact set (zero-weight) — never a bare empty.

#### `graph_communities`
Detected social circles (Louvain) with top members by centrality.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | defaults to the sole account |
| `memberLimit` | integer | default 10 |

Returns `{ communities, index_as_of }`. When no graph exists, also returns
`build_command` — a **handback** to `mail-index graph build --account <a>`.

### Curation write-back loop

The index proposes, the agent's LLM judges, a write-back tool persists. See
[ADR-0004](adr/0004-all-intelligence-from-the-users-llm.md).

#### `interest_propose`
The curation **seed**: a ranked shortlist of top contacts + domains by
engagement, each with a suggested action. Present it, take fuzzy edits, then
`interest_set`.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | |
| `contactLimit` | integer | |
| `domainLimit` | integer | |

Returns `{ proposal, index_as_of }`.

#### `interest_set`
Persist the curation disposition. This profile **is** the enrichment policy.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | |
| `contacts` | `{ address, curation }[]` | curation: `important`/`muted`/`blocked`/`null` (clear) |
| `domains` | `{ domain, curation }[]` | same curation values |
| `keywords` | `string[]` | freeform interest terms (replaces the set) |

Returns `{ result, index_as_of }`.

#### `interest_get`
Read back the curated profile: curated contacts/domains + keywords.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | |

Returns `{ profile, index_as_of }`.

### Summarization write-back

#### `save_summary`
Persist an agent-authored summary at message or thread level (provenance-marked,
FTS-indexed). For bulk / non-curated mail this makes the body eligible for
demotion to summary-only after a grace window
([ADR-0003](adr/0003-agent-written-summaries-and-body-demotion.md)).

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<id>` |
| `text` | string (required) | the summary |
| `level` | `"message"`(default) \| `"thread"` | |

Returns `{ result, index_as_of }`.

### Domain categorization write-back

#### `domains_to_categorize`
**Propose** domains with back-and-forth contacts (Correspondents) plus sample
senders/subjects as context, so the agent's LLM can assign an entity category.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | |
| `includeCategorized` | boolean | include already-categorized domains |
| `limit` | integer | |

Returns `{ candidates, index_as_of }`.

#### `save_domain_category`
**Persist** an agent-assigned category (open vocabulary: client, vendor, travel
operator, finance, publisher, …). Becomes a filter/grouping axis.

| Arg | Type | Notes |
|-----|------|-------|
| `domain` | string (required) | |
| `category` | string (required) | |
| `note` | string | optional rationale |
| `account` | string | |

Returns `{ result, index_as_of }`.

### Status + composites

#### `sync_status`
Per-account freshness, whether a sync is running, message counts, and the
meta/full/summary-only body-ladder split.

| Arg | Type | Notes |
|-----|------|-------|
| `account` | string | all accounts when omitted |

Returns `{ accounts: [{ account, index_as_of, syncing, messages, bodyStates }], index_as_of }`.

#### `catch_up`
The "what did I miss" briefing since a time. Three compact feeds: new mail from
curated-**important** contacts/domains, new replies in **user-participated**
threads, and **interest-keyword** hits. Bodies are not fetched — a handback
enriches them. Stale → returns now + spawns a background sync (ADR-0005).

| Arg | Type | Notes |
|-----|------|-------|
| `since` | string (required) | relative token (`30d`, `2w`, `12h`, `1mo`) or ISO timestamp |
| `account` | string | |

Returns `{ since_ms, fromImportant: Hit[], inUserThreads: Hit[], keywordHits: Hit[], bodies_command, sync_started?, eta_seconds?, index_as_of }`.

#### `digest_sources`
Newsletter/list senders ranked by engagement + interest, with
unread/unsummarized issue counts — the digest routine worklist. The loop:
`digest_sources` → `get_message` per issue → `save_summary` → bodies demote
(ADR-0003). Stale → returns now + spawns a background sync.

| Arg | Type | Notes |
|-----|------|-------|
| `since` | string | optional cutoff |
| `account` | string | |

Returns `{ sources, read_command, sync_started?, eta_seconds?, index_as_of }`.

### Opt-in writers (mutate the mailbox)

These two are the **only** tools that change the mailbox. They require a
`gmail.modify`-capable grant (a default `gmail.readonly` install refuses them
with a re-auth hint) and should be called only when the user explicitly asks to
archive or relabel. Never send or delete. See
[ADR-0007](adr/0007-opt-in-mailbox-writes.md).

#### `archive_message`
Archive one message — removes its `INBOX` label.

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<message-id>` |

Returns `{ ref, labels, indexed, index_as_of }` (`labels` = the resulting label
set; `indexed: false` if the message was not in the local index).

#### `modify_labels`
Add and/or remove labels on one message (system ids like `STARRED`/`UNREAD`, or
existing user-label **names**; creating new labels is not supported).

| Arg | Type | Notes |
|-----|------|-------|
| `ref` | string (required) | `<account>:<message-id>` |
| `add` | string[] | label ids/names to add |
| `remove` | string[] | label ids/names to remove |

At least one of `add` / `remove` is required. Returns
`{ ref, labels, indexed, index_as_of }`.

---

## Errors

A tool that cannot proceed (bad `<account:id>` ref, unknown account, unknown
tool) returns an MCP `isError` content result carrying a clear message — often
including the **handback** to fix it (e.g. an unknown message suggests
`mail-index sync --account <a>`). It is a clean tool error, not a transport
fault.
