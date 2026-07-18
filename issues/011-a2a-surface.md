# M4: Expose a minimal A2A surface (agent card + message/send)

## Context
Depends on 010: Trigger rules ("shares engine" per the dependency graph —
lands after the tool surface is final) and transitively 007/008 (auth +
parity: A2A wraps the same engine as the MCP tools).
Read first: docs/PLAN-worker.md decision #9, CONTEXT.md (Recall — this is the
capability the card advertises), ADR-0008.

The engine to wrap: `dispatch(ctx, name, args)` (src/mcp/server.ts:415) and `toolList()` from
`src/mcp/server.ts` — the same registry-backed execution path the MCP
transport uses. No second brain.

## Decision
Two additions to `worker/`:

- `GET /.well-known/agent-card.json`: a static-generated A2A agent card —
  name, description (mail intelligence / recall framing from CONTEXT.md),
  provider/org left to operator config, `url` = the A2A endpoint (`/a2a`),
  capabilities: no streaming, no push notifications, skills derived from
  `toolList()` (one skill per tool or a curated grouping — derive, don't
  hand-maintain, so new tools appear automatically). Card generation is a
  pure function with a unit test.
- `POST /a2a` endpoint implementing **synchronous `message/send` only**
  (JSON-RPC per the A2A spec): parse the incoming message, map it onto the
  tool engine, return the completed result as a message. Mapping rule: a
  structured `DataPart` naming a tool + args dispatches directly; plain-text
  messages get the not-supported error (no NL routing — the caller's LLM
  picks tools, ADR-0004 spirit). **No task lifecycle**: `tasks/get`,
  `tasks/cancel`, streaming, and push configs return standard
  JSON-RPC method-not-found/unsupported errors.
- O(N) semantics carry over: a dispatch that would enqueue a Job (008)
  returns the job id in the response data — A2A callers poll via a
  `sync_status` dispatch, same as MCP callers.
- Auth: same operator boundary as MCP — the 007 OAuth provider guards the
  endpoint (bearer token from the same authorize flow). The agent card is
  public (it's discovery metadata; contains no mailbox data).

## Acceptance criteria
- [ ] `GET /.well-known/agent-card.json` returns a spec-valid card without
      auth; a unit test validates required fields and that skills track
      `toolList()` (adding a tool changes the card without code edits).
- [ ] `message/send` with a tool-shaped DataPart executes the tool and
      returns the same payload `dispatch` produces locally (golden test
      against fixtures, e.g. `search` and `sync_status`).
- [ ] Unauthenticated `message/send` gets 401; authenticated succeeds.
- [ ] `tasks/get`, `tasks/cancel`, and streaming requests return clean
      unsupported/method-not-found JSON-RPC errors (tested).
- [ ] An O(N)-shaped request returns a job id, not a blocking wait.
- [ ] No new dependency in guarded `src/`; worker-only code; egress guard and
      all 34 existing test files green.

## Out of scope
- No A2A task lifecycle, streaming (SSE), or push notifications — v1 is
  synchronous only (decision #9).
- No natural-language → tool routing; structured dispatch only.
- No separate A2A identity system — 007's provider is the auth.
- No card entries for setup/admin surfaces.
