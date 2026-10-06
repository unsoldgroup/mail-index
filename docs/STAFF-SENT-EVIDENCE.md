# Fresh staff SENT evidence (disabled)

`StaffSentEvidence` is a named Worker RPC entrypoint, not an HTTP or MCP tool.
It accepts deployment-controlled `ctx.props` with `clientId`, `environment` and
`permission: staff_sent_evidence`. Caller arguments cannot supply this authority.
The generic policy is empty and the durable link registry starts empty. There
are no real account mappings, bindings, new credentials or automatic enrollments.

A service owner must coordinate a separately reviewed deployment and install an
exact policy/durable-link pair before any use. Changes require a new enrollment
generation and policy digest; disabling the durable link fences older isolates.
No method in this entrypoint provisions or enables links. Existing grants start
with null immutable identity metadata. Missing effective `openid`, `email` or
`gmail.readonly` scope, Google subject or verified profile agreement holds. The
service never starts consent or borrows a separate login token. Microsoft is not
implemented by this Google-only reader.

The v1 contract uses an ordered-array request SHA256 shared with the consumer.
Acquire searches only SENT for the exact RFC Message-ID within 24 hours of the
observed receipt, bounded to ten pages of 100. Rechecks bind the previous completed
acquisition and exact item/version/hash; they never search for a replacement.
Raw MIME remains unverified input to the consumer's DKIM, thread, recipient and
canonical-content verifier. This service does not approve or send a reply.

Every challenge has one atomic durable reservation, unique across operations.
Failed reservations remain consumed through expiry plus five seconds. Completed
acquisition metadata is retained 20 minutes to support a consumer approval lifetime
of 15 minutes; this extends only linkage retention, never evidence freshness.
Each operation still needs a fresh challenge with at most 60 seconds validity.
Cleanup removes at most 100 expired records per admitted request. D1 stores item
metadata and hashes, never raw MIME, headers, bodies or provider tokens.

Security reads use the raw D1 binding, not the Sessions API: Cloudflare documents
that non-Sessions queries execute on the primary database. Do not replace this
with a replica session or KV cache. Challenge ownership and completion use single
conditional statements, not the driver's ordinary transaction shims.
https://developers.cloudflare.com/d1/best-practices/read-replication/

The operation has a shared 60 second abort/deadline; RAW is capped at 25 MiB and RPC
returns binary bytes, not base64. The authenticated consumer gateway may convert
to bounded base64 HTTP. No token, message body or identity is logged. Cached
provider tokens require a current grant read; replacement and local revocation
advance durable generation. A grant or link change during retrieval prevents a
successful result. Remote provider revocation is observed only when Google
rejects it; successful fresh evidence is not atomic with a later consumer send.

Source tests use synthetic accounts and Miniflare D1. Runtime verification,
owner coordination, actual existing grant identity capability, explicit linking,
service-binding topology and consumer end-to-end proof are separate activation
gates. This source alone does not establish Gmail/Outlook production continuity.

## Existing-grant link staging (EXP-4599, disabled)

Two private entrypoints, each authorized only by service-binding props:
`StaffIdentityProbe.probe` (`staff_identity_probe`) reads the identity behind an
existing grant and writes nothing; `StaffLinkStaging.provision`
(`staff_link_staging`) runs `stage`, `status` and `revoke` under one EI-minted
`operationId`. `STAFF_LINK_STAGING_CANDIDATES` ships empty, so probe and stage
are disabled; `status` and exact-generation `revoke` always work. Staging only
writes a disabled link, every answer reports `enabled: false`, and a revoked
link row carries `revoked_at` and can never be enabled (CHECK constraint).

**Re-consent once per staff mailbox.** Identity checks need the OIDC subject,
so `/setup/google/start` now requests `openid email` alongside Gmail scopes.
Grants created before this change lack them and fail the probe. Re-run
`/setup/google/start?account=<label>` once for each staff mailbox; this bumps
the grant generation, so probe again afterwards.

**Who enforces identity approval.** Expedition Insure enforces that an admin
approved the exact probed identity (its `staff-identity-v1` digest, owner and
aliases). The digest check here is consistency only: mail-index recomputes the
digest from the identity it observes at stage time and refuses on mismatch, so
the grant cannot have changed since the probe. It does not prove who approved.
