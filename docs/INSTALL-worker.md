# Install an operator-owned remote Deployment

This is the opt-in, single-tenant Cloudflare Worker Deployment. It does not use
mail-index-operated hosting. The local CLI, SQLite index, and stdio MCP remain
the default. A paid Workers plan is required for queued O(N) Jobs.

## 1. Prerequisites

- Node 24+, this repository, and `npm install --legacy-peer-deps`
- Wrangler authenticated to the operator’s Cloudflare account
- A Google Cloud project with Gmail API enabled
- An OAuth **Web application** client owned by the operator

In Google Cloud, configure the OAuth consent screen, add each operator as a test
user when the app is in Testing, request `gmail.readonly` (and only later
`gmail.modify` if wanted), then register these exact HTTPS callbacks after the
first deploy:

- `https://<worker-host>/oauth/google/callback`
- `https://<worker-host>/setup/google/callback`

This is the BYO-client path from [oauth-and-verification.md](oauth-and-verification.md);
verification/CASA obligations belong to the operator’s app.

## 2. Create Cloudflare resources

```sh
npx wrangler d1 create mail-index
npx wrangler queues create mail-index-jobs
npx wrangler kv namespace create OAUTH_KV
```

Copy the returned D1 and KV IDs into [worker/wrangler.jsonc](../worker/wrangler.jsonc).
Set `OPERATOR_EMAILS` to the comma-separated Google identities allowed to use
the Deployment. Set `SYNC_INTERVAL` to match the cron expression (the shipped
configuration is every 15 minutes). Do not put credentials in the file.

## 3. Set secrets and deploy

```sh
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY --config worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID --config worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config worker/wrangler.jsonc
npm run typecheck
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
npx wrangler deploy --config worker/wrangler.jsonc
```

Keep `observability.enabled: true` and `head_sampling_rate: 1`. The configuration
also pins a measured 30-second CPU limit and a queue consumer.

## 4. Connect an agent

In claude.ai, add a custom remote connector whose URL is
`https://<worker-host>/mcp`. Complete dynamic client registration and the Google
operator sign-in. The Worker’s MCP OAuth provider challenges anonymous requests;
the allowlist is authorization. A2A clients discover
`/.well-known/agent-card.json` and use the same bearer-token flow for `/a2a`.

## 5. Connect Accounts

Open `https://<worker-host>/setup` in any browser. If that browser has no
operator session it is challenged with a link to `/setup/login`, an
identity-only Google sign-in (`openid email`, no mailbox scope) that mints an
8-hour operator cookie. It reuses the `/setup/google/callback` redirect URI, so
no third callback needs registering. The session is per-browser: a second
machine signs in again at `/setup/login`.

Then start `/setup/google/start?account=<label>`. The default consent stores a read-only
grant. To opt into archive/label edits, revisit
`/setup/google/start?account=<label>&writes=1`; this is the remote equivalent of
local `--enable-writes`. Every Account is independent.

Each grant's refresh token is bound to the Worker's own Google client — the
local CLI's Desktop-client tokens cannot be transplanted here (see
`accessTokenProvider`, which refreshes with `GOOGLE_CLIENT_ID`/`SECRET`).

## 6. Optional seed

Follow [WORKER-SEED.md](WORKER-SEED.md) to export an existing local Working set
and import Messages, Summaries, curation, categories, labels, and watermarks.
Credentials, Jobs, Trigger rules, and webhook consumers are deliberately absent.

## Verification checklist

- [ ] `GET /healthz` returns `ok`, the expected schema version, and
      `migration_state: current`.
- [ ] Anonymous `POST /mcp` and `/a2a` return 401; the agent connector succeeds.
- [ ] `sync_status` shows `sync_interval`, `last_cron_run`, queue depth, and Jobs.
- [ ] The first scheduled Job appears in Workers Logs and completes; failures
      show an error in `sync_status` without Message content in logs.
- [ ] Search returns seeded or newly synced Messages; local CLI/stdio behavior
      is unchanged.
- [ ] Cloudflare dashboard confirms D1, KV, Queue, cron, and observability with
      head sampling 1.

## Scripted dry-run record — 2026-07-19

From a clean Miniflare D1/KV/Queue fixture, migrations reached schema 12,
read-only and write-consent Accounts remained independent, OAuth challenged MCP
and A2A, a cron Job ran sync → Enrichment → graph, failed Jobs surfaced errors,
signed webhook retry stopped on 2xx, seed replay converged after interruption,
and all 426 tests passed. `wrangler deploy --dry-run` validated the production
bundle and every declared binding. No real Cloudflare deploy is required by the
implementation tickets.
