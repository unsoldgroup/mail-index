# Mailbox writes (archive + label edit) are opt-in, least-privilege

> Amended by [ADR-0011](0011-opt-in-drafts-never-send.md): opt-in drafts, and
> the no-send guarantee is enforced in code, because `gmail.modify` can send.

mail-index is read-only on the mailbox by default and says so prominently
([ADR-0002](0002-local-index-only-for-privacy.md), README, SECURITY.md,
THREAT-MODEL.md). We add two mailbox MUTATIONS — **archive** (drop the `INBOX`
label) and **label edit** (add/remove labels) — without surrendering that
default. The decision: writes are strictly OPT-IN and least-privilege.

What this does NOT change: the **local-only / zero-egress** posture is
untouched. The index still never leaves the machine, and `src/` still makes no
network calls — a write flows through the *same* audited process-spawn seam the
read path uses (the `gog` adapter CLI). The egress guard
([`test/egress-guard.test.ts`](../../test/egress-guard.test.ts)) governs
network egress and spawn seams, not mutation-vs-read, so it stays unchanged and
green. "Local-only" and "read-only" are two separate promises; this touches only
the second, and only when the user opts in.

Decisions:

- **Off by default, at the token level.** A standard install authorizes Gmail
  with `gmail.readonly`, which *cannot* modify. The mutation seam
  (`MailSource.modify`, absent on read-only adapters) is unreachable until the
  user re-authorizes. So "this install can't modify my mail" stays true by
  construction for everyone who doesn't opt in — not by convention.
- **Least-privilege scope.** Opting in (`mail-index setup --enable-writes`)
  requests `https://www.googleapis.com/auth/gmail.modify` IN ADDITION to
  readonly — never `gmail.send`, never full `https://mail.google.com/`. So even
  an opted-in install cannot send or permanently delete mail; it can only
  archive and relabel.
- **Provider write first, then the index.** `ingest/mutate.ts` calls the
  provider modify, and only on success updates the local row
  (`Repo.applyLabelChange`, re-deriving the label-driven columns). The index
  never claims a change the mailbox rejected.
- **Explicit, clearly-marked surface.** Two CLI commands (`archive`, `label`)
  and two MCP tools (`archive_message`, `modify_labels`), each labelled as
  mutating. They are NEVER reached by sync/enrich; an agent must call them
  deliberately. A scope-limited grant returns a typed
  `InsufficientScopeError` carrying the exact re-auth command.

Both adapters implement the seam. The **gog** adapter (the one-click public
path) gates writes on the opt-in `gmail.modify` re-auth above. The **gws**
adapter (bring-your-own Google Workspace CLI) uses whatever scope its own config
already grants — if that includes a Gmail modify capability (`gmail.modify` or
the broader `https://mail.google.com/`), writes work; if it is read-only, the
API returns 403 and the adapter raises the same typed `InsufficientScopeError`.
Either way a write is impossible without a modify-capable token.

Consequences: the README/SECURITY/THREAT-MODEL/CONTEXT trust language is
updated from "read-only — never mutates" to "read-only by default; explicit,
least-privilege opt-in writes." Label *creation* is intentionally out of scope
(add/remove existing labels + archive only); send and delete are excluded for
gog by the scope choice (and never invoked for gws regardless of its scope).
