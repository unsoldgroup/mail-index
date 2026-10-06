import { staffMailboxHash } from './staff-evidence-values.js';
export interface EvidenceLink {
  clientId: string; environment: 'development' | 'production' | 'preview'; enrollmentHandle: string;
  enrollmentGeneration: number; grantGeneration: number; account: string;
  accountSubject: string; mailboxAddress: string;
}
/** Owner-managed code policy. No real account mappings in this generic repo.
 * Changes must monotonically advance enrollmentGeneration and invalidate links. */
export const STAFF_EVIDENCE_POLICY: readonly EvidenceLink[] = [];

export async function evidencePolicyDigest(link: EvidenceLink): Promise<string> {
  return staffMailboxHash(JSON.stringify(['staff-evidence-policy-v1', link.clientId, link.environment,
    link.enrollmentHandle, link.enrollmentGeneration, link.grantGeneration, link.account,
    link.accountSubject, link.mailboxAddress]));
}
