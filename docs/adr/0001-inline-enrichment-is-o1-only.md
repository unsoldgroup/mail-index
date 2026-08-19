# MCP tools enrich inline only for O(1); O(N) returns a command handback

The MCP server is "read-only on the mailbox" — meaning it never *mutates* mail,
not that it never *fetches*. A tool call may perform a bounded, single-message
provider fetch inline (`get_message` on a `meta` row does one `format=full`
fetch, ~1–3 s) because answering "what did that email say?" mid-conversation is
the product promise. Anything O(N) — bulk body fetches, policy sweeps — never
runs inline. Instead the tool returns a **command handback**: the exact
`mail-index enrich …` invocation that fetches precisely the needed content,
which the agent runs itself via its shell (agents with MCP access overwhelmingly
also have shell access). This kills the need for a daemon or an in-server job
queue in v1: the CLI is the execution engine, the MCP is the brain that knows
which command to run. The line is: **O(1) network calls inline, O(N) handed
back as a command.** Consequence: `request_enrich` is dropped in favor of
handbacks; `search`'s per-hit `enrich` option is dropped (agents enrich a
specific hit via `get_message`).

## Amendment — 2026-08-19, UNS-1410

The remote sync Job violated this ADR for a year without anyone noticing, because
the violation was invisible on a small mailbox.

The sync branch of `runJob` called:

```ts
enrich({ account, source, repo, selector: { rule: 'direct' } })
```

No `limit` and no `since`, so `Repo.selectMetaMessages` returned **every**
meta-state direct Message in the whole mailbox and the loop did one provider
fetch per Message. That is O(mailbox) inline work, which is exactly what this
ADR forbids.

It scaled straight into the Workers 15-minute wall limit. Measured 2026-08-19:
`fora` (1,726 Messages) finished; `personal` (11,050) and `unsold-group`
(13,759) never did. Those two syncs therefore never reached `update('done')`,
never chained their sweeps, and were reaped hourly as `stale Job lock expired`.
`personal` had 11,050 Messages indexed and not one successful sync on record.

The inline call is now capped at `INLINE_ENRICH_BATCH` (50), newest-first, so it
spends its budget on mail that just arrived. The backlog is `enrich_bulk`'s job —
the bounded, resumable sweep that chains off every completed sync.

Worth noting why this needed no cursor, unlike the historical backfill: the enrich
backlog is self-describing. Candidates are `body_state='meta'` rows in D1, so
anything a run does not reach is still `meta` and is simply picked up next time.
Progress lives in the data, not in a watermark. Bounding the *metadata* sweep the
same way would NOT be safe — a `sync_runs` row closed without an error advances
the incremental watermark, so an unswept remainder would be skipped forever.
