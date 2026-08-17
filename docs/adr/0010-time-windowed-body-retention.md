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
