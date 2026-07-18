# A self-hosted remote Deployment, on infrastructure the operator owns

Amends [ADR-0002](0002-local-index-only-for-privacy.md). The trust posture
widens from "your mail intelligence never leaves your machine" to **"your mail
intelligence never leaves infrastructure you own."** A second, opt-in
Deployment target ships: a single-tenant Cloudflare Worker on the *operator's
own* Cloudflare account — D1 for the index, Worker secrets for keys, cron
Triggers for sync, streamable-HTTP MCP for agents. There is not, and will not
be, mail-index-operated hosting, multi-tenancy, or any account with us; the
local Deployment remains the default and keeps every ADR-0002 guarantee
untouched.

Chosen over (a) keeping the absolute local-only claim (kills the remote MCP /
webhook-trigger use case entirely) and (b) branding the Worker as a separate
product (two identities, guaranteed drift). The cost is real and stated
plainly rather than hidden:

- **The Worker holds Google credentials.** No `gog`/`gws` CLI exists there, so
  the Worker runs its own OAuth (operator-supplied Google Cloud client — the
  BYO path from [oauth-and-verification.md](../oauth-and-verification.md), no
  CASA exposure for us). Refresh tokens are AES-GCM-encrypted with a key held
  only in Worker secrets; ciphertext lives in D1, so a D1 export alone is
  useless. This deliberately breaks the local threat model's "mail-index never
  holds credentials" claim — the threat model gains a remote section instead
  of quietly contradicting it.
- **The core's egress guard stays meaningful.** `src/` remains provably
  network-free; the Worker's Gmail REST adapter and D1 driver are new *audited
  seams* (like the adapter spawn seam locally) living outside the guarded
  core, and the egress-guard test is extended to pin them, not waived.
- **Index data rests on Cloudflare.** D1 is encrypted at rest by Cloudflare,
  but the operator is trusting their own Cloudflare account the way they trust
  their own disk. That trade — plus MCP-over-network authentication (full MCP
  OAuth; consent = Google sign-in restricted to the operator allowlist) — is
  the price of an always-on index that agents, webhooks, and other Workers can
  reach without a laptop running.
