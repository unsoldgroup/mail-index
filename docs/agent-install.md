# Agent install runbook — mail-index with your own Google OAuth client

**Audience: an AI agent setting up mail-index for its user, on the user's machine, using the user's *own* Google Cloud OAuth client (a personal project).** This is the bring-your-own-client path — no shared/beta client, no ~100-user cap, no dependency on anyone else's app. The user owns the app; nothing is rate-limited or gated by a third party.

The agent does everything it can. **Two steps require the human** — they cannot be automated by any CLI/API and are marked **🧑 HUMAN STEP**:
1. Creating the Google Cloud OAuth client in the Cloud Console (Google provides no API for Desktop clients or external consent screens).
2. Completing the browser sign-in (OAuth consent).

Run the steps in order. **After every step, run its `verify` and do not proceed until it passes.** If a verify fails, see **Troubleshooting**.

---

## Step 0 — Preconditions

```sh
node --version        # must be >= 24
uname -s              # Darwin = macOS, Linux = Linux; on Windows use PowerShell
```

- **Node < 24 or missing:** install Node 24+ (macOS: `brew install node`; Windows: `winget install OpenJS.NodeJS.LTS`; Linux: distro/nvm). Re-verify.

**verify:** `node --version` prints `v24.` or higher.

---

## Step 1 — Install the `gog` adapter CLI

mail-index reads Gmail by shelling out to [`gog`](https://github.com/openclaw/gogcli).

```sh
# macOS
brew install openclaw/tap/gogcli
# Windows (PowerShell): download gog.exe from the latest release and add it to PATH
#   https://github.com/openclaw/gogcli/releases  (gogcli_<ver>_windows_amd64.zip)
# Linux: download the linux release tarball, put `gog` on PATH
```

**verify:** `gog --version` prints a version (e.g. `0.16.0`). If `command not found`, gog isn't on `PATH` — fix `PATH`, re-verify.

---

## Step 1b — Configure gog for unattended use (file keyring) ⚠️ do this before auth

By default gog stores tokens in the **OS keychain** (macOS Keychain / Windows
Credential Manager), which pops an interactive "Always Allow" prompt the first
time a *different* process reads the token. A solo agent has no one to click it,
so it would stall. Switch gog to the **file keyring** so every gog call —
including the agent's own verify calls and the headless MCP server — works with
no prompt.

```sh
# 1. Generate a strong keyring password once and store it for the user.
mkdir -p ~/.config/mail-index
test -f ~/.config/mail-index/gog-keyring.pass || \
  (head -c 32 /dev/urandom | base64 > ~/.config/mail-index/gog-keyring.pass && \
   chmod 600 ~/.config/mail-index/gog-keyring.pass)

# 2. Export for THIS session (every gog command below inherits these).
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD="$(cat ~/.config/mail-index/gog-keyring.pass)"

# 3. Persist for future interactive/cron shells (append once; idempotent).
grep -q GOG_KEYRING_BACKEND ~/.zshrc 2>/dev/null || cat >> ~/.zshrc <<'RC'
# mail-index: gog file keyring (unattended, no OS-keychain prompt)
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD="$(cat ~/.config/mail-index/gog-keyring.pass)"
RC
```
(Use `~/.bashrc` if the user's shell is bash; on Windows set them as user
environment variables via `setx GOG_KEYRING_BACKEND file` etc.)

> The MCP server also spawns gog, so these two vars **must** be in its
> environment too — Step 8 wires them into the MCP client config's `env`.

**verify:** `gog auth status` reports `keyring_backend file` (not `auto`/`keychain`).

---

## Step 2 — Install mail-index

```sh
# From source (current — npm package not yet published):
git clone https://github.com/unsoldgroup/mail-index.git
cd mail-index && pnpm install && pnpm build
# invoke as `node dist/cli/index.js <command>`; symlink onto PATH for the bare `mail-index`.
# Once published: `npm install -g mail-index` gives the `mail-index` + `mail-index-mcp` bins.
```

**verify:** `node dist/cli/index.js --help` prints usage (or `mail-index --help` if symlinked/installed).

---

## Step 3 — 🧑 HUMAN STEP: create the user's Google Cloud OAuth client

The agent **cannot** do this (console-only). Present these exact instructions to the user and wait for them to return the downloaded `client_secret.json` path.

> **Do this once in your browser (~10 min). You are creating your *own* private app — only you will use it.**
>
> 1. **Create a project:** https://console.cloud.google.com/projectcreate → name it `mail-index` → Create. Select it in the top project picker.
> 2. **Enable the Gmail API:** https://console.cloud.google.com/apis/library/gmail.googleapis.com → **Enable**.
> 3. **Consent screen / Branding:** https://console.cloud.google.com/auth/branding
>    - App name: `mail-index` · User support email: *your email* · Developer contact: *your email*.
>    - **Audience: External.** Publishing status: **Testing**.
>    - Under **Audience → Test users → Add users**, add **your own Gmail address** (the mailbox you'll index). *(Testing mode only lets listed test users sign in — this is required.)*
>    - Under **Data access → Add scopes**, add exactly: `https://www.googleapis.com/auth/gmail.readonly`
> 4. **Create the client:** https://console.cloud.google.com/auth/clients → **Create client** → Application type **Desktop app** → name `mail-index desktop` → Create → **Download JSON**.
> 5. Tell the agent the path to the downloaded file (e.g. `~/Downloads/client_secret_*.json`).

**Why it's your own app:** Google requires the Console for Desktop OAuth clients + external consent screens — there is no API (`gcloud`/`gws` can't do it). Because it's *your* app in Testing mode, there's no verification/CASA and no shared-quota concern; the ~100-test-user cap is irrelevant for personal use.

**verify (agent):** the path the user gave exists and is a Google client JSON:
```sh
test -f "<PATH>" && grep -q '"installed"' "<PATH>" && echo "client json OK"
```
(A Desktop client JSON has a top-level `"installed"` object with `client_id` + `client_secret`. For a Desktop/installed app this secret is non-confidential by Google's design, but still don't print it or commit it.)

---

## Step 4 — Register the client with gog

Store it under a named gog client so it never collides with any other gog setup the user has:

```sh
gog auth credentials set "<PATH>" --client mail-index
```

**verify:** `gog auth credentials list` shows a `mail-index` client row.

---

## Step 5 — 🧑 HUMAN STEP: authenticate the mailbox (browser sign-in)

Run this; it opens the system browser. **The user must pick the *same* Gmail account they added as a test user** (an account mismatch is rejected):

```sh
gog auth add <user-email> --client mail-index --services gmail --gmail-scope=readonly
```

The user approves the "unverified app — mail-index" screen (expected) and grants **read-only** Gmail. A successful run ends with `email  <user-email>` / `client  mail-index` and no `expected …` mismatch line.

**verify:** the account is authorized **and** a live read-only call works (with the file keyring from Step 1b this needs no keychain prompt, from any process):
```sh
gog gmail messages search "newer_than:7d" -a <user-email> --client mail-index -j --max 1
```
Expect JSON with a `messages` array. If it says `No auth for gmail …`, the sign-in didn't persist — confirm `GOG_KEYRING_BACKEND=file` + `GOG_KEYRING_PASSWORD` were exported before `gog auth add`, then redo this step.

---

## Step 6 — Scaffold mail-index config

```sh
mail-index init      # idempotent: creates ~/.config/mail-index/config.json + data dir if absent
```

Then ensure the config has a `gog` account for this mailbox. Edit `~/.config/mail-index/config.json` (XDG: `${XDG_CONFIG_HOME:-~/.config}/mail-index/config.json`) so `accounts` contains:

```jsonc
{
  "accounts": {
    "<label>": {
      "adapter": "gog",
      "account": "<user-email>",
      "syncPolicy": { "since": "1mo", "includeSent": true }
    }
  }
}
```
- `<label>` is a short stable name (e.g. `personal`). **Do not clobber existing accounts** — merge this entry in.
- The account is keyed by email (gog), not a config dir (that's gws).

> ⚠️ **gog + XDG gotcha:** gog *also* reads `XDG_CONFIG_HOME`. If you run mail-index with a custom `XDG_CONFIG_HOME`, gog looks for its credentials at `$XDG_CONFIG_HOME/gogcli/` and won't find the client you set above. For a normal install (default XDG) this is a non-issue; only relevant if you sandbox the data dir.

**verify:**
```sh
mail-index status --json     # parses without error; the <label> account is listed (0 messages so far)
```

---

## Step 7 — First sync + confirm recall

```sh
mail-index sync --account <label> --since 1mo
```
Phase-1 sync fetches **metadata only** (~50 msgs/min). Then confirm the index answers:

```sh
mail-index status                       # shows message + contact counts > 0
mail-index search "<a term you expect>" # returns ranked hits
```

**verify:** `status` shows `messages: N` with N > 0, and `search` returns at least one hit for a term you know is in the mailbox.

---

## Step 8 — Connect the MCP server to the agent

Register the stdio server with the user's MCP client.

**Claude Code (agent-executable — preferred for this runbook):** one command, no file editing. Point it at the built server (use `npx -y -p mail-index mail-index-mcp` once the package is published).
```sh
claude mcp add --transport stdio \
  --env GOG_KEYRING_BACKEND=file \
  --env GOG_KEYRING_PASSWORD="$(cat ~/.config/mail-index/gog-keyring.pass)" \
  mail-index -- node /abs/path/to/mail-index/dist/mcp/index.js
claude mcp list      # verify 'mail-index' is listed
```

**Claude Desktop:** there is **no install URL/deep link** for MCP. A one-click `.mcpb` bundle is *planned* (not yet released); until then, configure it manually below.

**Manual config (any MCP client):** the MCP server spawns `gog`, so it needs the file-keyring vars from Step 1b in its `env` — desktop apps launch with a minimal environment and won't inherit your shell's, so set them explicitly:

```jsonc
{
  "mcpServers": {
    "mail-index": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/mail-index/dist/mcp/index.js"],
      "env": {
        "PATH": "/dir/with/gog:/usr/local/bin:/usr/bin:/bin",
        "GOG_KEYRING_BACKEND": "file",
        "GOG_KEYRING_PASSWORD": "<contents of ~/.config/mail-index/gog-keyring.pass>"
      }
    }
  }
}
```
(If `mail-index-mcp` is on the launcher's `PATH` you can use `"command": "mail-index-mcp"` instead of the node+args form — but still include the `GOG_KEYRING_*` env, or the server's inline body fetch will fail with `No auth`.)

**verify:** restart the MCP client; the `mail-index` tools appear (e.g. `search`, `get_message`). A `search` call returns hits.

---

## Done

The mailbox is indexed locally and queryable by the agent over MCP — read-only, local-first, on the user's own OAuth client. To keep it fresh, schedule `mail-index sync --account <label>` (launchd/cron/Task Scheduler); see [INSTALL.md §8](INSTALL.md#8-keep-the-index-fresh--scheduled-sync). To grow coverage, re-sync with a wider `--since` later (incremental + idempotent).

---

## Troubleshooting (real failure modes)

| Symptom | Cause → fix |
|---|---|
| `gog auth add` → **`Error 400: redirect_uri_mismatch`** | No client configured for gog. Do **Step 4** (`gog auth credentials set … --client mail-index`) first. Desktop clients auto-allow the loopback redirect once set. |
| Browser → **"Access blocked / app not verified"** with no continue | The signing-in account isn't a **test user**. Add it under Console → Audience → Test users (Step 3.3), retry. |
| `authorized as X, expected Y` | Wrong account picked in the browser. Re-run Step 5 and choose the account that matches `<user-email>`. |
| `No auth for gmail …` right after a successful `auth add` | The **file keyring (Step 1b) wasn't active** when you authed — `GOG_KEYRING_BACKEND=file` + `GOG_KEYRING_PASSWORD` must be exported *before* `gog auth add`. Confirm `gog auth status` shows `keyring_backend file`, re-export, redo Step 5. (If you skipped Step 1b and used the OS keychain, this is the Keychain "Always Allow" ACL — which is exactly why Step 1b exists.) |
| `Ineligible accounts … not eligible as a test user` | Usually the consent screen is **Internal** (org-only) — switch **Audience → External**; then a personal Gmail is eligible. |
| Bodies look like `=E2=80=8B` / `&zwnj;` mojibake | Known distiller limitation with quoted-printable / HTML-entity bodies (tracked separately); does not block sync/search. |
| Offer/price seems missing from a message body | It's likely inside an image. `get_message` returns `ocr_images` + `needs_ocr=true` — the agent reads those images itself (mail-index does no OCR). |

---

## Uninstall

Clean teardown, most-specific to least. Steps 1–5 fully remove mail-index and its
access; 6–8 are optional (only if the user also wants gog/the CLI/the Google app
gone). One **🧑 HUMAN STEP** — revoking the Google grant — is the authoritative
"this app can no longer read my mail." Run in order; nothing here touches the
mailbox itself (it was always read-only).

**1. Remove the MCP server from the agent's client.** Delete the `mail-index`
entry from the MCP client config (the `mcpServers` block added in Step 8) and
restart the client.

**2. Stop any scheduled sync.** Remove the launchd plist / cron line / Windows
Task you added for `mail-index sync` (see INSTALL.md §8). e.g. macOS:
`launchctl unload ~/Library/LaunchAgents/com.mail-index.sync.plist && rm ~/Library/LaunchAgents/com.mail-index.sync.plist`.

**3. Delete the local index + config** (the only places mail-index stores data —
message metadata/bodies, your config, the keyring password):
```sh
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/mail-index"     # index DB
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/mail-index"         # config + gog-keyring.pass
```
**verify:** `mail-index status` errors with "no operator config" (nothing left to read).

**4. Remove gog's mail-index client + its stored token.** Removes the named
OAuth client and (with the file keyring) its token file:
```sh
gog auth credentials remove mail-index
```
**verify:** `gog auth credentials list` no longer shows a `mail-index` row, and
`gog auth list --client mail-index -j` → `{"accounts":[]}`.
(If you used the OS keychain instead of Step 1b, also delete the `gogcli`
items in Keychain Access / Windows Credential Manager.)

**5. 🧑 HUMAN STEP — revoke the Google grant.** This is what actually cuts off
access (removing local tokens just stops *this* machine):
> Go to **https://myaccount.google.com/permissions**, find **"mail-index"**, and
> click **Remove access**.

**6. (Optional) Uninstall the keyring shell lines.** Remove the
`GOG_KEYRING_BACKEND` / `GOG_KEYRING_PASSWORD` block Step 1b appended to
`~/.zshrc` (or `~/.bashrc`); on Windows `setx GOG_KEYRING_BACKEND ""` etc.

**7. (Optional) Uninstall the CLIs** — only if nothing else uses them:
```sh
npm uninstall -g mail-index
brew uninstall openclaw/tap/gogcli      # macOS; Windows: delete gog.exe from PATH
```

**8. (Optional) Delete the Google Cloud project.** If the user is done with the
OAuth app entirely: Console → **IAM & Admin → Settings → Shut down**, or
https://console.cloud.google.com/cloud-resource-manager (select the project →
Delete). Not required — an unused Testing-mode project costs nothing.

**verify (full removal):** `command -v mail-index` is empty (if step 7 run),
`mail-index status` errors, the agent's MCP client no longer lists `mail-index`
tools, and Google account permissions no longer shows the app.
