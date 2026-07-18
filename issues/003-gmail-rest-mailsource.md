# M1: Add the Gmail REST MailSource adapter behind an injectable fetch seam

## Context
Depends on nothing in this repo's ticket chain (parallel to 001/002; feeds 5
and 6 per the dependency graph 3→(5,6)).
Read first: CONTEXT.md (Enrichment, Read-only by default, Account), ADR-0007
(opt-in mailbox writes), ADR-0008 ("audited seams" — the Gmail REST adapter
lives outside the guarded assumptions but is pinned, not waived).

Today's adapters spawn CLIs: `src/source/adapters/gws/` and `.../gog/` each
have a `runner.ts` (the spawn seam, allowlisted in `test/egress-guard.test.ts`
via `SRC_PROC_ALLOW`) and share pure Gmail mapping code in
`src/source/adapters/gmail-shared.ts` (`GmailMessage`, `headerBag`,
`decodeBody`, `extractBodies`, `toMetadata`, `buildGmailQuery`,
`normaliseSince`, `parseLabelList`). The contract is `MailSource` in
`src/source/index.ts` (`provider`, `check`, `listIds`, `getMetadata`,
`getFull`, optional `listLabels`, optional `modify` — the ONLY mutation seam,
throwing `InsufficientScopeError` semantics per ADR-0007), proven by
`runMailSourceContract(register, makeSource, fixtures)` from
`src/source/contract.ts` against `DEFAULT_FIXTURES` with no live network.

## Decision
A third adapter, `src/source/adapters/gmail-rest/`, speaking the Gmail REST
API directly — the adapter a credential-holding Worker uses (ADR-0008).

- Constructor takes injected collaborators, no ambient network:
  - `fetchImpl: typeof fetch` — the ONLY way it reaches the network;
  - `tokenProvider: () => Promise<string>` — yields a bearer access token.
    No OAuth flow, no token refresh logic in this ticket (005 owns that).
- Mirror the gog/gws runner shape: a thin `runner.ts`-equivalent that turns
  (endpoint, params) into a fetched+parsed JSON response, so the REST calls
  are one auditable seam; mapping stays in `gmail-shared.ts` (`toMetadata`,
  `extractBodies`, `buildGmailQuery` reused as-is — extend, don't fork).
- Implement the full `MailSource` surface: `listIds` via
  `users.messages.list` pagination (lazy async iterable honoring
  `MailScope`/limit), `getMetadata` via `users.messages.get?format=metadata`,
  `getFull` via `format=full`, `listLabels` via `users.labels.list`,
  `modify` via `users.messages.modify` — feature-present but surfacing the
  typed insufficient-scope error when the token lacks `gmail.modify`
  (ADR-0007; same semantics as the gws adapter).
- Error policy: no retries in this ticket; non-403 HTTP errors propagate as
  thrown errors (401 additionally surfaces as `check().ok=false`).
  Retry/backoff is 006's concern.
- Conformance: run `runMailSourceContract` against the new adapter backed by
  a fake `fetchImpl` that serves recorded Gmail REST fixtures (reuse
  `DEFAULT_FIXTURES` message data; add REST-shaped fixture wiring under
  `src/source/fixtures/` or the adapter dir).
- Egress guard **extended, not waived**: `test/egress-guard.test.ts`'s
  `NETWORK` scan currently fails any `fetch(` in `src/`. Add a
  `SRC_NETWORK_ALLOW` set (parallel to `SRC_PROC_ALLOW`) pinning exactly the
  one gmail-rest seam file, plus a "seam still exists" assertion like the
  existing `guard cannot silently pass` test.

## Acceptance criteria
- [ ] `src/source/adapters/gmail-rest/` exists; the contract suite from
      `src/source/contract.ts` passes against it with zero live network.
- [ ] `fetch` appears in exactly one adapter file, always via the injected
      `fetchImpl`; no `node:https`/undici import anywhere.
- [ ] `test/egress-guard.test.ts` updated: gmail-rest seam allowlisted by
      exact path, all other `src/` files still fail on network primitives,
      and a test asserts the allowlisted seam file exists.
- [ ] `modify` with a readonly-scoped token surfaces the typed
      insufficient-scope error (test with a 403-returning fake fetch).
- [ ] `toMetadata`/`buildGmailQuery` from `gmail-shared.ts` are reused (no
      duplicated mapping code); any additions are covered by unit tests.
- [ ] All 34 existing test files remain green; `npm run typecheck` passes.

## Out of scope
- No OAuth flow, token storage, refresh, or encryption — 005. Token provider
  is an injected function only.
- No Worker/wrangler code (004); adapter must also run under Node.
- No changes to gog/gws adapters; `ADAPTERS` in `src/config/index.ts` DOES
  gain the new adapter id in this ticket, but no setup-flow work.
- No Gmail push/watch (`users.watch`) — fast-follow, designed in 013.
