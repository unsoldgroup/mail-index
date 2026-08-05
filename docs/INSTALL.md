# Installing mail-index

Generic onboarding for **anyone**. This document contains **no real account
data** — every example uses placeholders (`you@example.com`, `acct-a`,
`acct-b`). The accounts, OAuth app, and curated profile you stand up *on top of*
the tool are your private instance (the 2b side of the boundary in
[PLAN.md §2](PLAN.md)); they live in your own dotfiles and data directory, never
in this repo.

> **Prototype-DB note.** If you ran the old single-file prototype, it created an
> **unversioned** SQLite DB at the shared data path. `mail-index` refuses to open
> it (it would collide with the new schema) and prints a clear error. Move it
> aside (`mv ~/.local/share/mail-index/mail.sqlite ~/.local/share/mail-index/mail.sqlite.prototype-bak`)
> or point the tool at a different data dir via `XDG_DATA_HOME`, then re-sync —
> metadata sync is fast, so a fresh sync is the supported migration path.

---

## 0. Requirements

- **Node.js 24+** (the index uses the built-in `node:sqlite` — no native build
  step, no `better-sqlite3`).
- A **MailSource adapter** for your Gmail mailbox. mail-index ships two,
  both read-only:
  - **`gog`** (recommended) — Gmail via the
    [`gog`](https://github.com/openclaw/gogcli) CLI (`brew install
    openclaw/tap/gogcli`). Clean JSON output, a `--gmail-no-send` safety flag,
    and the path the one-click installers use.
  - **`gws`** — Gmail via Google's [`gws`](https://github.com/googleworkspace/cli)
    Workspace CLI. Useful if you already run `gws`, or for a Workspace org that
    manages its own OAuth client.

Either adapter ultimately talks to the Gmail API through a Google **OAuth
client**. You have two ways to provide one — see [§2](#2-connect-a-mailbox-pick-an-oauth-path).

---

## 1. Install the tool

```sh
npm i -g mail-index          # or: pnpm add -g mail-index
# …or run without installing: npx mail-index <command>
```

This gives you the two bins:

| Bin | Purpose |
|-----|---------|
| `mail-index` | the CLI (ops + the fallback curation wizard) |
| `mail-index-mcp` | the stdio MCP server (the agent surface) |

Prefer source? `git clone` the repo, `pnpm install && pnpm build`, and invoke as
`node dist/cli/index.js <command>`.

---

## 2. Connect a mailbox: pick an OAuth path

Reading Gmail needs a Google **OAuth client**. mail-index gives you **two ways**
to get one — pick whichever fits. Both end with the same thing: an adapter
authenticated against your mailbox with **read-only** Gmail scope
(`gmail.readonly`). mail-index does not mutate the mailbox by default.

> **Optional: archive + label edits.** If you want mail-index to archive
> messages or edit labels, opt in to the least-privilege `gmail.modify` scope
> (read + modify only — never send or delete). Two ways:
>
> - **At onboarding:** add `--enable-writes` to `mail-index setup`.
> - **For an already-onboarded account:** run the bundled helper
>   `scripts/enable-writes.sh <account-email>` (a copy-safe wrapper around the
>   gog re-consent — handy because the raw scope flag is long and easy to
>   mangle when pasting).
>
> Either unlocks the `mail-index archive`/`label` commands and the
> `archive_message`/`modify_labels` MCP tools. Leave it off to stay read-only at
> the token level. **gws-adapter** accounts use whatever scope their own gws
> config grants — if that already includes a Gmail modify scope (`gmail.modify`
> or `https://mail.google.com/`), writes work with no extra step. See
> [ADR-0007](adr/0007-opt-in-mailbox-writes.md).

| | **Option A — mail-index beta client** | **Option B — your own Google Cloud client** |
|---|---|---|
| Google Cloud setup | **None** | ~15 min in the GCP console (we walk you through it) |
| Who signs the app | mail-index | you |
| User limit | **~100 users** (beta, "unverified app" screen) | none (it's your own app) |
| Best for | trying it fast, individuals (after a one-time access request) | teams, Workspace orgs, going past the beta cap |

> **Why the ~100 cap on Option A?** `gmail.readonly` is a Google *restricted*
> scope. Until the mail-index app finishes Google verification + a CASA security
> audit it stays in "testing" mode, which Google caps at ~100 users — and Google
> only lets **named test users** through that screen. So Option A needs a one-time
> request to add your address to the list (below). Option B uses *your* client,
> so the cap is yours to lift (or ignore). Full detail:
> [docs/oauth-and-verification.md](oauth-and-verification.md).

### Option A — use the mail-index beta OAuth client (skip Google Cloud) — *planned*

The intended fastest path. **First, request access:** open a
[**Beta access request**](https://github.com/unsoldgroup/mail-index/issues/new?template=beta_access.yml)
with the Google address you'll sign in as — we add it to the mail-index app's
test users (Google requires named testers while the app is in "testing" mode).
Once you're on the list, a `mail-index setup` wizard will install the adapter,
place the **mail-index** OAuth client, and run the browser sign-in — no Google
Cloud console.

The `setup` wizard **is built** (`mail-index setup --account you@gmail.com`) and
runs this per mailbox: install gog, place the OAuth client, then
`gog auth add … --gmail-scope=readonly` (you approve the "unverified app —
mail-index" read-only consent screen; an `access blocked / not a test user` error
means your address isn't on the list yet). **What's still pending is the *bundled*
mail-index client** — it isn't distributed in the package yet, so without a client
on disk `setup` falls back to printing the manual `gog auth` steps. Until that
ships, **Option B** (your own client — same end state, one console visit) is the
working path; pass it to the same wizard with `mail-index setup --client <path>`.

### Option B — bring your own Google Cloud OAuth client (no caps)

Create a Desktop OAuth client once, then point the adapter at it. This is your
own app, so there is no mail-index user cap and no dependency on our beta status.

> **Setting this up with an AI agent?** Follow the step-by-step,
> verify-after-each-step runbook in **[docs/agent-install.md](agent-install.md)** —
> written for an agent to execute, with the two human-only steps (the Cloud
> Console + the browser sign-in) clearly marked.

1. **Create a Google Cloud project** →
   <https://console.cloud.google.com/projectcreate>.
2. **Enable the Gmail API** in that project.
3. **Configure the OAuth consent screen** (External). Add **only** the
   `https://www.googleapis.com/auth/gmail.readonly` scope. While in "testing",
   add yourself as a test user.
4. **Create credentials → OAuth client ID → Desktop app.** Download the
   `client_secret.json`. (Desktop clients auto-allow the loopback redirect the
   CLIs use.)
5. **Hand the client to your adapter** and authenticate each mailbox:

   **gog:**
   ```sh
   gog auth credentials ~/Downloads/client_secret_xxx.json   # store your client
   gog auth add you@gmail.com --services gmail --gmail-scope=readonly
   gog auth list -j                                          # verify
   ```

   **gws** (one isolated config dir per mailbox so credentials never cross):
   ```sh
   # place your client at the gws default location, then log in per account
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-a gws auth login
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-a gws auth status   # verify
   GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws-acct-b gws auth login
   ```

Either way, OAuth tokens live in the **adapter's** own store (gog's config, or
the gws config dir) — **never** in this repo or the index DB.

---

## 3. Scaffold your operator config (`init`)

```sh
mail-index init
```

`init` is idempotent and non-destructive. It:

- creates the index data directory
  (`${XDG_DATA_HOME:-~/.local/share}/mail-index/`), and
- copies the shipped `config.example.json` placeholder to your private config at
  `${XDG_CONFIG_HOME:-~/.config}/mail-index/config.json` **only if one does not
  already exist** (your real accounts are never overwritten).

Then edit that config to map your account **labels** to adapters. A `gog`
account is keyed by its email; a `gws` account by its config dir:

```jsonc
{
  "accounts": {
    "personal": {
      "adapter": "gog",
      "account": "you@gmail.com",
      "syncPolicy": { "since": "1mo", "includeSent": true }
    },
    "work": {
      "adapter": "gws",
      "configDir": "~/.config/gws-work",
      "syncPolicy": { "query": "from:you@example.com", "limit": 5000, "includeSent": false }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `adapter` | which MailSource backs the account: `gog` or `gws` |
| `account` | **gog only** — the mailbox email gog signs in as (`gog auth add` authorized it) |
| `configDir` | **gws only** — the per-account `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (`~` is expanded) |
| `syncPolicy.since` | default lower bound on message age (`30d`, `1mo`, ISO-8601) |
| `syncPolicy.query` | default provider-native filter (e.g. `from:you@example.com`) |
| `syncPolicy.limit` | default cap on enumerated ids |
| `syncPolicy.includeSent` | index Sent metadata too (unlocks replied/initiated signals) |

> **Switching adapters is free.** An account label is keyed to its mailbox, not
> its transport — message ids are identical whether `gog` or `gws` fetched them.
> Change a label's adapter (e.g. `gws` → `gog`) for the **same mailbox** and the
> cached index is reused; the next sync only pulls new mail. mail-index pins each
> label to the address it first indexed and refuses a sync that would point it at
> a *different* mailbox, so a swap can never corrupt the cache.

The config file holds your private accounts — keep it out of version control.

---

## 4. Sync the metadata, then build the graph

Phase-1 sync fetches **only metadata** (headers + snippet + labels) for every
message in scope — roughly 2 KB/message, so a full mailbox finishes in minutes.

```sh
# whole mailbox for one account
mail-index sync --account acct-a --all

# …or every configured account using each account's own policy presets
mail-index sync --all-accounts
```

After a **full/initial** sync, build the derived contact graph (centrality +
Louvain communities over your non-bulk threads):

```sh
mail-index graph build --account acct-a       # or: --all-accounts
```

The graph is a lazy, derived layer — skipping it leaves search and sync fully
functional.

---

## 5. Curate who/what matters

Curation produces the **interest profile** that drives which bodies get
enriched. The primary path is **agent-mediated** through the MCP server
(`interest_propose` → present → `interest_set`). For users without an agent, a
minimal CLI wizard is the fallback:

```sh
mail-index curate --account acct-a
```

It walks the ranked shortlist (top contacts + domains by engagement) and takes a
keep / mute / important / skip decision for each, then collects freeform
interest keywords.

---

## 6. Enrich the bodies that earn their place

Phase-2 enrichment promotes selected metadata-only messages to full distilled
bodies (HTML stripped; quotes, signatures, and tracking junk removed) and
re-indexes them for search:

```sh
# enrich exactly what your curated profile selects
mail-index enrich --account acct-a --profile

# …or the pre-curation heuristic: non-list, non-promo/social mail
mail-index enrich --account acct-a --rule direct
```

`--profile` is the curated policy: important contacts/domains → always, muted →
never, keyword matches → yes. Bodies are also fetched **lazily** on demand —
`mail-index show <ref>` auto-enriches a single message, and `search --enrich`
enriches the hits it returns.

---

## 7. Add the MCP server to your agent

The agent surface is the stdio server `mail-index-mcp`. **This step only
*registers the server*** — do steps 2–4 (connect a mailbox + first sync) first,
or its tools have nothing to read.

- **Claude Code:**
  ```sh
  claude mcp add --transport stdio mail-index -- npx -y -p mail-index mail-index-mcp
  ```
  (add `--scope project` to share it via a committed `.mcp.json`; or use
  `-- mail-index-mcp` directly if it's on your PATH).
  **Windows:** MCP clients spawn the command without a shell, and `npx` is
  `npx.cmd` (a batch file) that Windows can't launch directly (`spawn npx
  ENOENT`). Wrap it in `cmd /c`:
  ```sh
  claude mcp add --transport stdio mail-index -- cmd /c npx -y -p mail-index mail-index-mcp
  ```
- **Any MCP client — manual config:**
  ```jsonc
  { "mcpServers": { "mail-index": { "command": "mail-index-mcp" } } }
  ```
  **Windows:** the global bin is `mail-index-mcp.cmd`, which won't spawn
  directly either — wrap it, or point at Node + the built entry:
  ```jsonc
  { "mcpServers": { "mail-index": { "command": "cmd", "args": ["/c", "mail-index-mcp"] } } }
  // …or, if you cloned the repo:
  { "mcpServers": { "mail-index": { "command": "node", "args": ["C:\\path\\to\\mail-index\\dist\\mcp\\index.js"] } } }
  ```
- **Claude Desktop:** download the
  [`.mcpb` bundle](https://github.com/unsoldgroup/mail-index/releases/latest/download/mail-index.mcpb)
  and double-click it (unsigned during beta — allow it in System Settings /
  Windows SmartScreen if prompted). The bundle is **self-contained** — it ships
  its own `dist` + dependencies and is run by Claude Desktop's bundled Node, so
  it needs **no** npx, network, or system Node and installs identically on
  Windows/macOS/Linux. Still in progress: a *signed* all-in-one DMG/MSI
  installer that *also* does the local setup (adapter + sign-in + sync). There
  is no `claude://` install link.

**Desktop apps launch with a minimal environment** — two practical notes if the
server fails to start or `get_message` can't enrich:

- **Node:** if you use a version manager (fnm/nvm/asdf), `mail-index-mcp` may not
  be on the app's `PATH`. Point `command` at an absolute Node binary and the
  built entrypoint instead:
  ```jsonc
  // macOS / Linux
  {
    "mcpServers": {
      "mail-index": {
        "command": "/abs/path/to/node",
        "args": ["/abs/path/to/mail-index/dist/mcp/index.js"],
        "env": { "PATH": "/dir/with/your/adapter/bin:/usr/local/bin:/usr/bin:/bin" }
      }
    }
  }
  // Windows (note the doubled backslashes and `;`-separated PATH)
  {
    "mcpServers": {
      "mail-index": {
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["C:\\path\\to\\mail-index\\dist\\mcp\\index.js"],
        "env": { "PATH": "C:\\dir\\with\\adapter;C:\\Program Files\\nodejs" }
      }
    }
  }
  ```
- **Adapter binary:** `get_message`'s inline enrich shells out to the adapter CLI
  (e.g. `gws`). Add the directory holding that binary to the server's `env.PATH`
  (above) so the app can find it. Restart the desktop app after editing the config.

The server is **read-only on the mailbox by default**: the only provider contact
it makes is `get_message`'s single inline body fetch
([ADR-0001](adr/0001-inline-enrichment-is-o1-only.md)) — unless you opted into
writes (`--enable-writes`), which adds the two mutating tools `archive_message`
and `modify_labels` ([ADR-0007](adr/0007-opt-in-mailbox-writes.md)). Everything bulk (sync,
enrich, graph build, compact) is returned to the agent as a **command
handback** — the exact `mail-index` CLI command for the agent to run itself. See
[MCP.md](MCP.md) for the full tool reference.

---

## 8. Keep the index fresh — scheduled sync

The MCP server keeps time-sensitive reads honest on its own: a stale `catch_up`
or `digest_sources` returns current data immediately **and** spawns a detached
background sync ([ADR-0005](adr/0005-stale-reads-trigger-background-sync.md)).
That is the *fallback* path. The main path is a **scheduled incremental sync**
so the index is fresh before the agent ever asks.

`mail-index status --json` is the machine-readable freshness probe for a
scheduler.

### launchd (macOS)

Save as `~/Library/LaunchAgents/com.mail-index.sync.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.mail-index.sync</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/mail-index</string>
      <string>sync</string>
      <string>--all-accounts</string>
    </array>
    <key>StartInterval</key><integer>1800</integer> <!-- every 30 min -->
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

### cron (Linux)

```cron
# every 30 minutes: incremental sync of every configured account
*/30 * * * * /usr/local/bin/mail-index sync --all-accounts >/dev/null 2>&1
```

(Optionally chain a `graph build --all-accounts` and an `enrich --profile` after
the sync on a slower cadence.)

---

## 9. Grow your index intelligently

The whole design is **metadata-wide, bodies-narrow**: index everything cheaply,
fetch full text only where it earns its place — so you get value in minutes, not
after a full sync (sizing in the table below). A sensible growth path:

1. **Start recent and cheap.** A first metadata sync runs ~50 messages/min
   (one provider call each), so don't pull years up front:
   ```sh
   mail-index sync --account acct-a --since 1mo     # minutes; searchable immediately
   ```
2. **Build structure + curate.** Let the engines find who/what matters, then tell
   it what you care about:
   ```sh
   mail-index graph build --account acct-a          # contacts, centrality, communities
   mail-index curate --account acct-a               # mark important / muted + keywords
   ```
3. **Enrich only what matters.** Bodies are fetched selectively from your curated
   profile — the index stays small:
   ```sh
   mail-index enrich --profile --account acct-a
   ```
4. **Expand the window over time.** Re-sync with a larger lookback as a background
   job; sync is incremental and idempotent, so this only fetches what's new/older:
   ```sh
   mail-index sync --account acct-a --since 6mo     # then --since 1y, or --all
   ```
5. **Let summaries keep it lean.** When your agent summarizes bulk mail
   (`save_summary`), `mail-index compact` demotes those distilled bodies to
   summary-only after a grace window — read-once newsletters cost ~0.5 KB forever
   ([ADR-0003](adr/0003-agent-written-summaries-and-body-demotion.md)).
6. **Schedule freshness** (§8) so recent mail stays current without you thinking
   about it.

**Sizing** scales with message *count*, not mailbox bytes (a 5 MB email with
attachments is still ~1.6 KB in the index); enriched bodies add ~1–3 KB each.
Measured on a real 6-month, ~8,000-message mailbox:

| Your mailbox | Index size (metadata) | First sync (one-time) |
|---|--:|--:|
| 1,000 messages | ~1.6 MB | ~15–20 min |
| 10,000 messages | ~16 MB | run as a background job |
| ~1 GB of Gmail (~9–10k msgs) | ~16 MB (**~1.5%** of mailbox) | run as a background job |

---

## 10. Privacy & data hygiene

- **Local-first.** The index, bodies, and profile never leave your machine. No
  telemetry, no account, no cloud
  ([ADR-0002](adr/0002-local-index-only-for-privacy.md)).
- **Read-only on the mailbox by default.** The tool never sends or deletes.
  Archive + label edits are an explicit opt-in (`--enable-writes`, least-
  privilege `gmail.modify`); without it the install is read-only at the token
  level. Fetching message content is always permitted.
- The index DB contains message text — treat
  `${XDG_DATA_HOME:-~/.local/share}/mail-index/` as sensitive. Optional at-rest
  encryption (OS-level FileVault / full-disk encryption) is recommended; the
  tool deliberately avoids a native crypto dependency.
- `.gitignore` excludes any `*.sqlite`, local config, and credentials.
