# M3: Run the intelligence layer (graph, cadence, interest) within Worker CPU limits

## Context
Depends on 008: tool parity (the tools exist and answer; this ticket makes
their heavy rebuild paths production-safe on Workers) and 006 (continuation
mechanism via `jobs.progress_json`).
Read first: docs/PLAN-worker.md ("Deltas that need care" — graphology is pure
JS but rebuild must respect CPU limits), ADR-0004 (all intelligence from the
user's LLM — the deterministic layer here only aggregates/proposes),
CONTEXT.md (Interest profile, Engagement score, Entity category).

The code: `src/graph/` (graphology + graphology-communities-louvain +
graphology-metrics — already in `dependencies`, pure JS, portable),
`src/intelligence/` (cadence etc.), `src/curation/`
(interest/engagement), aggregation via `Repo.messagesForAggregation` /
`Repo.replaceAggregates`. On the Worker these run inside 006 Job executions
(the `graph` phase of `SYNC_PHASES`) and inside tool calls
(`graph_neighbors`, `graph_communities`, `cadence`, `interest_propose`).

## Decision
Same algorithms, budgeted execution.

- `worker/wrangler.jsonc`: raise `limits.cpu_ms` (Workers paid plan is
  already assumed — ADR-0009); pick the value from measurement, not guess.
- Measure first: a scripted benchmark loads a realistic mailbox (use the
  bench corpus scale from `bench/` — target the size class in
  RESULTS-INBOX100/RESULTS docs, plus a 10x synthetic set — generate by
  cloning the bench corpus with perturbed sender addresses/domains, which
  preserves fan-out distribution for louvain timing) into local D1 and
  times full graph rebuild, louvain community detection, cadence
  aggregation, and interest proposal under `wrangler dev`/Miniflare CPU
  accounting. Record results in `bench/` (e.g. `bench/RESULTS-WORKER.md`).
- Chunked rebuild **if needed** (only where measurement shows a budget
  breach): the graph phase of a sync Job splits into resumable steps via the
  006 continuation mechanism (cursor in `jobs.progress_json`) — e.g.
  aggregate in message batches, then run louvain once over the assembled
  graph in its own job step. No algorithm changes; determinism preserved
  (same input ⇒ same communities).
- Tool-call paths stay read-only over precomputed aggregates (they already
  are — rebuilds happen in the sync pipeline); assert none of the four tools
  triggers a full rebuild inline.

## Acceptance criteria
- [ ] Benchmark script + checked-in results exist covering graph rebuild,
      louvain, cadence, interest at realistic mailbox size on the Worker
      runtime.
- [ ] `limits.cpu_ms` set in wrangler config with a comment citing the
      measurement.
- [ ] Full sync Job including the graph phase completes on the measured
      mailbox size without hitting CPU/eviction limits (test under Miniflare
      with limits enforced, or documented wrangler-dev run).
- [ ] If chunking was needed: an interrupted graph phase resumes from its
      cursor and converges to the same aggregates as an uninterrupted run
      (equality test). If not needed: a note in the benchmark results says so
      with headroom numbers.
- [ ] `graph_neighbors`, `graph_communities`, `cadence`, `interest_propose`
      each answer on the Worker within one request without enqueueing work.
- [ ] Local behavior and all 34 existing test files unchanged/green.

## Out of scope
- No new intelligence features, scores, or graph metrics.
- No Durable Objects / external compute offload — same-Worker execution only.
- No changes to the write-back loop (LLM judging stays with the agent,
  ADR-0004).
- No OCR/image work.
