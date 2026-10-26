# Opt-in drafts; mail-index never sends (amends ADR-0007)

Agents need to prepare replies, and the mail they help with goes out under
several send-as identities on one mailbox. We add one MCP tool, `create_draft`,
on the remote Deployment. The user reviews and sends the draft from Gmail. This
amends [ADR-0007](0007-opt-in-mailbox-writes.md), which allowed only archive and
label edits.

Decisions:

- **Separate per-account opt-in.** Drafts need the
  `https://www.googleapis.com/auth/gmail.compose` scope. An operator grants it
  with `/setup/google/start?account=<label>&drafts=1`, the same flow as
  `&writes=1`. The two flags are independent, and a re-consent replaces the
  stored scopes, so an account that wants both passes both. Without
  `gmail.compose` in the stored scopes, the Worker replaces the adapter's
  `createDraft` with a typed refusal that carries the re-consent link.
- **`users.drafts.create` only.** The adapter calls `drafts.create` and nothing
  else that composes mail. It does not update, send or delete drafts.
- **`from` must be a verified send-as address.** The tool reads
  `users.settings.sendAs.list` (allowed by the read-only scope) and accepts the
  primary address and aliases whose `verificationStatus` is `accepted`. It
  caches that list for ten minutes per Worker isolate. Any other `from` is
  refused before Gmail is called.
- **Replies thread correctly.** With `reply_to_ref`, the adapter reads the
  original message's metadata, sets the draft's `threadId`, and writes
  `In-Reply-To` and `References` from its `Message-ID`.

## The guarantee moves from scope to code

ADR-0007 said the scope choice made sending impossible. That is not true for
these scopes: Gmail's `messages.send` and `drafts.send` accept
`gmail.compose`, and also `gmail.modify`. So a compose or modify grant can send
at the token level. "mail-index never sends" is now enforced in code and by a
test, not by the token:

- The single Gmail REST seam (`createGmailRestRunner`) refuses any request
  whose path has a `send` segment, before it calls the network.
- `test/drafts.test.ts` proves that guard rejects `messages/send` and
  `drafts/send` with zero network calls, and scans every source file in `src/`
  and `worker/` for a send endpoint name (REST path, discovery method name,
  upload endpoint, or a quoted `send` CLI verb). A new send path fails CI.
- The base URL of the runner is fixed to `gmail/v1/users/me/`, so the separate
  upload endpoint for sending is not reachable either.

Consequences: an operator who grants `gmail.compose` trusts the deployed code,
not Google, to never send. That is the same trust an operator already gives the
code with `gmail.modify`. The local install (gog, gws adapters) has no draft
seam; `create_draft` refuses there.
