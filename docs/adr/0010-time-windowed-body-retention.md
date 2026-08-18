# A time window decides which bodies the index holds

ADR-0003 made body retention a question of **importance**: bulk mail with a
summary could be demoted, curated and user-participated mail could not. That
rule is sound but it only ever *removes*. Nothing decided which bodies should be
there in the first place, so acquisition was left entirely to the curated
interest profile — and an operator who never curated one got an index that could
find a message and never read it. In practice a 10,496-message mailbox held 33
bodies, so ordinary questions ("what did I order?") were unanswerable even
though the message was indexed and the sync was healthy.

So retention gains a second axis: **recency**, as an explicit per-Account
setting (`account_settings.body_window_months`, default 3).

- **Inside the window, every message gets a body.** Not just interest-profile
  matches — the window IS the policy there. This is what makes recent mail
  answerable in one hop.
- **Outside it, bodies are evicted** unless ADR-0003's protections apply. Those
  are preserved verbatim: a thread the user took part in, and any
  curated-important sender or domain, keep their body at any age.
- **Eviction is not deletion.** With a summary the row lands on `summary-only`,
  as ADR-0003 already specified. Without one it returns to `meta` — "fetchable,
  not fetched", which is the honest state, and `get_message(level:'body')`
  re-enriches it by id on demand. The provider remains the archive; the index is
  a working set.

The interest profile keeps its job: it decides what is worth holding *beyond*
the window. The two axes compose rather than compete — recency answers "what am
I likely to ask about", curation answers "what do I never want to lose".

## The invariant that matters

Enrichment and eviction MUST derive their cutoff from one function
(`windowCutoff`). If they disagree by even a day, the boundary messages are
fetched by one sweep and dropped by the other on every cycle — an invisible,
permanent loop of provider calls that looks like normal activity. This is the
single most important thing to preserve when changing any of it.

## Consequences

- Both sweeps are O(mailbox) and therefore run as **bounded, resumable queued
  Jobs** (ADR-0009), one batch per Account per cron tick. Neither may attempt to
  finish in one invocation: a Worker isolate killed by the CPU or subrequest
  limit leaves its Job wedged.
- Storage no longer tracks "1.5% of mailbox" (README, docs/INSTALL.md). That
  figure assumed bodies were acquired sparsely by curation alone. A 3-month
  window of full bodies is a larger and, more importantly, a **bounded and
  predictable** footprint — it stops growing once the window is saturated,
  whereas the old model grew with whatever curation accumulated. The docs should
  be re-measured rather than left to imply the old number.
- The window is per-Account by design: a business archive and a personal mailbox
  do not want the same answer, and the setting is asked once during onboarding.

## Amendment — 2026-08-18, UNS-1335

"One batch per Account per cron tick" above is now **one batch per Account per
successful sync**. The cron used to enqueue both sweeps directly, which meant one
`scheduled()` invocation carried three enqueues per Account under a 30s CPU cap.
Queue producer sends are buffered until the invocation ends, so an isolate killed
late committed the `jobs` rows and lost the messages — rows sat `queued` with
`started_at IS NULL` until the lease reaped them. The cron now enqueues only the
sync, and the completed sync chains both sweeps for its own Account, next to the
`graph` and `backfill_slice` handoffs.

The cadence is unchanged in the healthy case: one sync per Account per tick, so
one batch of each sweep per Account per tick. What changes is the failure case —
an Account whose sync throws gets no sweeps that tick. That is deliberate. A
sweep needs the provider (`enrich_bulk` fetches bodies), so an Account that could
not sync has nothing useful to sweep, and `retention` eviction is pure catch-up
that loses nothing by waiting an hour. Accounts with a rejected grant were
already skipped by the cron for the same reason.

Chaining also removed a starvation bug: `enrich_bulk` takes the Account lock the
sync holds, so queued from the cron it found the Account busy and yielded on
every tick.
