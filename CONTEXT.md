# mail-index

An agent-queryable mail intelligence layer: progressive index over one or
more mailboxes, exposed to AI agents through an MCP server. Built for
*recall* (answering vague questions), not lookup. Runs local-first; a
self-hosted remote Deployment on the operator's own Cloudflare account is an
explicit opt-in (ADR-0008).

## Language

**Message**:
One mail item in the index, namespaced by (account, provider message id).
_Avoid_: email, mail item

**Body state**:
Where a Message sits on the compaction ladder: **meta** (headers + snippet),
**full** (distilled body text, FTS-indexed), or **summary-only** (body demoted
after summarization, ADR-0003). Raw provider bytes are never persisted.

**Enrichment**:
Promoting a Message from meta to full by fetching its body from the provider.
The fetched body is always stored **distilled** (HTML stripped; quoted history,
signatures, footers, tracking junk removed).
_Avoid_: hydration, body sync

**Summary**:
An agent-written digest of a Message or Thread, saved into the index via
`save_summary`, provenance-marked as model-generated, FTS-indexed.

**Demotion**:
Dropping a distilled body once its Summary exists — the end state for bulk
(`is_list`) and non-curated mail. Never applied to curated-important contacts
or user-participated Threads. Runs via `compact` after a grace window (default
7 days), auto-invoked by sync. Safe because of the Working set principle.

**Working set**:
The index is a working set + knowledge layer, not an archive — the provider
remains the archive, so demotion/eviction is never data loss; anything can be
re-enriched by id.

**Inline enrichment**:
A single-message (O(1)) enrichment performed during an MCP tool call. O(N)
enrichment is never inline — the tool returns a Command handback (ADR-0001).

**Command handback**:
An MCP tool response containing the exact `mail-index` CLI command the agent
should run to obtain content the server won't fetch inline. The CLI is the
execution engine; the MCP is the brain that knows which command to run.
Local Deployment only — the remote counterpart is a **Job** (ADR-0009).

**Deployment**:
Where an index runs: **local** (CLI + stdio MCP on the user's machine, the
default) or **remote** (single-tenant Worker on the operator's own Cloudflare
account: D1 storage, streamable-HTTP MCP, cron sync). Same core, same schema,
different drivers. A remote Deployment is operator-owned infrastructure —
there is no mail-index-operated hosting (ADR-0008).

**Job**:
The remote Deployment's replacement for a Command handback: O(N) work
(backfill, bulk Enrichment) is enqueued (Cloudflare Queues), the tool returns
a job id, and progress is readable via `sync_status`. Inline stays O(1)
(ADR-0001) in both Deployments.

**Sweep**:
A bounded, resumable Job that walks the mailbox a batch at a time rather than
trying to finish in one invocation: `enrich_bulk`, `retention`,
`backfill_slice`, `graph`. Sweeps ride their own Queue (`mail-index-sweeps`) so
a long-running sync cannot starve them (ADR-0009 amendment).
_Avoid_: sweeper, background pass

**Trigger rule**:
An operator-defined predicate over *index* intelligence — category, `is_list`,
Correspondent status, Interest profile membership, label, sender/domain,
subject/FTS terms — evaluated against newly synced Messages. On match, the
remote Deployment POSTs a signed webhook to registered consumer URLs. The
differentiator vs provider filters: rules can reference what the index knows
(e.g. "curated-important Correspondent wrote").
_Avoid_: filter (that's the provider's word), alert

**Read-only by default**:
By default the tool never mutates the mailbox, and never sends or deletes mail at
all. Fetching message content is permitted — read-only does not mean offline.
Two mutations — archive (drop INBOX) and label edit (add/remove labels) — are an
explicit OPT-IN gated on a least-privilege `gmail.modify` re-auth
(`mail-index setup --enable-writes`); they flow through the same adapter seam and
never touch the local-only / zero-egress guarantee (ADR-0007).

**Interest profile**:
The user-curated policy (important/muted contacts and domains + freeform
keywords) that drives which bodies get enriched. Curation output, enrichment
input.

**Engagement score**:
A derived per-contact score from read/reply/star/importance signals. A *seed*
for curation, never an autonomous fetch trigger.

**Write-back loop**:
The canonical pattern for anything language-shaped: the index *proposes* (a
deterministic shortlist with context), the user's LLM *judges* via MCP, and a
write-back tool *persists* the result with model-generated provenance.
Instances: interest curation, summarization, domain categorization.

**Entity category**:
An agent-assigned label on a Domain with back-and-forth communication (client,
vendor, travel operator, finance, publisher, …). User-triggered via the
write-back loop; used as a filter/grouping axis across contact, search, and
graph tools.

**Recall**:
Retrieval from a vague starting point — fuzzy ranked search, entity entry
points, ranked neighbors on a miss. The differentiator vs query-based
(exact-lookup) mail MCPs.

**FTS contract**:
The single definition of how a Message becomes searchable and ranked: the
`messages_fts` columns, the tokenizer (porter), the body projection that fills
the `body` column from the Body state ladder (snippet + distilled body +
summary), and the bm25 column weights. Owned in one module, depended on by both
*index-time* (sync, Enrichment, migrations — via the projection) and
*query-time* (search — via the match builder + weights). Single-sourcing it
keeps ranking deterministic: index-time and query-time can never drift apart.
_Avoid_: scattering query-building into `cli/`, projection into repo internals.

**Correspondent**:
A Contact the user has ever sent mail to (`msgs_sent > 0`, from the Sent
index). The sharpest human-vs-noise separator; exposed as a filter/tag on
contact tools and weighted strongly by the Engagement score.
_Avoid_: "real contact", "human sender"

**Account**:
An operator-defined label mapping to one mailbox + adapter config. Lives in
operator config, never in the repo.

## Relationships

- The **Interest profile** selects which **Messages** get **Enrichment**.
- The **Engagement score** proposes; curation into the **Interest profile**
  disposes.
- Every **Message**, **Contact**, and **Thread** belongs to exactly one
  **Account**.
- A **Correspondent** is a **Contact** with at least one user-sent Message;
  bulk senders are never Correspondents unless the user has written to them.

## Example dialogue

> **Dev:** "The agent asked for a message that's still **meta** — do we block
> while we fetch the whole thread?"
> **Domain expert:** "No — **inline enrichment** is one message, one fetch.
> If the agent wants the whole thread's bodies, that's O(N): enqueue it."

## Flagged ambiguities

- "read-only" was used to mean both "never mutates" and "never touches the
  network" — resolved: it means never mutates; bounded fetching is allowed.
