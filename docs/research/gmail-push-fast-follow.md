# Draft design: Gmail push as a polling accelerator

This is a fast-follow design note, not an accepted ADR and not implemented.

Gmail `users.watch` would publish mailbox change notices to an operator-owned
Google Pub/Sub topic. A Worker webhook would verify the Pub/Sub push JWT
(issuer, audience, signature, and expiry), resolve the notice to one connected
Account, read its latest successful sync watermark, and call the existing ticket
006 seam `enqueueSyncJob(env, account, since)`. It would never run Gmail work in
the request. Existing Job deduplication collapses overlapping push and cron work.

Watches expire within seven days. A daily scheduled renewal Job would call
`users.watch` for every connected Account and persist its expiry/history ID;
renewal failure would be visible in Job status. The 15-minute polling cron stays
enabled as the correctness fallback for lost Pub/Sub deliveries, expired watches,
or verification failures. Push only improves latency.

The eventual threat-model change must cover the public webhook, Google signing
keys, strict Pub/Sub JWT validation, replay/deduplication, topic IAM, and mapping
without accepting an Account label from untrusted payload data.
