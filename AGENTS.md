# Agent setup & usage guide

How to give an AI agent (Claude Desktop, Claude Code, Codex, or any MCP client)
recall over a mailbox via mail-index — and how the agent should *use* it.

mail-index is a **stdio MCP server** (`mail-index-mcp`). It is read-only on the
mailbox and operates on a local SQLite index — the agent never gets raw provider
access. Prerequisite: you've installed mail-index and synced at least one account
(see [docs/INSTALL.md](docs/INSTALL.md)).

---

## 1. Register the MCP server

The server command is `mail-index-mcp` (the bin) — or, if it isn't on your
client's `PATH`, an absolute Node + the built entrypoint.

### Claude Desktop
Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) /
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), then **restart the app**:

```jsonc
{
  "mcpServers": {
    "mail-index": { "command": "mail-index-mcp" }
  }
}
```

Desktop apps launch with a minimal environment. If the server won't start, or
`get_message` can't enrich, pin an absolute Node and add the adapter binary's
directory to `PATH`:

```jsonc
{
  "mcpServers": {
    "mail-index": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/mail-index/dist/mcp/index.js"],
      "env": { "PATH": "/dir/with/gws:/usr/local/bin:/usr/bin:/bin" }
    }
  }
}
```

### Claude Code
```sh
claude mcp add mail-index -- mail-index-mcp
# or with an absolute path / env:
claude mcp add mail-index --env PATH="/dir/with/gws:/usr/bin:/bin" -- /abs/path/to/node /abs/path/to/mail-index/dist/mcp/index.js
```

### Codex / other MCP clients
Any client that speaks MCP over stdio works — point it at the `mail-index-mcp`
command (or `node dist/mcp/index.js`). Use the same `env.PATH` note as above so
the adapter CLI (e.g. `gws`) is resolvable for inline body fetches.

Verify: ask the agent *"what mail-index tools do you have?"* — you should see 23,
and *"what's the status of my mail index?"* should return per-account counts.

---

## 2. How the agent should use it

**Reach for recall, not exact queries.** mail-index is built to answer vague
questions. Prefer:

- `search("half-remembered phrase")` — ranked, snippet-first FTS over
  subject/sender/snippet/body/summaries. Vague is fine.
- `find_person("hint")` — fuzzy contact resolution; **correspondents** (people
  the user has emailed) rank first. The entry point for "who was that X?".
- `catch_up(since)` / `digest_sources(since)` — "what did I miss" and the
  newsletter worklist.
- `get_contact` / `list_contacts` / `list_threads` / `graph_neighbors` /
  `graph_communities` — relationship and structure.
- `get_message(ref, level)` — read one message; pass `level: "body"` to pull the
  full (distilled) text. It performs at most one bounded provider fetch
  (ADR-0001).
- `get_message_attachment(ref, attachment?)` — omit `attachment` to list files;
  pass an exact filename or provider id to receive the raw file as an embedded
  MCP blob. Bytes are fetched once and never persisted.
- Curation + write-back: `interest_propose/set/get`, `save_summary(ref, text)`,
  `domains_to_categorize` / `save_domain_category`.

**Contracts to respect:**

- **Token budget.** Results are compact and snippet-first by design. Read snippets
  first; only call `get_message(level:"body")` when you actually need the text.
- **Command handbacks.** Anything bulk (sync, profile enrichment, graph build,
  compact) is *not* run by the server — a tool returns the exact `mail-index …`
  CLI command for you to run in a shell. Run it, then re-query. Never expect the
  server to block on a long fetch.
- **Freshness.** Every response carries `index_as_of`. Time-sensitive tools
  (`catch_up`, `digest_sources`) return current data immediately and may report
  `sync_started: true` with `eta_seconds`; re-call after the ETA for fresher
  results, or check `sync_status()`.
- **Read-only by default; two opt-in writers.** There are no send or delete
  tools, ever. The only mailbox-mutating tools are `archive_message` and
  `modify_labels` — and they work ONLY if the user opted into the `gmail.modify`
  scope (a default install refuses them with a re-auth hint). Use them only when
  the user explicitly asks to archive or relabel; everything else is read-only.

**The personalized-digest pattern** (e.g. a scheduled routine): call
`digest_sources(since)` → `get_message` each issue → `save_summary` each →
compose the digest. Summaries are written back into the index (FTS-indexed), and
bulk bodies are later demoted to summary-only, keeping the index small.

---

## 3. For coding agents working *on this repo*

- Package manager is **pnpm** (`pnpm install`, `pnpm build`, `pnpm test`,
  `pnpm lint`). Node 24+. No native deps — SQLite is `node:sqlite`.
- Tests are `node:test`, importing compiled `dist/` (a `pretest` builds first).
- Keep the **2a/2b boundary**: this repo is the generic tool — no real accounts,
  addresses, or operator config. Examples use placeholders (`acct-a`,
  `you@example.com`). Operator data lives in `*.local.md` / `~/.config` and is
  gitignored.
- New provider support = a `MailSource` adapter that passes the contract test
  ([docs/ADAPTERS.md](docs/ADAPTERS.md)).
