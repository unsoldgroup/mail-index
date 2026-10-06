# Security & Privacy

mail-index handles one of the most sensitive datasets a person has — their
mailbox. Its design reflects that.

## Privacy posture (by design)

- **Local-first.** The index, message bodies, summaries, and your curated profile
  live in a single SQLite file on your machine
  (`${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`) and never leave it.
  No cloud, no account, no telemetry, no hosted option ([ADR-0002](docs/adr/0002-local-index-only-for-privacy.md)).
- **Read-only on the mailbox by default.** A standard install never sends,
  deletes, labels, or archives mail — its only provider traffic is read fetches,
  and it is read-only at the token level (`gmail.readonly`, see below). The tool
  never sends or deletes mail at all. Archive + label edits are an explicit
  OPT-IN: they exist only after you re-authorize with the least-privilege
  `gmail.modify` scope (`mail-index setup --enable-writes`), and are exposed as
  two clearly-marked tools/commands — `archive_message`/`modify_labels` and
  `mail-index archive`/`label` ([ADR-0007](docs/adr/0007-opt-in-mailbox-writes.md)).
- **No third-party calls, no bundled LLM.** All language work (summaries,
  categorization) is done by *your* agent via MCP and written back; the tool
  itself calls no inference API ([ADR-0004](docs/adr/0004-all-intelligence-from-the-users-llm.md)).
- **The tool ships none of your data.** This repo is the generic tool; your
  accounts, OAuth app, and curated profile are private operator config kept in
  your own dotfiles ([PLAN §2](docs/PLAN.md)). `.gitignore` excludes
  `*.sqlite`, credentials, `*.env`, and `*.local.md`.

## Treat the index as sensitive

`mail.sqlite` contains real message text. Treat
`~/.local/share/mail-index/` as sensitive data:

- Rely on full-disk encryption (FileVault / LUKS), or place the data dir on an
  encrypted volume. At-rest DB encryption (e.g. SQLCipher) is an opt-in you can
  layer on; it is not bundled (it would add a native dependency).
- Never commit the DB, your operator `config.json`, or `*.local.md` files.

## Credentials & least privilege

OAuth tokens and client secrets are the **adapter's** concern and live in the
provider tool's own store (for the gws adapter, its per-account config dir) —
never in this repo and never in the index DB. Never paste tokens into issues
or PRs.

By default mail-index only ever **reads**, so grant the adapter a **read-only**
provider scope. For Gmail that's
`https://www.googleapis.com/auth/gmail.readonly` — sufficient for everything the
default tool does, and it makes "this can't modify my mail" true at the token
level, not just by convention.

If you opt into archive + label edits (`mail-index setup --enable-writes`), the
adapter additionally requests the least-privilege
`https://www.googleapis.com/auth/gmail.modify` scope — which permits archiving
and relabelling but **not** sending or permanently deleting mail. We never
request `gmail.send` or full `https://mail.google.com/`. Writes still flow
through the same audited adapter seam, so the local-only / zero-egress guarantee
below is unaffected.

## Don't trust us — verify

Every claim here is checkable. The whole posture is also kept honest in CI: the
egress guard ([`test/egress-guard.test.ts`](test/egress-guard.test.ts)) fails the
build if any network primitive appears in `src/`, a dependency audit + a gitleaks
secret scan run on every push ([`.github/workflows/security.yml`](.github/workflows/security.yml)),
and installs use `--ignore-scripts` (no dependency postinstall runs).

There is exactly one network seam outside the provider boundary, and it is
quarantined out of the core: the launch shim's self-updater (`bin/selfupdate.mjs`)
makes a throttled (once / 24h) request to the npm registry to check for a newer
release, applied on the next launch. It is opt-out (`MAIL_INDEX_NO_AUTOUPDATE=1`)
and the egress guard audits `bin/` too, pinning network access to that one file.

To confirm it yourself:

```sh
# 1. It doesn't phone home. Watch egress while you sync — you should see traffic
#    ONLY to the provider (Google). The opt-out self-updater also contacts the
#    npm registry (once/24h); set MAIL_INDEX_NO_AUTOUPDATE=1 and you'll see
#    nothing but the provider. (macOS: Little Snitch / lsof; Linux: ss/tcpdump.)
sudo lsof -i -nP -p "$(pgrep -f mail-index | head -1)"     # while a sync runs

# 2. No network calls in the tool's own code (the egress guard, run directly):
node --test test/egress-guard.test.ts

# 3. Tiny, auditable, script-free supply chain:
cat package.json | grep -A6 '"dependencies"'   # 4 pure-JS packages
pnpm audit --prod --audit-level high            # no known vulnerabilities
pnpm install --ignore-scripts                   # nothing needs a postinstall

# 4. Read-only: the MCP server exposes no send/label/delete tools — list them:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | mail-index-mcp | grep -o '"name":"[a-z_]*"'

# 5. (After the first published release) verify the npm artifact's provenance:
npm audit signatures
```

The full trust boundaries, prompt-injection stance, and non-goals are in
**[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**.

## Reporting a vulnerability

Please report security issues privately to the maintainer via
**[unsold.group/al](https://unsold.group/al)** rather than opening a public
issue. You'll get an acknowledgement and a fix timeline. Thanks for disclosing
responsibly.

## Optional private SENT-evidence service

The optional remote Worker includes a disabled private Google SENT reader.
Its empty code policy and durable link registry deny reads until separately
provisioned. It exposes no public mailbox-read route and adds no send capability.
The local index is not its evidence source. See the
[threat model](../docs/THREAT-MODEL.md) and
[service contract](../docs/STAFF-SENT-EVIDENCE.md) for caller, identity, grant,
challenge and byte-bound controls; activation requires explicit operator setup.
