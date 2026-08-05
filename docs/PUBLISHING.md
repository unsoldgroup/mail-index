# Publishing — npm + the MCP Registry

The official [MCP Registry](https://registry.modelcontextprotocol.io) hosts only
_metadata_; the runnable artifact must live on **npm** first. So publishing is
two steps: (1) publish the npm package, (2) publish `server.json` to the registry.

**Both steps are automated in CI** and fire from a single pushed `vX.Y.Z` tag —
jump to [Releasing new versions](#releasing-new-versions) for the normal path.
Steps 1 and 2 below document the manual equivalents: they are the fallback when
CI is unavailable, and the reference for what CI is actually doing. Only a
maintainer can push the tag, and only a maintainer holds `NPM_TOKEN` — the
release trigger stays human.

## Prerequisites

- An **npm account** (`mail-index` and `@alunsoldantarctica/mail-index` were both
  free as of prep — unscoped `mail-index` is configured).
- A **GitHub account** in the `alunsoldantarctica` namespace (it owns the
  `io.github.alunsoldantarctica/*` registry namespace via OIDC).
- Node 24+ and `pnpm`.

## What's already set up

- `package.json`: `"private": false`, `"publishConfig": { "access": "public" }`,
  `"mcpName": "io.github.alunsoldantarctica/mail-index"` (the registry ownership
  check), `"files": ["dist"]`, both bins, and `prepublishOnly: tsc` (builds
  `dist/` before publish).
- `server.json`: the registry manifest. Note the `runtimeArguments` — they make a
  client launch the **MCP** bin, not the CLI: `npx -y -p mail-index mail-index-mcp`
  (the package ships two bins, `mail-index` and `mail-index-mcp`).

## Step 1 — publish to npm

```sh
pnpm install
pnpm build            # also runs via prepublishOnly
pnpm test             # green gate before shipping
npm login             # your npm account + 2FA  (use `npm`, not pnpm, for auth)
npm publish           # publishes unscoped public `mail-index@1.0.0`
```

Verify: `npm view mail-index version` → `1.0.0`, and `npx -y -p mail-index mail-index-mcp`
should start the stdio server (Ctrl-C to exit).

## Step 2 — publish to the MCP Registry

Install the publisher CLI:

```sh
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
sudo mv mcp-publisher /usr/local/bin/
mcp-publisher --help
```

Then, from the repo root:

```sh
# (optional) regenerate a schema-current template and re-apply our runtimeArguments:
# mcp-publisher init
mcp-publisher login github      # opens a browser; authorizes the alunsoldantarctica namespace
mcp-publisher publish server.json
```

Verify:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.alunsoldantarctica/mail-index"
```

## Dual-bin note (read before publishing)

mail-index ships **two** bins — `mail-index` (CLI) and `mail-index-mcp` (server).
Plain `npx mail-index` runs the CLI, so `server.json` uses `runtimeArguments` to
launch `mail-index-mcp` explicitly. If a consuming client doesn't honor those
args, the reliable fallback for users is a global install + the documented config:

```sh
npm i -g mail-index
# agent config: { "mcpServers": { "mail-index": { "command": "mail-index-mcp" } } }
```

After a real client test confirms the registry launch, no change is needed. If it
proves fiddly, the clean long-term fix is to make `mail-index-mcp` the package's
default bin (or split the CLI into a subcommand).

## Other directories (optional, after npm publish)

Once on npm, these directories accept a submission or auto-index from the registry
and let you specify the exact launch command:
[Smithery](https://smithery.ai), [PulseMCP](https://www.pulsemcp.com),
[mcp.so](https://mcp.so), [Glama](https://glama.ai/mcp/servers). Use the
`mail-index-mcp` command (global install) or `npx -y -p mail-index mail-index-mcp`.

## Provenance (recommended over a local `npm publish`)

For a verifiable supply chain, publish from CI with **npm provenance** rather
than from your laptop. The repo ships
[`.github/workflows/release.yml`](../.github/workflows/release.yml): pushing a
`vX.Y.Z` tag builds, tests, and runs `npm publish --provenance --access public`
with GitHub OIDC, producing a signed attestation that links the published
tarball to this repo and the exact workflow run. Consumers verify with:

```sh
npm audit signatures
```

One-time setup: add an **`NPM_TOKEN`** (automation token) repo secret. Then:

```sh
# bump version in BOTH package.json and server.json first, commit, then:
git tag v1.0.0 && git push origin v1.0.0     # → triggers the release workflow
```

A local `npm publish` (Step 1 above) still works but produces **no** provenance —
prefer the tagged CI release for anything public.

## The `.mcpb` bundle (GitHub Release asset)

mail-index also ships as a one-file **MCP bundle** (`mail-index.mcpb`, produced by
`pnpm bundle` → `mcpb pack`). The tagged release workflow
([`release.yml`](../.github/workflows/release.yml)) now packs it and attaches it to
the tag's **GitHub Release** (via `softprops/action-gh-release`), so every
published version has a downloadable, double-click-installable bundle alongside the
npm tarball. This needs `contents: write` on the job (already set).

Build it locally to inspect before tagging:

```sh
pnpm bundle            # → ./mail-index.mcpb
```

### What is NOT done (deliberately out of scope)

The release flow stops at an **unsigned** `.mcpb`. The following are _not_ wired up
because they require maintainer-held credentials / hardware and run out of band:

- **Apple Developer-ID signing + notarization** of the bundle (needs an Apple
  Developer account, a Developer-ID certificate, and `notarytool` credentials).
  Without it, macOS Gatekeeper will warn on the bundle.
- **Windows Authenticode signing** (needs a code-signing certificate).
- The **actual `npm publish`** and the **`.mcpb` Release** only happen when a
  maintainer pushes a real `vX.Y.Z` tag with `NPM_TOKEN` configured — CI never
  publishes on its own; pushing the tag is the human trigger.

If/when certificates are available, add signing steps after `pnpm run bundle` and
before the upload (sign → `notarytool submit --wait` → `stapler staple` on macOS;
`signtool` on Windows).

## Releasing new versions

The whole release is **one pushed tag**. Nothing else is interactive.

```sh
# 1. Bump the version in THREE files (see the trap below), update CHANGELOG.md,
#    commit on a branch, open a PR, merge to main.
# 2. From an up-to-date main:
git tag v1.5.0 && git push origin v1.5.0
```

That tag fires [`release.yml`](../.github/workflows/release.yml), which builds,
tests, `npm publish --provenance`, packs `mail-index.mcpb`, and creates the
GitHub Release with the bundle attached. Publishing that Release fires
[`registry-publish.yml`](../.github/workflows/registry-publish.yml), which
authenticates to the MCP Registry with **GitHub OIDC** (no interactive
`mcp-publisher login`) and publishes `server.json`. The manual `mcp-publisher`
flow in Step 2 above is now only a fallback for republishing metadata without a
release — `workflow_dispatch` does the same thing from the Actions tab.

> [!IMPORTANT]
> **Four version fields, three files.** `package.json` (1), `manifest.json` (the
> `.mcpb` manifest, 1), and `server.json` (**2** — the top-level `version` _and_
> `packages[0].version`, which must equal the npm version). Miss one and the
> registry advertises a version that does not exist on npm; that is exactly how
> the registry entry sat at `1.0.0` through v1.4.0. Verify before tagging:
>
> ```sh
> grep -n '"version"' package.json manifest.json server.json
> ```

The version tag, npm auth (`NPM_TOKEN`), and any code-signing certs remain the
maintainer's responsibility.

### Post-release verification

```sh
npm view mail-index version                     # → the new version
npm audit signatures                            # provenance attestation present
gh release view v1.5.0                          # .mcpb attached
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.alunsoldantarctica/mail-index"
```
