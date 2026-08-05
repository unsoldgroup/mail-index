# Changelog

All notable changes to **mail-index** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published version ships three artifacts from one `vX.Y.Z` tag: the npm
package (with provenance), the `mail-index.mcpb` bundle on the GitHub Release,
and the MCP Registry metadata entry. See [docs/PUBLISHING.md](docs/PUBLISHING.md).

---

## [1.5.1] — 2026-08-05

### Changed

- **MCP Registry name** is now **`io.github.unsoldgroup/mail-index`** (was
  `io.github.alunsoldantarctica/mail-index`), and `mcpName` in `package.json`
  moves with it — that field is how the registry verifies npm ownership, so the
  rename needed a published version to take effect.

  The old namespace derived from a GitHub username that **no longer exists**: the
  account was renamed, the organization rename followed, and the registry only
  grants a namespace to a live identity. Nobody could authenticate to it —
  not CI, not a human, not the original owner — so the old entry is frozen at
  1.0.0 permanently and the server is re-listed under the org, whose OIDC
  identity CI already holds.

  **No user action.** The npm package is still `mail-index`, installs and MCP
  configs are unchanged, and the tool surface is identical. Only the registry
  listing's identifier changed.

### Fixed

- Documented in [docs/PUBLISHING.md](docs/PUBLISHING.md) and the workflow itself:
  `registry-publish.yml`'s `release: [published]` trigger **never fires** for a
  Release created by `release.yml`, because GitHub refuses to start a workflow
  from an event another workflow raised with the default `GITHUB_TOKEN`. The
  registry step must be dispatched by hand after a release tag.

## [1.5.0] — 2026-08-05

**The remote Deployment release.** mail-index can now run as a single-tenant
Cloudflare Worker in an operator's own account — always-on, cron-synced, and
reachable by remote agents over MCP — alongside the unchanged local CLI + stdio
path. mail-index still operates **no hosting service**: the Worker is code you
deploy to infrastructure you own. See
[ADR-0008](docs/adr/0008-self-hosted-remote-deployment.md).

### Added — remote Deployment (Cloudflare Worker)

- **Worker MCP endpoint** (`worker/index.ts`). The whole `TOOLS` registry is
  served over streamable HTTP at `POST /mcp`, reusing the same `buildServer` /
  dispatch engine as the stdio server behind a fetch `Request`/`Response`
  transport shim. Tool names, arguments, and result shapes are identical to the
  local server — an agent cannot tell which deployment it is talking to.
- **D1 storage driver** (`src/index/`). The index layer was extracted behind an
  async `StorageDriver` interface with two implementations: `node:sqlite`
  (local, unchanged behavior) and Cloudflare D1 (remote). Migrations run on both;
  the FTS5 ranking contract is verified against D1 by the same conformance suite
  the local driver passes, so search relevance does not drift between them.
- **Gmail REST MailSource adapter** (`gmail-rest`). A third adapter alongside
  `gws` and `gog`, with an injectable `fetch` and token provider so it runs
  inside a Worker (no child processes, no CLI shell-out). Available locally too:
  `mail-index sync --source gmail-rest`.
- **Encrypted Google OAuth connect flow.** Operator-facing setup pages connect
  one or more Google accounts to a Deployment; refresh tokens are encrypted at
  rest in D1 with a Worker secret (`TOKEN_ENC_KEY`) and never logged. The
  least-privilege `gmail.modify` re-consent (the remote equivalent of
  `--enable-writes`) is a separate, explicit step — reads stay read-only by
  default, exactly as locally ([ADR-0007](docs/adr/0007-opt-in-mailbox-writes.md)).
- **Cron sync + queued Job engine.** A scheduled trigger enqueues sync → enrich →
  graph work onto a Cloudflare Queue; the consumer runs it as tracked Jobs with a
  `jobs` table. O(N) work that the local server answers with a _command
  handback_ becomes a **queued Job id** on the Worker, because there is no user
  shell to hand a command back to
  ([ADR-0009](docs/adr/0009-remote-o-n-work-is-queued-jobs.md)). `sync_status`
  reports the interval, last cron run, queue depth, and recent Jobs.
- **MCP OAuth + operator allowlist.** Remote access is authenticated with
  `@cloudflare/workers-oauth-provider`: agents complete a Google sign-in consent,
  and only identities in `OPERATOR_EMAILS` are admitted. Anonymous `POST /mcp`
  and `POST /a2a` return 401.
- **Budget-aware intelligence layer.** Graph rebuilds, cadence, and the interest
  engine run within the Worker CPU limit by chunking work across Jobs instead of
  attempting one long synchronous pass.
- **Trigger rules + signed webhooks.** D1-backed rules (`trigger_rule_save` /
  `trigger_rule_list` / `trigger_rule_delete`) are evaluated as the sync pipeline
  ingests new mail, and matches are delivered to registered consumers as signed
  webhooks with retries (`webhook_consumer_register` / `webhook_consumer_delete`).
  This is what makes a Deployment _push_ to an agent rather than only answer polls.
- **Minimal A2A surface.** An agent card plus `message/send` at `/a2a`, exposing
  recall to agent-to-agent clients that do not speak MCP.
- **Portable seed path.** `mail-index export` writes a portable dump of a local
  index; `worker/import-seed.ts` loads it into a Deployment's D1 so a new remote
  Deployment starts with the mailbox history already indexed instead of
  re-syncing from Gmail. See [docs/WORKER-SEED.md](docs/WORKER-SEED.md).
- **Localhost HTTP MCP listener** for the local server, for clients that prefer
  an HTTP transport to stdio. Binds `127.0.0.1` only.

### Added — local

- **Freshness block on every MCP response.** Every result now carries
  `freshness: { index_as_of, age_seconds, stale, syncing, refresh_command }`, so
  an agent always knows how old the answer is and how to refresh it.
  `index_as_of` is still mirrored top-level for backward compatibility.
- **Auto-refresh on any stale read.** A stale account-scoped read spawns a
  detached incremental background sync (debounced by the `sync_runs` lock).
  Previously only the `catch_up` / `digest_sources` composites did this, so a
  plain `search` could silently serve stale data. The staleness threshold moved
  from 12h to 3h. See [ADR-0005](docs/adr/0005-stale-reads-trigger-background-sync.md).
- `relay_menu_status` MCP tool.

### Fixed

- **Wedged sync locks.** A sync that crashed without closing its `sync_runs` row
  blocked every later sync for that account indefinitely (observed stuck for six
  days). `activeSyncRun` now ignores lock rows older than 6h.
- **Single-mailbox freshness.** With `account` omitted on a one-mailbox install,
  responses reported no freshness and never auto-refreshed; the sole account is
  now resolved automatically.
- **Operator sign-in to `/setup`** no longer requires completing the MCP OAuth
  flow first (#26).
- **Stale registry metadata.** `server.json` had never been bumped past `1.0.0`,
  so the MCP Registry entry advertised the launch version through four releases.
  It now tracks the
  package version, and [docs/PUBLISHING.md](docs/PUBLISHING.md) calls out that it
  carries **two** version fields.
- **Dependency audit gate.** Transitive advisories that had kept
  `pnpm audit --prod --audit-level high` red on `main` since July are cleared via
  pnpm overrides (#28).
- CI: declared the Worker bundler dependency, synced the pnpm lockfile, and
  pinned `src/mcp/server.ts`'s `node:http` usage as an audited network seam so
  the egress guard stays meaningful.

### Changed

- The GitHub organization moved to **`unsoldgroup`**; all repository URLs and
  badges updated. The MCP Registry namespace
  (`io.github.alunsoldantarctica/mail-index`) is unchanged — renaming it would
  break every installed client.
- `src/index/` call sites are now **async** throughout (the `StorageDriver`
  extraction). This is internal: the CLI, the MCP tool surface, and the on-disk
  SQLite schema are unchanged, and no local install needs migrating.

### Security

- The **local-only guarantee is unchanged** for the default deployment, and the
  egress guard ([`test/egress-guard.test.ts`](test/egress-guard.test.ts)) still
  enforces it in CI — it was _extended_, not relaxed. Every new network seam is
  named in an allow-list and nothing else in `src/` or `worker/` may touch a
  network primitive: `source/adapters/gmail-rest/runner.ts` (an **injected**
  fetch — it makes no call unless a caller supplies one, so a local `gws`/`gog`
  install never reaches Gmail directly), the localhost-bound HTTP MCP transport,
  and the Worker's own OAuth / Gmail / webhook handlers.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) gained a remote-Deployment
  section: the trust boundary an operator accepts by deploying, token-at-rest
  encryption, the operator allowlist, webhook signing, and what is deliberately
  not defended against.

### Upgrading

- **Local users:** `npm i -g mail-index@latest` (or let the launch shim
  self-update). No data migration, no config change, no re-auth.
- **New Deployments:** follow [docs/INSTALL-worker.md](docs/INSTALL-worker.md).
  A paid Workers plan is required for queued Jobs. Optionally seed D1 from an
  existing local index first — [docs/WORKER-SEED.md](docs/WORKER-SEED.md).

---

## [1.4.0] — 2026-06-25

### Added

- **Opt-in mailbox writes.** `archive` / `label` CLI commands and the
  `archive_message` / `modify_labels` MCP tools, on both the `gog` and `gws`
  adapters. Unreachable until enabled per account with
  `mail-index setup --account <email> --enable-writes` (or
  `scripts/enable-writes.sh`), which requests a least-privilege `gmail.modify`
  grant — **never** send or delete.
  See [ADR-0007](docs/adr/0007-opt-in-mailbox-writes.md).
- **Human-readable labels.** The index caches Gmail's label catalogue and
  resolves `Label_3546…` → _"Expedition Insure"_ in both directions, so labels
  render as names everywhere and `label --add/--remove` accepts a friendly name.
- `refresh_inbox` MCP tool — reconciles inbox membership against the live
  mailbox before answering, so "what's in my inbox right now" is current.

## [1.3.0] — 2026-06-25

### Added

- Lexical topic clustering (per-thread TF-IDF → thread-similarity graph → seeded
  Louvain communities) with agent-supplied cluster names.
- Deterministic sender cadence and registrable-domain normalization: "how often
  does this brand email me" became an indexed read instead of ad-hoc SQL plus a
  per-query LLM classification.

### Changed

- FTS ranking consolidated behind a single **FTS contract** module, with Porter
  stemming (`tokenize='porter unicode61'`) as the tokenizer.

## [1.2.2] — 2026-06-22

### Fixed

- **Windows `.mcpb` install.** The Claude Desktop bundle is now self-contained:
  the manifest launches `node ${__dirname}/dist/mcp/index.js` instead of shelling
  out to `npx`, and the bundle ships its own `node_modules`.

## [1.2.1] — 2026-06-17

### Fixed

- Automatic per-worktree database isolation, so two checkouts can no longer
  collide on one SQLite file. Supersedes the manual `MAIL_INDEX_DB` discipline
  introduced in 1.2.0.

## [1.2.0] — 2026-06-17

### Added

- `MAIL_INDEX_DB` for explicit index-file selection.
- Opt-out self-update shim (`bin/selfupdate.mjs`, throttled npm version check,
  disable with `MAIL_INDEX_NO_AUTOUPDATE=1`) — audited by the egress guard so the
  no-network-in-`src/` invariant still holds.

## [1.1.0] — 2026-06-17

### Added

- Agent-findability: MCP server instructions plus a bundled Skill, so agents
  reach for the mailbox without being told a connector exists.

## [1.0.0] — 2026-06-17

First published release: progressive sync, the correspondence graph, the
interest engine, curation, the full MCP tool surface, and the write-back loops —
on [npm](https://www.npmjs.com/package/mail-index), as a `.mcpb` bundle, and in
the [MCP Registry](https://registry.modelcontextprotocol.io).

[1.5.1]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.5.1
[1.5.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.5.0
[1.4.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.4.0
[1.3.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.3.0
[1.2.2]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.2.2
[1.2.1]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.2.1
[1.2.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.2.0
[1.1.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.1.0
[1.0.0]: https://github.com/unsoldgroup/mail-index/releases/tag/v1.0.0
