# OAuth, scopes, and Google verification (CASA)

mail-index reads Gmail through a Google **OAuth client** with the read-only
scope `https://www.googleapis.com/auth/gmail.readonly`. You provide that client
one of two ways (see [INSTALL.md §2](INSTALL.md#2-connect-a-mailbox-pick-an-oauth-path)):

- **Option A — the mail-index beta client *(bundled client not shipped yet)*.** A
  public OAuth app is registered (Google "testing" status), so eventually you just
  sign in. The `mail-index setup` wizard that would place it **is built**, but the
  *bundled* client isn't distributed in the package yet — without it on disk,
  setup falls back to the manual steps, so use Option B today. Because the app
  uses a *restricted* scope and is unverified, it
  is capped at **~100 users** and shows an "unverified app" screen. Google only
  admits **named test users** in this mode, so Option A needs a one-time
  [beta access request](https://github.com/unsoldgroup/mail-index/issues/new?template=beta_access.yml)
  to add your address to the test-user list.
- **Option B — your own Google Cloud client.** No mail-index cap; the
  verification burden (if any) is yours, on your own app and timeline.

This document explains the cap, and what it takes to lift it.

---

## Why the ~100-user cap exists

`gmail.readonly` is a Google **restricted** scope. Any app requesting a
restricted scope that wants to serve the general public must pass Google's OAuth
**verification** *and* a **CASA** security assessment. Until then the app stays
in **testing** mode: ~100 users max, plus an "unverified app" warning on the
consent screen. That cap is fine for a beta / friends-and-family launch, which
is why Option A is framed as a beta.

**Who actually owes CASA:** only an app that ships **its own public OAuth client
to more than ~100 users**. So it applies to the mail-index beta client *only if*
we take it past the beta. It does **not** apply when a user brings their own
client (Option B), nor while we stay in testing mode.

---

## CASA — what it is

**CASA = Cloud Application Security Assessment** — a third-party security review
Google requires for apps requesting **restricted** Google API scopes (which
includes the Gmail scopes). It is governed by the **App Defense Alliance** (ADA,
a Linux Foundation / joint-industry body Google handed CASA off to) and
validates the app against the **OWASP Application Security Verification Standard
(ASVS)**.

Tiers of rigor:

- **Tier 2** — the common one for OAuth restricted-scope apps: a scan-based +
  limited-manual review (a self-guided/approved scan plus assessor review).
- **Tier 3** — deeper, fully manual pen-test-style review for higher-risk apps.

For Gmail restricted scopes you generally also need Google **OAuth verification /
brand review** first (verified consent screen, privacy policy, homepage, demo
video of the OAuth flow); CASA sits alongside/after that.

---

## How you do it (typical flow)

1. **Finish Google OAuth app verification** — verified consent screen, published
   privacy policy + homepage on a domain you own (verified in Search Console), a
   recorded demo of the sign-in/scope flow, and a scope justification.
2. **Get assigned to CASA** — Google's OAuth verification team triggers the
   requirement and points you to an authorized **CASA assessor** (a third-party
   security lab from the ADA's list).
3. **Run the assessment** — for Tier 2, run an approved **automated scan** of the
   app/codebase, then the assessor reviews results + any manual findings against
   OWASP ASVS.
4. **Remediate** — fix anything flagged (data handling, transport security,
   secret storage, etc.).
5. **Receive the Letter of Validation (LOV)** — proof of passing, submitted back
   to Google to clear the restricted-scope review.
6. **Re-certify annually** — CASA is **not** one-and-done; renew each year to
   keep restricted-scope access.

---

## Practical notes for mail-index

- **Cost / time:** Tier 2 commonly runs into low-thousands-of-USD with an
  assessor and takes weeks; it is a **recurring annual** cost. (Varies by
  assessor — treat as an estimate, not a quote.)
- **The 100-user escape hatch:** staying in **testing mode (≤100 users)** skips
  verification + CASA entirely. That is why the rollout favors a beta first.
- **A scope reduction worth investigating:** the audit burden is driven by
  `gmail.readonly` being *restricted*. Some Gmail **metadata-only** scopes are
  *sensitive* rather than *restricted* — they need verification but **not** CASA.
  Metadata-only would change what mail-index can index (headers/labels/snippets,
  **no full bodies**), so it is a real design trade-off against mail-index's
  "metadata-wide, bodies-narrow" model — to weigh, not a settled answer.
- **Workspace orgs** can sideload their own org-managed OAuth client (Option B)
  and avoid the mail-index cap entirely.
