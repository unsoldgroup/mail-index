import { z } from 'zod';
import { D1Driver } from '../src/index/drivers/d1.js';
import { accessTokenProvider, readGoogleGrant, GMAIL_READONLY } from './google-oauth.js';
import { staffServiceRequest, staffServiceRequestDigest, type StaffServiceRequest } from './staff-evidence-contract.js';
import { STAFF_EVIDENCE_POLICY, type EvidenceLink } from './staff-evidence-policy.js';
import { EvidenceFailure, STAFF_MAILBOX_RAW_LIMIT, staffMailboxHash } from './staff-evidence-values.js';
import { reserveEvidence, completeEvidence, assertEvidenceLink } from './staff-evidence-store.js';
import type { Env } from './index.js';
import { linkIdentity, type LinkIdentity } from './staff-staging-contract.js';

const propsSchema = z.object({ clientId: z.string().min(1).max(256), environment: z.enum(['production', 'development', 'preview']), permission: z.literal('staff_sent_evidence') }).strict();
const rawItem = z.object({ id: z.string().min(1).max(256), historyId: z.string().min(1).max(256), internalDate: z.string().regex(/^\d+$/), labelIds: z.array(z.string().max(256)).max(100), raw: z.string() });
const metadataLimit = 64 * 1024;

/** All fetch/body reads share one deadline. Cancel is best-effort, never awaited. */
export function boundedFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted();
    const response = await fetchImpl(input, { ...init, signal, redirect: 'error' });
    signal.throwIfAborted();
    // Token refresh consumes response.json internally. Bound that response here,
    // including error bodies, before handing it to the existing grant owner.
    if (String(input) === 'https://oauth2.googleapis.com/token') {
      const content = await readJson(new Response(response.body, { status: 200 }), metadataLimit, signal);
      return Response.json(content, { status: response.status });
    }
    return response;
  };
}
export async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new EvidenceFailure(response.status === 401 || response.status === 403 ? 'grant_revoked' : 'provider_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EvidenceFailure('provider_unavailable');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new EvidenceFailure('evidence_oversized');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
function decodeRaw(value: string) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new EvidenceFailure('invalid_evidence');
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > STAFF_MAILBOX_RAW_LIMIT) throw new EvidenceFailure('evidence_oversized');
  if (bytes.toString('base64url') !== value.replace(/=+$/, '')) throw new EvidenceFailure('invalid_evidence');
  return new Uint8Array(bytes);
}
function checkTime(request: StaffServiceRequest, now: number) {
  if (request.issuedAt > now + 5000 || request.expiresAt <= now || now - request.issuedAt > 65_000) throw new EvidenceFailure('evidence_expired');
}
export async function grantFence(driver: D1Driver, link: Pick<EvidenceLink, 'account' | 'grantGeneration' | 'mailboxAddress'>) {
  const grant = await readGoogleGrant(driver, link.account);
  if (!grant || grant.locally_disabled || grant.auth_error || grant.grant_generation !== link.grantGeneration) throw new EvidenceFailure('grant_revoked');
  if (grant.address.toLowerCase() !== link.mailboxAddress.toLowerCase()) throw new EvidenceFailure('account_mismatch');
  return grant;
}

/** Fresh identity from the existing grant, fenced on one grant generation. Writes nothing of its own. */
export async function observeStaffIdentity(env: Env, driver: D1Driver, account: string, expiresAt: number, options: { fetchImpl?: typeof fetch; now?: () => number }): Promise<LinkIdentity> {
  const now = options.now ?? Date.now;
  const start = await readGoogleGrant(driver, account);
  if (!start || start.locally_disabled || start.auth_error) throw new EvidenceFailure('missing_grant');
  const fence = { account, grantGeneration: start.grant_generation, mailboxAddress: start.address };
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), Math.max(1, expiresAt - now()));
  try {
    const fetchImpl = boundedFetch(options.fetchImpl ?? fetch, abort.signal);
    const token = await accessTokenProvider(driver, account, env, fetchImpl)();
    const grant = await grantFence(driver, fence);
    const headers = { authorization: `Bearer ${token}` };
    const json = async (url: string) => readJson(await fetchImpl(url, { headers }), 65_536, abort.signal);
    const user = z.object({ sub: z.string().min(1).max(256), email: z.string().email(), email_verified: z.literal(true) }).parse(await json('https://openidconnect.googleapis.com/v1/userinfo'));
    const profile = z.object({ emailAddress: z.string().email() }).parse(await json('https://gmail.googleapis.com/gmail/v1/users/me/profile'));
    const mailbox = grant.address.toLowerCase();
    if (user.email.toLowerCase() !== mailbox || profile.emailAddress.toLowerCase() !== mailbox) throw new EvidenceFailure('account_mismatch');
    if (grant.provider_subject && grant.provider_subject !== user.sub) throw new EvidenceFailure('account_mismatch');
    await grantFence(driver, fence);
    abort.signal.throwIfAborted();
    return linkIdentity.parse({ provider: 'google', account, accountSubject: user.sub, mailboxAddress: mailbox, emailVerified: true,
      scopes: [...new Set(grant.effective_scopes?.split(/\s+/).filter(Boolean) ?? [])].sort(),
      grantGeneration: grant.grant_generation, identityVerifiedGeneration: grant.grant_generation });
  } finally { clearTimeout(timer); abort.abort(); }
}

/** Internal service function, not exposed by HTTP/MCP. Injected policy is test-only;
 * the named entrypoint always passes the fixed empty deployment policy. */
export async function readStaffSentEvidence(env: Env, props: unknown, input: unknown, options: { fetchImpl?: typeof fetch; policy?: readonly EvidenceLink[]; now?: () => number } = {}) {
  const trusted = propsSchema.safeParse(props);
  const parsed = staffServiceRequest.safeParse(input);
  if (!trusted.success || !parsed.success) throw new EvidenceFailure('invalid_evidence');
  const request = parsed.data; const digest = await staffServiceRequestDigest(request);
  const binding = { version: 1 as const, operation: request.operation, environment: request.environment, enrollmentHandle: request.enrollmentHandle,
    expectedEnrollmentGeneration: request.expectedEnrollmentGeneration, expectedGrantGeneration: request.expectedGrantGeneration,
    challenge: request.challenge, observationId: request.observationId, requestDigest: digest };
  const now = options.now ?? Date.now;
  const startedAt = now(); const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new EvidenceFailure('provider_unavailable')); }, Math.max(1, Math.min(60_000, request.expiresAt - startedAt)));
  });
  const work = async () => {
    checkTime(request, now());
    const link = (options.policy ?? STAFF_EVIDENCE_POLICY).find(row => row.clientId === trusted.data.clientId && row.environment === trusted.data.environment && row.environment === request.environment && row.enrollmentHandle === request.enrollmentHandle);
    if (!link) throw new EvidenceFailure('disabled');
    if (link.enrollmentGeneration !== request.expectedEnrollmentGeneration || link.grantGeneration !== request.expectedGrantGeneration) throw new EvidenceFailure('grant_revoked');
    // Uses the raw binding, not a Sessions API replica: every fence is primary.
    const driver = new D1Driver(env.DB);
    await assertEvidenceLink(driver, link);
    await reserveEvidence(driver, link, request, digest, startedAt);
    await grantFence(driver, link);
    const fetchImpl = boundedFetch(options.fetchImpl ?? fetch, abort.signal);
    const token = await accessTokenProvider(driver, link.account, env, fetchImpl)();
    const grant = await grantFence(driver, link);
    const scopes = grant.effective_scopes?.split(/\s+/).filter(Boolean) ?? [];
    // Google may return the canonical email permission URI for the OIDC email alias.
    const hasEmailScope = scopes.includes('email') || scopes.includes('https://www.googleapis.com/auth/userinfo.email');
    if (!scopes.includes('openid') || !hasEmailScope || !scopes.includes(GMAIL_READONLY)) throw new EvidenceFailure('missing_grant');
    const headers = { authorization: `Bearer ${token}` };
    const json = async (url: string, limit = metadataLimit) => readJson(await fetchImpl(url, { headers }), limit, abort.signal);
    const identity = z.object({ sub: z.string().min(1).max(256), email: z.string().email(), email_verified: z.literal(true) }).parse(await json('https://openidconnect.googleapis.com/v1/userinfo'));
    const profile = z.object({ emailAddress: z.string().email() }).parse(await json('https://gmail.googleapis.com/gmail/v1/users/me/profile'));
    if (identity.sub !== link.accountSubject || identity.email.toLowerCase() !== link.mailboxAddress.toLowerCase() || profile.emailAddress.toLowerCase() !== link.mailboxAddress.toLowerCase()) throw new EvidenceFailure('account_mismatch');
    if (grant.provider_subject && grant.provider_subject !== identity.sub) throw new EvidenceFailure('account_mismatch');
    const verified = await driver.prepare('UPDATE google_tokens SET provider_subject=?,identity_verified_generation=? WHERE account=? AND grant_generation=? AND locally_disabled=0 AND auth_error IS NULL')
      .run(identity.sub, link.grantGeneration, link.account, link.grantGeneration);
    if (verified.changes !== 1) throw new EvidenceFailure('grant_revoked');
    let id = request.expectedItem?.id;
    if (!id) {
      const ids = new Set<string>(); let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ labelIds: 'SENT', maxResults: '100', q: `in:sent rfc822msgid:${request.originalMessageId} after:${Math.floor((request.observedReceivedAt - 86400000) / 1000)} before:${Math.ceil((request.observedReceivedAt + 86400000) / 1000)}` });
        if (pageToken) query.set('pageToken', pageToken);
        const result = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(256) })).max(100).optional(), nextPageToken: z.string().max(4096).optional() }).parse(await json(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`));
        for (const message of result.messages ?? []) ids.add(message.id);
        if (ids.size > 1) throw new EvidenceFailure('multiple_matches');
        pageToken = result.nextPageToken;
        if (!pageToken) break;
        if (page === 9) throw new EvidenceFailure('search_limit');
      }
      id = [...ids][0];
      if (!id) throw new EvidenceFailure('no_match');
    }
    const read = async () => {
      const item = rawItem.parse(await json(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=raw`, Math.ceil(STAFF_MAILBOX_RAW_LIMIT * 4 / 3) + metadataLimit));
      const sentAt = Number(item.internalDate);
      if (item.id !== id || !item.labelIds.includes('SENT') || item.labelIds.includes('DRAFT') || !Number.isSafeInteger(sentAt) || Math.abs(sentAt - request.observedReceivedAt) > 86400000 || sentAt > now() + 5000) throw new EvidenceFailure('evidence_changed');
      const bytes = decodeRaw(item.raw); const hash = await staffMailboxHash(bytes);
      const head = Buffer.from(bytes.subarray(0, metadataLimit)).toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
      const messageIds = [...head.replace(/\r?\n[ \t]+/g, ' ').matchAll(/^message-id:\s*(.+)$/gim)];
      if (messageIds.length !== 1 || messageIds[0]?.[1]?.trim() !== request.originalMessageId) throw new EvidenceFailure('invalid_evidence');
      return { item: { id: item.id, version: item.historyId, sentAt, labels: item.labelIds }, bytes, hash };
    };
    const first = await read(); const last = await read();
    if (first.hash !== last.hash || JSON.stringify(first.item) !== JSON.stringify(last.item)) throw new EvidenceFailure('evidence_changed');
    const expected = request.expectedItem;
    if (expected && (last.item.id !== expected.id || last.item.version !== expected.version || last.item.sentAt !== expected.sentAt || last.hash !== expected.rawSha256)) throw new EvidenceFailure('evidence_changed');
    await assertEvidenceLink(driver, link); await grantFence(driver, link); checkTime(request, now()); abort.signal.throwIfAborted();
    await completeEvidence(driver, link, request, digest, last.item, last.hash);
    await assertEvidenceLink(driver, link); await grantFence(driver, link); checkTime(request, now()); abort.signal.throwIfAborted();
    return { ...binding, status: 'evidence' as const, provider: 'google' as const, accountSubject: identity.sub, mailboxAddress: profile.emailAddress, scopes,
      item: last.item, rawSha256: last.hash, startedAt, completedAt: now(), expiresAt: request.expiresAt, fence: 'current' as const,
      ...(request.operation === 'acquire' ? { rawBytes: last.bytes } : {}) };
  };
  try { return await Promise.race([work(), deadline]); }
  catch (error) { return { ...binding, status: 'held' as const, reason: error instanceof EvidenceFailure ? error.reason : 'provider_unavailable' as const }; }
  finally { clearTimeout(timer); abort.abort(); }
}
