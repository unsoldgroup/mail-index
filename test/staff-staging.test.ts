import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant, GMAIL_READONLY } from '../dist-worker/worker/google-oauth.js';
import { evidencePolicyDigest } from '../dist-worker/worker/staff-evidence-policy.js';
import { probeStaffIdentity, provisionStaffLink, STAFF_LINK_STAGING_CANDIDATES } from '../dist-worker/worker/staff-staging.js';
import { identityProbeRequestDigest, linkIdentityDigest, stagingDescriptorDigest } from '../dist-worker/worker/staff-staging-contract.js';

const now = 1791288000000;
const candidate = { clientId: 'fixture-client', environment: 'development', enrollmentHandle: 'fixture-handle', account: 'fixture-account' } as const;
const scopes = ['email', GMAIL_READONLY, 'openid'];
const identity = { provider: 'google', account: 'fixture-account', accountSubject: 'fixture-subject', mailboxAddress: 'staff@example.test', emailVerified: true, scopes, grantGeneration: 7, identityVerifiedGeneration: 7 } as const;
const probeRequest = { version: 1, operation: 'identity_probe', operationId: '00000000-0000-4000-8000-000000000001', ...candidate, challenge: '00000000-0000-4000-8000-000000000002', issuedAt: now, expiresAt: now + 60000 } as const;
const probeProps = { clientId: candidate.clientId, environment: candidate.environment, permission: 'staff_identity_probe' };
const stagingProps = { ...probeProps, permission: 'staff_link_staging' };
const identityDigest = '498ea25a26232ce9dc38b08cf628da85a23b7a6b5d9da73588b295fdfafb5a9f';
const base = { version: 1, clientId: candidate.clientId, environment: candidate.environment, enrollmentHandle: candidate.enrollmentHandle, account: candidate.account, accountSubject: identity.accountSubject, mailboxAddress: identity.mailboxAddress, identityDigest, actorUserId: 'fixture-admin', ownerUserId: 'fixture-owner', allowedAliases: ['staff@example.test'], policyVersion: 1, grantGeneration: 7, enrollmentGeneration: 1, priorLocalGeneration: 0, priorRemoteGeneration: 0, priorRemoteDigest: null };
const op = (n: number) => `00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;
const staging = (operation: 'stage' | 'status' | 'revoke', operationId: string, descriptor: Record<string, unknown> = base) =>
  ({ version: 1, operation, operationId, descriptor, challenge: '00000000-0000-4000-8000-000000000003', issuedAt: now, expiresAt: now + 60000 });

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver);
  const env = { DB: driver.db, TOKEN_ENC_KEY: Buffer.alloc(32, 12).toString('base64'), GOOGLE_CLIENT_ID: 'fixture-google', GOOGLE_CLIENT_SECRET: 'fixture-secret' };
  await saveGrant(driver, { account: candidate.account, address: identity.mailboxAddress, scopes: [GMAIL_READONLY], refreshToken: 'fixture-refresh', key: env.TOKEN_ENC_KEY });
  await driver.prepare('UPDATE google_tokens SET grant_generation=7 WHERE account=?').run(candidate.account);
  const calls: string[] = []; const provider = { scope: `openid email ${GMAIL_READONLY}`, sub: identity.accountSubject };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope: provider.scope });
    if (url.endsWith('/userinfo')) return Response.json({ sub: provider.sub, email: identity.mailboxAddress, email_verified: true });
    if (url.endsWith('/profile')) return Response.json({ emailAddress: identity.mailboxAddress });
    throw new Error('Unexpected provider request');
  }) as typeof fetch;
  const options = (candidates: readonly unknown[] = [candidate]) => ({ candidates: candidates as never, fetchImpl, now: () => now });
  const probe = (request: unknown = probeRequest, candidates?: readonly unknown[], props: unknown = probeProps) => probeStaffIdentity(env as never, props, request, options(candidates));
  const provision = (request: unknown, candidates?: readonly unknown[], props: unknown = stagingProps) => provisionStaffLink(env as never, props, request, options(candidates));
  const rows = (table: string) => driver.prepare(`SELECT * FROM ${table}`).all() as Promise<Record<string, unknown>[]>;
  return { mf, driver, calls, provider, probe, provision, rows };
}

test('digests are identical to vectors captured from the Expedition contract', async () => {
  assert.equal(await linkIdentityDigest(candidate, identity), identityDigest);
  assert.equal(await identityProbeRequestDigest(probeRequest), '0c097f08ae78b2d1e63c7aae498e3d600dc4d4f3e5279e73aab86a806db6bf4d');
  assert.equal(await stagingDescriptorDigest(base), 'ce702622fb96b531e5abcdf4e366842eb25c005d07071cf28c1b85467ad4a7e4');
  assert.equal(await evidencePolicyDigest(base as never), 'ccf95b15f7c4537db86279b491f52a11d3c3a9db2d7e4a182bdc322c5c438f96');
  // EI scripts/__tests__/fixtures/staff-link-policy-vector.json (shared with convex/__tests__/staffMailboxLinkStaging.test.ts).
  assert.equal(await evidencePolicyDigest({ clientId: 'fixture-client', environment: 'development', enrollmentHandle: 'fixture-handle', enrollmentGeneration: 3, grantGeneration: 7, account: 'fixture-account', accountSubject: 'fixture-subject', mailboxAddress: 'staff@example.test' }),
    'f400845d708246a143a7ad0c0827c334694132cb97ee263d789b5c9b5d0fe439');
});

test('ships disabled: no candidates means no probe, no stage, no provider read, no row', async () => {
  assert.equal(STAFF_LINK_STAGING_CANDIDATES.length, 0);
  const f = await fixture(); try {
    await assert.rejects(() => f.probe(probeRequest, []), /disabled/);
    await assert.rejects(() => f.provision(staging('stage', op(1)), []), /disabled/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.rows('staff_staging_operations')).length, 0);
    assert.equal((await f.rows('staff_evidence_links')).length, 0);
  } finally { await f.mf.dispose(); }
});

test('identity probe is a separate read-only capability bound to its request', async () => {
  const f = await fixture(); try {
    await assert.rejects(() => f.probe(probeRequest, undefined, stagingProps));
    await assert.rejects(() => f.provision(staging('stage', op(1)), undefined, probeProps));
    await assert.rejects(() => f.probe(probeRequest, undefined, { ...probeProps, clientId: 'other' }));
    const result = await f.probe();
    assert.deepEqual(result.identity, identity);
    assert.equal(result.requestDigest, await identityProbeRequestDigest(probeRequest));
    assert.equal(result.challenge, probeRequest.challenge); assert.equal(result.expiresAt, probeRequest.expiresAt);
    assert.equal((await f.rows('staff_staging_operations')).length, 0);
    assert.equal((await f.rows('staff_evidence_links')).length, 0);
    assert.equal((await f.rows('google_tokens'))[0].provider_subject, null);
  } finally { await f.mf.dispose(); }
});

test('stage recomputes the observed identity digest; a changed identity writes nothing', async () => {
  const f = await fixture(); try {
    f.provider.scope = `openid email ${GMAIL_READONLY} https://www.googleapis.com/auth/drive`;
    await assert.rejects(() => f.provision(staging('stage', op(1))), /identity mismatch/);
    f.provider.sub = 'other-subject';
    await assert.rejects(() => f.provision(staging('stage', op(1))));
    await assert.rejects(() => f.provision(staging('stage', op(1), { ...base, identityDigest: 'a'.repeat(64) })));
    assert.equal((await f.rows('staff_staging_operations')).length, 0);
    assert.equal((await f.rows('staff_evidence_links')).length, 0);
  } finally { await f.mf.dispose(); }
});

test('stage writes only a disabled link at the exact generation; replay and status are idempotent', async () => {
  const f = await fixture(); try {
    const staged = await f.provision(staging('stage', op(1)));
    assert.equal(staged.state, 'staged'); assert.equal(staged.enabled, false); assert.equal(staged.enrollmentGeneration, 1);
    assert.equal(staged.descriptorDigest, await stagingDescriptorDigest(base));
    assert.equal(staged.policyDigest, await evidencePolicyDigest(base as never));
    const links = await f.rows('staff_evidence_links');
    assert.equal(links.length, 1); assert.equal(links[0].enabled, 0); assert.equal(links[0].enrollment_generation, 1);
    assert.equal((await f.provision(staging('stage', op(1)))).state, 'staged');
    const before = f.calls.length;
    const status = await f.provision(staging('status', op(1)), []);
    assert.equal(status.state, 'staged'); assert.equal(status.enabled, false); assert.equal(f.calls.length, before);
    await assert.rejects(() => f.provision(staging('status', op(9)), []), /unavailable/);
    await assert.rejects(() => f.provision(staging('stage', op(2))), /unavailable/);
    await assert.rejects(() => f.provision(staging('status', op(1), { ...base, ownerUserId: 'someone-else' })), /unavailable/);
    assert.equal((await f.rows('staff_staging_operations')).length, 1);
  } finally { await f.mf.dispose(); }
});

test('generation CAS requires the last confirmed generation and digest, and never displaces an enabled link', async () => {
  const f = await fixture(); try {
    const first = await f.provision(staging('stage', op(1)));
    const next = { ...base, enrollmentGeneration: 2, priorLocalGeneration: 1, priorRemoteGeneration: 1, priorRemoteDigest: first.policyDigest };
    await assert.rejects(() => f.provision(staging('stage', op(2), { ...next, priorRemoteDigest: 'b'.repeat(64) })));
    await assert.rejects(() => f.provision(staging('stage', op(3), { ...next, priorRemoteGeneration: 0, priorRemoteDigest: null })));
    await f.driver.prepare('UPDATE staff_evidence_links SET enabled=1').run();
    await assert.rejects(() => f.provision(staging('stage', op(4), next)));
    await f.driver.prepare('UPDATE staff_evidence_links SET enabled=0').run();
    const second = await f.provision(staging('stage', op(5), next));
    assert.equal(second.state, 'staged'); assert.equal(second.enrollmentGeneration, 2);
    const links = await f.rows('staff_evidence_links');
    assert.equal(links.length, 1); assert.equal(links[0].enrollment_generation, 2); assert.equal(links[0].enabled, 0);
  } finally { await f.mf.dispose(); }
});

test('revoke works with staging disabled, tombstones the operation and touches only its exact generation', async () => {
  const f = await fixture(); try {
    const first = await f.provision(staging('stage', op(1)));
    const next = { ...base, enrollmentGeneration: 2, priorLocalGeneration: 1, priorRemoteGeneration: 1, priorRemoteDigest: first.policyDigest };
    await f.provision(staging('stage', op(2), next));
    await f.driver.prepare('UPDATE staff_evidence_links SET enabled=1').run(); // later generation activated elsewhere
    const before = f.calls.length;
    const revoked = await f.provision(staging('revoke', op(1)), []);
    assert.equal(revoked.state, 'revoked'); assert.equal(revoked.enabled, false); assert.equal(f.calls.length, before);
    const links = await f.rows('staff_evidence_links');
    assert.equal(links[0].enrollment_generation, 2); assert.equal(links[0].enabled, 1);
    assert.equal((await f.provision(staging('stage', op(1)))).state, 'revoked');
    assert.equal((await f.provision(staging('status', op(1)), [])).state, 'revoked');
    await assert.rejects(() => f.provision(staging('revoke', op(1), { ...base, ownerUserId: 'someone-else' }), []), /conflict/);
    await f.provision(staging('revoke', op(2), next), []);
    assert.equal((await f.rows('staff_evidence_links'))[0].enabled, 0);
  } finally { await f.mf.dispose(); }
});

test('revoke before an unknown stage outcome lands cancels it permanently', async () => {
  const f = await fixture(); try {
    assert.equal((await f.provision(staging('revoke', op(1)), [])).state, 'revoked');
    const before = f.calls.length;
    assert.equal((await f.provision(staging('stage', op(1)))).state, 'revoked');
    assert.equal(f.calls.length, before);
    assert.equal((await f.rows('staff_evidence_links')).length, 0);
  } finally { await f.mf.dispose(); }
});

test('rotated grant generation cannot stage', async () => {
  const f = await fixture(); try {
    await f.driver.prepare('UPDATE google_tokens SET grant_generation=8').run();
    await assert.rejects(() => f.provision(staging('stage', op(1))));
    assert.equal((await f.rows('staff_staging_operations')).length, 0);
  } finally { await f.mf.dispose(); }
});

test('a failed CAS leaves the grant identity untouched', async () => {
  const f = await fixture(); try {
    await f.driver.prepare(`INSERT INTO staff_evidence_links(client_id,environment,enrollment_handle,enrollment_generation,policy_digest,enabled,updated_at) VALUES(?,?,?,5,?,0,0)`).run(base.clientId, base.environment, base.enrollmentHandle, 'c'.repeat(64));
    await assert.rejects(() => f.provision(staging('stage', op(1))));
    const grant = (await f.rows('google_tokens'))[0];
    assert.equal(grant.provider_subject, null); assert.equal(grant.identity_verified_generation, null);
    assert.equal((await f.rows('staff_staging_operations')).length, 0);
  } finally { await f.mf.dispose(); }
});

test('revoked link rows are distinguishable, can never be enabled, and remain a valid CAS prior', async () => {
  const f = await fixture(); try {
    const first = await f.provision(staging('stage', op(1)));
    assert.equal((await f.rows('staff_evidence_links'))[0].revoked_at, null);
    await f.provision(staging('revoke', op(1)), []);
    const link = (await f.rows('staff_evidence_links'))[0];
    assert.equal(link.revoked_at, now); assert.equal(link.enabled, 0);
    await assert.rejects(() => f.driver.prepare('UPDATE staff_evidence_links SET enabled=1').run(), /CHECK constraint/);
    const next = { ...base, enrollmentGeneration: 2, priorLocalGeneration: 1, priorRemoteGeneration: 1, priorRemoteDigest: first.policyDigest };
    assert.equal((await f.provision(staging('stage', op(2), next))).state, 'staged');
    const staged = (await f.rows('staff_evidence_links'))[0];
    assert.equal(staged.enrollment_generation, 2); assert.equal(staged.revoked_at, null); assert.equal(staged.enabled, 0);
  } finally { await f.mf.dispose(); }
});
