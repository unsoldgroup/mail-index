import type { D1Driver } from '../src/index/drivers/d1.js';
import type { StaffServiceRequest } from './staff-evidence-contract.js';
import { evidencePolicyDigest, type EvidenceLink } from './staff-evidence-policy.js';
import { EvidenceFailure } from './staff-evidence-values.js';

export async function reserveEvidence(driver: D1Driver, link: EvidenceLink, request: StaffServiceRequest, digest: string, now: number) {
  // Bounded cleanup cannot delete a still-valid challenge, including clock skew.
  await driver.prepare(`DELETE FROM staff_evidence_challenges WHERE rowid IN
    (SELECT rowid FROM staff_evidence_challenges WHERE expires_at + CASE WHEN state='complete' AND operation='acquire' THEN 1200000 ELSE 0 END < ? ORDER BY expires_at LIMIT 100)`)
    .run(now - 5000);
  const reserved = await driver.prepare(`INSERT INTO staff_evidence_challenges
    (client_id,environment,enrollment_handle,challenge,operation,request_digest,account,enrollment_generation,grant_generation,expires_at,original_message_id,forward_message_id,observation_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,environment,enrollment_handle,challenge) DO NOTHING`)
    .run(link.clientId, request.environment, request.enrollmentHandle, request.challenge, request.operation, digest, link.account,
      request.expectedEnrollmentGeneration, request.expectedGrantGeneration, request.expiresAt,
      request.originalMessageId, request.forwardMessageId, request.observationId);
  if (reserved.changes !== 1) throw new EvidenceFailure('invalid_evidence');
  if (request.expectedItem) {
    const item = request.expectedItem;
    const acquisition = await driver.prepare(`SELECT 1 AS valid FROM staff_evidence_challenges
      WHERE client_id=? AND environment=? AND enrollment_handle=? AND challenge=? AND request_digest=?
      AND operation='acquire' AND state='complete' AND enrollment_generation=? AND grant_generation=?
      AND item_id=? AND item_version=? AND raw_sha256=? AND sent_at=?
      AND original_message_id=? AND forward_message_id=? AND observation_id=? AND expires_at+1200000>=?`)
      .get(link.clientId, request.environment, request.enrollmentHandle, item.acquisitionChallenge, item.acquisitionRequestDigest,
        request.expectedEnrollmentGeneration, request.expectedGrantGeneration, item.id, item.version, item.rawSha256, item.sentAt,
        request.originalMessageId, request.forwardMessageId, request.observationId, now);
    if (!acquisition) throw new EvidenceFailure('evidence_changed');
  }
}
export async function completeEvidence(driver: D1Driver, link: EvidenceLink, request: StaffServiceRequest, digest: string, item: { id: string; version: string; sentAt: number }, hash: string) {
  const result = await driver.prepare(`UPDATE staff_evidence_challenges SET state='complete',item_id=?,item_version=?,raw_sha256=?,sent_at=?
    WHERE client_id=? AND environment=? AND enrollment_handle=? AND challenge=? AND request_digest=? AND state='claimed'
    AND EXISTS(SELECT 1 FROM google_tokens WHERE account=? AND grant_generation=? AND locally_disabled=0 AND auth_error IS NULL)
    AND EXISTS(SELECT 1 FROM staff_evidence_links WHERE client_id=? AND environment=? AND enrollment_handle=? AND enrollment_generation=? AND policy_digest=? AND enabled=1 AND revoked_at IS NULL)`)
    .run(item.id, item.version, hash, item.sentAt, link.clientId, request.environment, request.enrollmentHandle, request.challenge, digest, link.account, request.expectedGrantGeneration, link.clientId, link.environment, link.enrollmentHandle, link.enrollmentGeneration, await evidencePolicyDigest(link));
  if (result.changes !== 1) throw new EvidenceFailure('grant_revoked');
}

/** Empty by migration. Only owner-coordinated provisioning can install a link;
 * old Worker isolates cannot recreate it or adopt a different generation. */
export async function assertEvidenceLink(driver: D1Driver, link: EvidenceLink) {
  const row = await driver.prepare(`SELECT 1 AS valid FROM staff_evidence_links WHERE client_id=? AND environment=?
    AND enrollment_handle=? AND enrollment_generation=? AND policy_digest=? AND enabled=1 AND revoked_at IS NULL`)
    .get(link.clientId, link.environment, link.enrollmentHandle, link.enrollmentGeneration, await evidencePolicyDigest(link));
  if (!row) throw new EvidenceFailure('grant_revoked');
}
