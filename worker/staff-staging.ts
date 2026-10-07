import { z } from 'zod';
import { D1Driver } from '../src/index/drivers/d1.js';
import type { Env } from './index.js';
import { observeStaffIdentity } from './staff-evidence-reader.js';
import {
  LINK_SKEW_MS, identityProbeRequest, identityProbeRequestDigest, identityScopesSufficient, linkIdentityDigest,
  stagingDescriptorDigest, stagingRequest,
} from './staff-staging-contract.js';
import { readOperation, readStaging, revokeLink, stageLink, type StagingResult } from './staff-staging-store.js';

/**
 * Owner-reviewed existing grants that may be probed and staged. Empty: staging
 * is disabled everywhere until a reviewed code change lists an exact
 * clientId/environment/enrollmentHandle/account. `status` and `revoke` are
 * never gated by this list. No account mapping, credential or live link here.
 */
export interface StagingCandidate { clientId: string; environment: 'development' | 'production'; enrollmentHandle: string; account: string }
export const STAFF_LINK_STAGING_CANDIDATES: readonly StagingCandidate[] = [];

const text = z.string().min(1).max(256);
const environment = z.enum(['development', 'production']);
const probeProps = z.object({ clientId: text, environment, permission: z.literal('staff_identity_probe') }).strict();
const stagingProps = z.object({ clientId: text, environment, permission: z.literal('staff_link_staging') }).strict();
interface Options { candidates?: readonly StagingCandidate[]; fetchImpl?: typeof fetch; now?: () => number }

function checkTime(r: { issuedAt: number; expiresAt: number }, now: number) {
  if (r.issuedAt > now + LINK_SKEW_MS || r.expiresAt <= now) throw Error('Staging request expired');
}
function candidate(list: readonly StagingCandidate[], c: StagingCandidate) {
  if (!list.some(x => x.clientId === c.clientId && x.environment === c.environment && x.enrollmentHandle === c.enrollmentHandle && x.account === c.account)) throw Error('Staff link staging disabled');
}

/** Read-only probe: reports the immutable identity behind an existing grant. Never writes a link or journal row. */
export async function probeStaffIdentity(env: Env, props: unknown, input: unknown, options: Options = {}) {
  const caller = probeProps.parse(props), r = identityProbeRequest.parse(input), now = options.now ?? Date.now;
  if (caller.clientId !== r.clientId || caller.environment !== r.environment) throw Error('Identity probe caller denied');
  checkTime(r, now());
  candidate(options.candidates ?? STAFF_LINK_STAGING_CANDIDATES, r);
  const identity = await observeStaffIdentity(env, new D1Driver(env.DB), r.account, r.expiresAt, options);
  checkTime(r, now());
  return { version: 1 as const, operation: 'identity_probe' as const, operationId: r.operationId, requestDigest: await identityProbeRequestDigest(r),
    challenge: r.challenge, environment: r.environment, clientId: r.clientId, enrollmentHandle: r.enrollmentHandle, identity, observedAt: now(), expiresAt: r.expiresAt };
}

/**
 * stage: gated by the candidate list; re-probes the grant, recomputes the
 * `staff-identity-v1` digest of what it actually observed and requires it to
 * equal the approved `identityDigest`, then writes a DISABLED link under CAS.
 * status: journal read only. revoke: exact generation, always allowed.
 * Every answer reports `enabled: false`.
 */
export async function provisionStaffLink(env: Env, props: unknown, input: unknown, options: Options = {}) {
  const caller = stagingProps.parse(props), r = stagingRequest.parse(input), d = r.descriptor, now = options.now ?? Date.now;
  if (caller.clientId !== d.clientId || caller.environment !== d.environment) throw Error('Staging caller denied');
  checkTime(r, now());
  const digest = await stagingDescriptorDigest(d), driver = new D1Driver(env.DB);
  let result: StagingResult;
  if (r.operation === 'revoke') result = await revokeLink(driver.db, d, r.operationId, digest, now());
  else if (r.operation === 'status') result = await readStaging(driver.db, d, r.operationId, digest);
  else {
    const known = await readOperation(driver.db, d, r.operationId);
    if (known?.state === 'revoked') result = await readStaging(driver.db, d, r.operationId, digest);
    else {
      candidate(options.candidates ?? STAFF_LINK_STAGING_CANDIDATES, d);
      const identity = await observeStaffIdentity(env, driver, d.account, r.expiresAt, options);
      if (identity.accountSubject !== d.accountSubject || identity.mailboxAddress !== d.mailboxAddress || identity.grantGeneration !== d.grantGeneration
        || !identityScopesSufficient(identity.scopes) || await linkIdentityDigest(d, identity) !== d.identityDigest) throw Error('Staging identity mismatch');
      checkTime(r, now());
      result = await stageLink(driver.db, d, r.operationId, digest, now());
    }
  }
  checkTime(r, now());
  return { version: 1 as const, operation: r.operation, operationId: r.operationId, descriptorDigest: digest, challenge: r.challenge,
    state: result.state, enabled: false as const, enrollmentGeneration: d.enrollmentGeneration, policyDigest: result.policyDigest,
    completedAt: now(), expiresAt: r.expiresAt };
}
