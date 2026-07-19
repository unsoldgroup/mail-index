# Threat model

mail-index indexes a mailbox into either a local database or an opt-in,
single-tenant remote Deployment owned by the operator. It touches sensitive data
(your email), so this document
states plainly what it protects, what it does **not**, where the trust boundaries
are, and how you can verify the claims yourself ([SECURITY.md](../.github/SECURITY.md#verify-our-claims-yourself)).

## Assets

- **The index** (`${XDG_DATA_HOME:-~/.local/share}/mail-index/mail.sqlite`) —
  message metadata, distilled bodies, and summaries. Plaintext SQLite.
- **The curated profile** — who/what you marked important (in the same DB).
- **Provider credentials** — locally, tokens stay in the adapter's store. A
  remote Deployment necessarily holds encrypted Google refresh tokens as
  described below.

## Trust boundaries & data flow

```
  Gmail API                ┌───────────────── your machine ─────────────────┐
 (googleapis.com)          │                                                 │
      ▲                    │   ingest ─► SQLite index ─► engines (graph,     │
      │  read-only         │     ▲        (local file)     interest, search) │
      │  list / get        │     │                              │            │
 ┌────┴─────┐  spawn       │ ┌───┴─────────┐              ┌─────┴──────┐     │
 │ gws CLI  │◄─────────────┼─┤  adapter    │              │ CLI / MCP  │◄────┼─ your agent
 │(adapter) │              │ │ (1 file)    │              │  server    │     │   (your LLM)
 └──────────┘              │ └─────────────┘              └────────────┘     │
   the ONLY                │   no network                   no network       │
   network egress          └─────────────────────────────────────────────────┘
```

**The egress boundary is one process spawn.** The mail-index *core* (`src/`)
makes no network calls of any kind. The only way the core reaches the network is
by spawning the provider adapter CLI (the gws adapter, `src/source/adapters/gws/runner.ts`).
This is enforced as a build-breaking test ([`test/egress-guard.test.ts`](../test/egress-guard.test.ts)):
CI fails if any network primitive (`fetch`, `node:http/https/net`, a network
library, a telemetry SDK) appears anywhere in `src/`, or if a process is spawned
outside the audited seams (the adapter, and the MCP server's detached re-exec
of mail-index's own `sync` CLI per [ADR-0005](adr/0005-stale-reads-trigger-background-sync.md)).
This guard governs *network egress and spawn seams* — not read-vs-mutate. The
opt-in archive/label writes ([ADR-0007](adr/0007-opt-in-mailbox-writes.md)) flow
through the *same* adapter spawn seam, so they pass the guard unchanged; whether
a write can happen at all is enforced one layer up, at the OAuth scope (a default
`gmail.readonly` grant cannot mutate).

**One auditable self-update seam, quarantined outside the core.** The launch
shim (`bin/`) performs an optional, throttled (once / 24h), opt-out self-update
check: it asks the npm registry whether a newer `mail-index` is published and, if
so, updates the install for the *next* launch (it never touches the running
process, so the core never gains network access at runtime). This is the only
other network seam, and it is deliberately kept out of `src/` so the core stays
provably egress-free. The egress guard scans `bin/` too and pins network access
to exactly one file (`bin/selfupdate.mjs`) and spawning to the updater plus the
launcher that fires it. Disable entirely with `MAIL_INDEX_NO_AUTOUPDATE=1`.

## What mail-index protects

- **No exfiltration by the tool.** It has no network egress of its own and no
  telemetry/analytics — verifiable by the egress guard and a 4-package, pure-JS
  dependency tree.
- **No mailbox mutation by default — and never send/delete.** A standard install
  is read-only at the token level (`gmail.readonly`): the adapter calls only
  `messages.list` / `messages.get`, and the mutation seam is unreachable.
  Archive + label edits are an explicit OPT-IN gated on a separate, least-
  privilege `gmail.modify` re-auth (`mail-index setup --enable-writes`), exposed
  as two clearly-marked tools (`archive_message` / `modify_labels`). Even opted
  in, the tool can only archive/relabel — it requests no `gmail.send` and no
  delete scope ([ADR-0007](adr/0007-opt-in-mailbox-writes.md), [ADR-0001](adr/0001-inline-enrichment-is-o1-only.md)).
- **Local Deployment credential isolation.** Tokens are the adapter's concern
  and never enter the local index DB.
- **Operator-owned placement.** Local data stays on the machine. Remote data
  stays in the operator's own Cloudflare account; mail-index operates no hosting
  service ([ADR-0008](adr/0008-self-hosted-remote-deployment.md)).

## What it does NOT protect against (non-goals)

- **A compromised machine or OS.** The index is plaintext SQLite; anyone with read
  access to your data dir can read indexed mail. Use full-disk encryption
  (FileVault/LUKS) or an encrypted volume; SQLCipher is an opt-in you layer on.
- **A malicious or careless agent you connect.** mail-index returns mail content
  to *your* agent; it cannot police what that agent (or the other tools you give
  it) does with the content. Connect it alongside tools you trust.
- **Prompt injection of your agent.** Email is attacker-controlled input. A
  crafted message could try to manipulate the LLM reading it. mail-index's stance:
  it returns email strictly as **data**, has **no** write/exfiltration tools, and
  builds every command-handback from **fixed code templates — never from message
  content** — so injected text cannot make mail-index act or forge a command. The
  residual risk lives in your agent and its *other* tools; treat all returned mail
  as untrusted content.
- **Supply-chain compromise of Node or dependencies.** Mitigated, not eliminated:
  minimal deps, committed lockfile, `--ignore-scripts` installs (no postinstall),
  CI dependency audit + secret scan, and SHA-pinned GitHub Actions.

## Permissions / least privilege

mail-index reads by default. Grant a **read-only** provider scope (for Gmail,
`https://www.googleapis.com/auth/gmail.readonly`). Only explicit archive/label
actions use the separately consented `gmail.modify` scope; send/delete scopes
are never requested.

## Remote Deployment: widened trust boundary

The optional Worker changes the promise from “never leaves your machine” to
“never leaves infrastructure you own.” Mailbox data, Summaries, curation, and
Interest profiles rest in D1 under the operator’s Cloudflare account. Cloudflare
encrypts D1 at rest, but Cloudflare and the security of that account are now in
the trusted computing base. This is a materially wider posture than plaintext
SQLite on an encrypted local disk.

The Worker holds Google refresh-token ciphertext in D1. Tokens use AES-GCM; the
key exists only as the `TOKEN_ENC_KEY` Worker secret. A D1 export alone cannot
decrypt them. The operator supplies and controls the Google OAuth client. The
default grant is `gmail.readonly`; `gmail.modify` is a separate explicit
re-consent and still cannot send or delete mail.

The audited remote seams are the Gmail REST adapter, D1 StorageDriver, and
webhook delivery in the queue consumer. Webhook HTTP runs in `worker/`, not the
guarded engine. `src/` remains network-free except the explicitly pinned serving
and adapter seams; [`test/egress-guard.test.ts`](../test/egress-guard.test.ts)
fails when a new primitive appears or a named seam silently moves. This makes
egress reviewable, not harmless.

MCP and A2A are reachable over the network. The OAuth provider authenticates
bearer tokens, Google sign-in is restricted to `OPERATOR_EMAILS`, and that
single-tenant allowlist is the complete authorization model. A mistaken
allowlist entry has access to the exposed index tools. The public agent card and
health endpoint contain discovery/health metadata, never mailbox rows.

Trigger rule consumers are operator-chosen trusted endpoints. Deliveries carry
`X-MailIndex-Signature: sha256=<HMAC>` over the raw body and a Unix timestamp;
consumers must reject timestamps outside five minutes and deduplicate the stable
`delivery_id`. Queues provide at-least-once delivery, so duplicates are expected.
HTTPS protects transit; the consumer controls data after receipt.

Compromise impact is component-specific:

- Cloudflare account: an attacker can read index data, alter Worker code or
  secrets, and therefore recover live Google tokens and impersonate the service.
- D1 alone: an attacker gets indexed mail, earned state, consumer HMAC secrets
  (and can forge deliveries to those consumers), plus unusable Google-token
  ciphertext, but not the Worker encryption key.
- Google OAuth client secret alone: an installed/web client secret is not a
  refresh token; existing grants remain protected, though phishing/flow abuse is
  possible and the client should be rotated.
- Consumer endpoint or its HMAC secret: an attacker can read that consumer’s
  delivered matches and forge future-looking deliveries to it; this does not
  grant MCP, D1, or Gmail access.

## Integrity & releases

The npm package is published with **provenance** (a signed attestation linking
the artifact to this repo + the building workflow), from a SHA-pinned GitHub
Actions release. See [PUBLISHING.md](PUBLISHING.md). Verify with
`npm audit signatures` after install.

## Reporting

Security issues: see [SECURITY.md](../.github/SECURITY.md) — please report privately
rather than opening a public issue.
