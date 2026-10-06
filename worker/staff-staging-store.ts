import type { D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { evidencePolicyDigest } from './staff-evidence-policy.js';
import type { StagingDescriptor } from './staff-staging-contract.js';

export type StagingState = 'staged' | 'revoked';
export interface StagingResult { state: StagingState; policyDigest: string }
const OP = 'client_id=? AND environment=? AND operation_id=?';
const LINK = 'client_id=? AND environment=? AND enrollment_handle=?';

/** Exact `staff-evidence-policy-v1` digest the evidence reader fences on. */
export function linkDigest(d: StagingDescriptor) { return evidencePolicyDigest({ ...d }); }

export async function readOperation(db: D1DatabaseBinding, d: StagingDescriptor, operationId: string) {
  return db.prepare(`SELECT descriptor_digest,state FROM staff_staging_operations WHERE ${OP}`)
    .bind(d.clientId, d.environment, operationId).first<{ descriptor_digest: string; state: StagingState }>();
}

/** Status-only read: never writes, never calls the provider. A staged operation
 * must still own the link at exactly its generation, and that link is disabled. */
export async function readStaging(db: D1DatabaseBinding, d: StagingDescriptor, operationId: string, digest: string): Promise<StagingResult> {
  const row = await readOperation(db, d, operationId);
  if (!row || row.descriptor_digest !== digest) throw Error('Staging operation unavailable');
  const policyDigest = await linkDigest(d);
  if (row.state === 'revoked') return { state: 'revoked', policyDigest };
  const link = await db.prepare(`SELECT enrollment_generation,policy_digest,enabled FROM staff_evidence_links WHERE ${LINK}`)
    .bind(d.clientId, d.environment, d.enrollmentHandle).first<{ enrollment_generation: number; policy_digest: string; enabled: number }>();
  if (!link || link.enrollment_generation !== d.enrollmentGeneration || link.policy_digest !== policyDigest || link.enabled !== 0) throw Error('Staging generation conflict');
  return { state: 'staged', policyDigest };
}

/**
 * Generation compare-and-set against the last CONFIRMED remote link: no link at
 * all for a first generation, else exactly the prior generation and digest, and
 * that prior link is disabled (staging never displaces an enabled link). The
 * journal row and the disabled link land in one batch; a tombstoned operation
 * id is never re-staged because the link write requires state='staged'.
 */
export async function stageLink(db: D1DatabaseBinding, d: StagingDescriptor, operationId: string, digest: string, now: number): Promise<StagingResult> {
  const policyDigest = await linkDigest(d);
  const first = d.priorRemoteGeneration === 0;
  const prior = first
    ? `NOT EXISTS(SELECT 1 FROM staff_evidence_links WHERE ${LINK})`
    : `EXISTS(SELECT 1 FROM staff_evidence_links WHERE ${LINK} AND enrollment_generation=? AND policy_digest=? AND enabled=0)`;
  const priorArgs = first ? [d.clientId, d.environment, d.enrollmentHandle] : [d.clientId, d.environment, d.enrollmentHandle, d.priorRemoteGeneration, d.priorRemoteDigest];
  await db.batch([
    db.prepare(`INSERT INTO staff_staging_operations(client_id,environment,operation_id,enrollment_handle,descriptor_digest,state,created_at)
      SELECT ?,?,?,?,?,'staged',? WHERE ${prior}
      AND EXISTS(SELECT 1 FROM google_tokens WHERE account=? AND grant_generation=? AND provider_subject=? AND identity_verified_generation=grant_generation AND locally_disabled=0 AND auth_error IS NULL)
      ON CONFLICT(client_id,environment,operation_id) DO NOTHING`)
      .bind(d.clientId, d.environment, operationId, d.enrollmentHandle, digest, now, ...priorArgs, d.account, d.grantGeneration, d.accountSubject),
    db.prepare(`INSERT INTO staff_evidence_links(client_id,environment,enrollment_handle,enrollment_generation,policy_digest,enabled,updated_at)
      SELECT ?,?,?,?,?,0,? WHERE EXISTS(SELECT 1 FROM staff_staging_operations WHERE ${OP} AND descriptor_digest=? AND state='staged') AND ${prior}
      ON CONFLICT(client_id,environment,enrollment_handle) DO UPDATE SET enrollment_generation=excluded.enrollment_generation,policy_digest=excluded.policy_digest,enabled=0,updated_at=excluded.updated_at`)
      .bind(d.clientId, d.environment, d.enrollmentHandle, d.enrollmentGeneration, policyDigest, now, d.clientId, d.environment, operationId, digest, ...priorArgs),
  ]);
  return readStaging(db, d, operationId, digest);
}

/**
 * Exact-generation revocation, never gated by the staging switch. Tombstones
 * the operation id permanently (also when it is unknown, which cancels a stage
 * still in flight) and disables the link only at this exact generation and
 * digest, so a later generation is never touched.
 */
export async function revokeLink(db: D1DatabaseBinding, d: StagingDescriptor, operationId: string, digest: string, now: number): Promise<StagingResult> {
  const policyDigest = await linkDigest(d);
  await db.batch([
    db.prepare(`INSERT INTO staff_staging_operations(client_id,environment,operation_id,enrollment_handle,descriptor_digest,state,created_at) VALUES(?,?,?,?,?,'revoked',?)
      ON CONFLICT(client_id,environment,operation_id) DO UPDATE SET state='revoked' WHERE descriptor_digest=excluded.descriptor_digest`)
      .bind(d.clientId, d.environment, operationId, d.enrollmentHandle, digest, now),
    db.prepare(`UPDATE staff_evidence_links SET enabled=0,updated_at=? WHERE ${LINK} AND enrollment_generation=? AND policy_digest=?
      AND EXISTS(SELECT 1 FROM staff_staging_operations WHERE ${OP} AND descriptor_digest=? AND state='revoked')`)
      .bind(now, d.clientId, d.environment, d.enrollmentHandle, d.enrollmentGeneration, policyDigest, d.clientId, d.environment, operationId, digest),
  ]);
  const row = await readOperation(db, d, operationId);
  if (row?.descriptor_digest !== digest || row.state !== 'revoked') throw Error('Staging operation conflict');
  return { state: 'revoked', policyDigest };
}
