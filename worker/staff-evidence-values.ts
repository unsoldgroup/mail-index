import { z } from 'zod';
export const STAFF_MAILBOX_RAW_LIMIT = 25 * 1024 * 1024;
export const staffMailboxDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const staffMailboxEnvironment = z.enum(['development', 'production', 'preview']);
export const staffMailboxHoldReason = z.enum([
  'disabled', 'missing_grant', 'grant_revoked', 'provider_unavailable', 'unsupported_provider',
  'account_mismatch', 'alias_unapproved', 'no_match', 'multiple_matches', 'search_limit',
  'evidence_expired', 'evidence_changed', 'evidence_oversized', 'transport_unverified',
  'dkim_invalid', 'headers_unsigned', 'canonical_mismatch', 'unsupported_mime',
  'recipient_uncertain', 'thread_mismatch', 'invalid_evidence',
]);
export type HoldReason = z.infer<typeof staffMailboxHoldReason>;
export class EvidenceFailure extends Error { constructor(readonly reason: HoldReason) { super(reason); } }
export async function staffMailboxHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}
