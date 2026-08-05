# M3: Add MCP OAuth via workers-oauth-provider with operator allowlist

## Context
Depends on 004: worker/ entry (wraps its fetch handler; kills its dev bearer
stub) and 005: Google OAuth connect (reuses the BYO Google client for the
sign-in leg).
Read first: docs/PLAN-worker.md decision #4, ADR-0008 (single-tenant — the
only human is the operator), CONTEXT.md (Deployment).

## Decision
Full MCP OAuth using Cloudflare's `workers-oauth-provider` library, so the
Worker works as a claude.ai remote connector out of the box.

- Add `workers-oauth-provider` as a dependency of the worker build (it does
  not enter guarded `src/`). Wrap the 004 fetch handler: `apiRoute` = the MCP
  path, `defaultHandler` = the consent/login + `/setup` pages, token/client
  endpoints (`/authorize`, `/token`, `/register` with dynamic client
  registration) as the library prescribes. OAuth state lives in the library's
  KV storage — add the KV namespace binding to `worker/wrangler.jsonc`.
- Consent/login step = **Google sign-in** using the operator's BYO client
  from 005 (plain `openid email` scope — NOT the gmail scopes; this is
  identity, not mailbox access). The authenticated email must match an
  operator allowlist: `OPERATOR_EMAILS` wrangler var (comma-separated).
  Non-allowlisted identities get a denial page and no grant.
  Note: the identity leg needs a SECOND redirect URI registered on the 005
  BYO Google client (identity callback path, distinct from
  `/setup/google/callback`) — list it in operator setup steps.
- Operator browser session: a signed HttpOnly cookie minted after the
  allowlisted Google sign-in callback, 8-hour TTL, SameSite=Lax,
  CSRF-protected via the OAuth state param. `/setup` pages move behind this
  cookie (replacing 005's `?token=` gate).
- Single-tenant semantics: the grant carries the operator identity; every MCP
  request thereafter is authorized by the provider before reaching
  `buildServer`. No per-user data partitioning — allowlist is the whole
  authz model (ADR-0008).
- Remove the 004 `DEV_BEARER_TOKEN` stub entirely (code, config, docs).
- `/healthz` stays unauthenticated (liveness only); `/setup` pages from 005
  move behind the same operator session.
- Verify end-to-end as a claude.ai remote connector (dynamic client
  registration → authorize → tools listed) and record the steps for 013's
  INSTALL-worker guide.

## Acceptance criteria
- [ ] MCP requests without a valid OAuth token get 401 with the
      `WWW-Authenticate` challenge the MCP spec expects; with a token, tool
      calls succeed (Miniflare/dev test using the provider's test hooks or a
      scripted authorize flow with a fake Google identity endpoint).
- [ ] An allowlisted email completes authorize→token and can call tools; a
      non-allowlisted Google identity is refused a grant (test both).
- [ ] Dynamic client registration endpoint works (claude.ai connector
      requirement).
- [ ] `DEV_BEARER_TOKEN` no longer appears anywhere in the repo.
- [ ] KV namespace binding present; missing binding fails deploy loudly.
- [ ] `/healthz` reachable unauthenticated; `/setup` is not.
- [ ] All existing tests green; no `src/` core changes required (any
      `ToolContext` threading of operator identity is type-only).

## Out of scope
- No gmail-scope consent here — mailbox authorization is 005's flow; this
  ticket only authenticates the operator to the MCP surface.
- No multi-operator RBAC, roles, or scoped MCP permissions — allowlist only.
- No write-tool gating (008).
- No A2A auth (011 decides how `message/send` authenticates, reusing this
  provider).
