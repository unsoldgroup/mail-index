import { z } from 'zod';
import { staffMailboxDigest, staffMailboxHash } from './staff-evidence-values.js';

/**
 * EXP-4599 existing-grant link staging. Mirror of Expedition Insure
 * `convex/lib/staffMailboxLinkStaging.ts`; every digest is the same ordered
 * JSON array, so field order here is wire format. Two separate capabilities:
 * a read-only identity probe and a stage/status/revoke journal that only ever
 * writes a DISABLED link.
 */
export const LINK_REQUEST_TTL_MS = 60_000;
export const LINK_SKEW_MS = 5000;
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const text = z.string().min(1).max(256).refine(value => !/[\r\n<>]/.test(value));
const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();
const address = z.string().email().max(320).refine(value => value === value.trim().toLowerCase());
const environment = z.enum(['development', 'production']);
const uuid = z.string().uuid();
const lifetime = (r: { issuedAt: number; expiresAt: number }) => r.expiresAt > r.issuedAt && r.expiresAt - r.issuedAt <= LINK_REQUEST_TTL_MS;

/** Immutable identity actually observed with the existing grant. */
export const linkIdentity = z.object({
  provider: z.literal('google'), account: text, accountSubject: text, mailboxAddress: address, emailVerified: z.literal(true),
  scopes: z.array(text).min(1).max(30), grantGeneration: positive, identityVerifiedGeneration: positive,
}).strict().refine(identity => identity.identityVerifiedGeneration === identity.grantGeneration
  && identity.scopes.join('\n') === [...new Set(identity.scopes)].sort().join('\n'), 'identity_not_canonical');
export type LinkIdentity = z.infer<typeof linkIdentity>;

export function identityScopesSufficient(scopes: readonly string[]): boolean {
  return scopes.includes('openid') && scopes.includes(GMAIL_READONLY_SCOPE)
    && (scopes.includes('email') || scopes.includes('https://www.googleapis.com/auth/userinfo.email'));
}
export async function linkIdentityDigest(context: { environment: string; clientId: string; enrollmentHandle: string }, identity: LinkIdentity): Promise<string> {
  return staffMailboxHash(JSON.stringify(['staff-identity-v1', context.environment, context.clientId, context.enrollmentHandle,
    identity.provider, identity.account, identity.accountSubject, identity.mailboxAddress, identity.scopes, identity.grantGeneration]));
}

export const identityProbeRequest = z.object({
  version: z.literal(1), operation: z.literal('identity_probe'), operationId: uuid, environment, clientId: text,
  enrollmentHandle: text, account: text, challenge: uuid, issuedAt: nonnegative, expiresAt: nonnegative,
}).strict().refine(lifetime);
export type IdentityProbeRequest = z.infer<typeof identityProbeRequest>;
export async function identityProbeRequestDigest(r: IdentityProbeRequest): Promise<string> {
  return staffMailboxHash(JSON.stringify(['staff-identity-probe-v1', r.version, r.operation, r.operationId, r.environment,
    r.clientId, r.enrollmentHandle, r.account, r.challenge, r.issuedAt, r.expiresAt]));
}

export const stagingDescriptor = z.object({
  version: z.literal(1), clientId: text, environment, enrollmentHandle: text, account: text, accountSubject: text,
  mailboxAddress: address, identityDigest: staffMailboxDigest, actorUserId: text, ownerUserId: text,
  allowedAliases: z.array(address).min(1).max(20), policyVersion: positive, grantGeneration: positive,
  enrollmentGeneration: positive, priorLocalGeneration: nonnegative, priorRemoteGeneration: nonnegative,
  priorRemoteDigest: staffMailboxDigest.nullable(),
}).strict().refine(d => d.enrollmentGeneration > Math.max(d.priorLocalGeneration, d.priorRemoteGeneration)
  && (d.priorRemoteGeneration === 0) === (d.priorRemoteDigest === null)
  && d.allowedAliases.includes(d.mailboxAddress)
  && d.allowedAliases.join('\n') === [...new Set(d.allowedAliases)].sort().join('\n'), 'descriptor_not_fenced');
export type StagingDescriptor = z.infer<typeof stagingDescriptor>;
export async function stagingDescriptorDigest(d: StagingDescriptor): Promise<string> {
  return staffMailboxHash(JSON.stringify(['staff-staging-v1', d.version, d.clientId, d.environment, d.enrollmentHandle, d.account,
    d.accountSubject, d.mailboxAddress, d.identityDigest, d.actorUserId, d.ownerUserId, d.allowedAliases, d.policyVersion,
    d.grantGeneration, d.enrollmentGeneration, d.priorLocalGeneration, d.priorRemoteGeneration, d.priorRemoteDigest]));
}

/** One EI-minted operationId carries stage, status and revoke for one descriptor. */
export const stagingRequest = z.object({
  version: z.literal(1), operation: z.enum(['stage', 'status', 'revoke']), operationId: uuid, descriptor: stagingDescriptor,
  challenge: uuid, issuedAt: nonnegative, expiresAt: nonnegative,
}).strict().refine(lifetime);
export type StagingRequest = z.infer<typeof stagingRequest>;
