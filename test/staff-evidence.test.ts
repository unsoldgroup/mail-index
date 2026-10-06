import { evidencePolicyDigest } from '../dist-worker/worker/staff-evidence-policy.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant, GMAIL_READONLY } from '../dist-worker/worker/google-oauth.js';
import { readStaffSentEvidence } from '../dist-worker/worker/staff-evidence-reader.js';
import { staffServiceRequestDigest } from '../dist-worker/worker/staff-evidence-contract.js';

const now = 1791288000000;
const request = { version: 1, operation: 'acquire', environment: 'development', enrollmentHandle: 'fixture-enrollment', expectedEnrollmentGeneration: 3, expectedGrantGeneration: 7, challenge: 'A'.repeat(43), observationId: 'fixture-observation', originalMessageId: '<reply@example.com>', forwardMessageId: '<forward@example.com>', observedReceivedAt: now, issuedAt: now, expiresAt: now + 60000 } as const;
const props = { clientId: 'fixture-client', environment: 'development', permission: 'staff_sent_evidence' };
const link = { clientId: props.clientId, environment: 'development', enrollmentHandle: request.enrollmentHandle, enrollmentGeneration: 3, grantGeneration: 7, account: 'fixture-account', accountSubject: 'fixture-sub', mailboxAddress: 'fixture@example.test' } as const;
const raw = Buffer.from('Message-ID: <reply@example.com>\r\nFrom: fixture@example.test\r\n\r\nSynthetic authored material\r\n');
async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  const driver = new D1Driver(await mf.getD1Database('DB')); await runMigrations(driver);
  const env = { DB: driver.db, TOKEN_ENC_KEY: Buffer.alloc(32, 12).toString('base64'), GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret' };
  await saveGrant(driver, { account: link.account, address: link.mailboxAddress, scopes: [GMAIL_READONLY], refreshToken: 'fixture-refresh', key: env.TOKEN_ENC_KEY });
  await driver.prepare('UPDATE google_tokens SET grant_generation=7 WHERE account=?').run(link.account);
  await driver.prepare('INSERT INTO staff_evidence_links(client_id,environment,enrollment_handle,enrollment_generation,policy_digest,enabled,updated_at) VALUES(?,?,?,?,?,1,?)').run(link.clientId, link.environment, link.enrollmentHandle, link.enrollmentGeneration, await evidencePolicyDigest(link), now);
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope: `openid email ${GMAIL_READONLY}` });
    if (url.endsWith('/userinfo')) return Response.json({ sub: link.accountSubject, email: link.mailboxAddress, email_verified: true });
    if (url.endsWith('/profile')) return Response.json({ emailAddress: link.mailboxAddress });
    if (url.includes('/messages?')) return Response.json({ messages: [{ id: 'fixture-item' }] });
    if (url.includes('/messages/fixture-item?')) return Response.json({ id: 'fixture-item', historyId: 'v1', internalDate: String(now - 1000), labelIds: ['SENT'], raw: raw.toString('base64url') });
    throw new Error('Unexpected provider request');
  }) as typeof fetch;
  const read = (value: unknown = request, policy = [link], caller: unknown = props, provider = fetchImpl) => readStaffSentEvidence(env as never, caller, value, { policy, fetchImpl: provider, now: () => now });
  return { mf, driver, env, calls, fetchImpl, read };
}
test('protocol digest is identical to Expedition fixed vector', async () => {
  assert.equal(await staffServiceRequestDigest(request), '8ff78f661a20766757de67796e6274ccbbbedec772cb84f00dff70fe2c211279');
});
test('empty policy and invalid caller trigger no provider reads', async () => {
  const f = await fixture(); try {
    assert.equal((await f.read(request, [])).status, 'held');
    await assert.rejects(() => f.read(request, [link], { ...props, clientId: 'wrong', account: link.account }));
    assert.equal(f.calls.length, 0);
  } finally { await f.mf.dispose(); }
});
test('atomic challenge reservation permits one reader and binary result; replay across operation cannot read again', async () => {
  const f = await fixture(); try {
    const results = await Promise.all([f.read(), f.read()]);
    assert.equal(results.filter(result => result.status === 'evidence').length, 1);
    const evidence = results.find(result => result.status === 'evidence')!;
    assert.deepEqual(evidence.rawBytes, new Uint8Array(raw));
    assert.equal(f.calls.filter(url => url.includes('/messages?')).length, 1);
    const before = f.calls.length;
    const replay = await f.read({ ...request, operation: 'release_recheck', expectedItem: { acquisitionChallenge: 'B'.repeat(43), acquisitionRequestDigest: evidence.requestDigest, id: evidence.item.id, version: evidence.item.version, sentAt: evidence.item.sentAt, rawSha256: evidence.rawSha256 } });
    assert.equal(replay.status, 'held'); assert.equal(f.calls.length, before);
    const rows = await f.driver.prepare('SELECT * FROM staff_evidence_challenges').all();
    assert.ok(!JSON.stringify(rows).includes('Synthetic authored material'));
  } finally { await f.mf.dispose(); }
});
test('fresh recheck binds completed acquisition and never searches', async () => {
  const f = await fixture(); try {
    const evidence = await f.read(); assert.equal(evidence.status, 'evidence'); if (evidence.status !== 'evidence') return;
    const before = f.calls.length;
    const result = await f.read({ ...request, operation: 'recheck', challenge: 'B'.repeat(43), expectedItem: { acquisitionChallenge: request.challenge, acquisitionRequestDigest: evidence.requestDigest, id: evidence.item.id, version: evidence.item.version, sentAt: evidence.item.sentAt, rawSha256: evidence.rawSha256 } });
    assert.equal(result.status, 'evidence'); assert.ok(!('rawBytes' in result));
    assert.ok(f.calls.slice(before).every(url => !url.includes('/messages?')));
  } finally { await f.mf.dispose(); }
});
for (const failure of ['missing-scope', 'wrong-sub', 'draft', 'multiple', 'changed', 'malformed-raw'] as const) test(`provider evidence holds ${failure}`, async () => {
  const f = await fixture(); let rawReads = 0;
  try {
    const provider = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failure === 'missing-scope' && url.endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope: GMAIL_READONLY });
      if (failure === 'wrong-sub' && url.endsWith('/userinfo')) return Response.json({ sub: 'wrong-sub', email: link.mailboxAddress, email_verified: true });
      if (failure === 'multiple' && url.includes('/messages?')) return Response.json({ messages: [{ id: 'one' }, { id: 'two' }] });
      if (url.includes('/messages/fixture-item?')) {
        rawReads++;
        return Response.json({ id: 'fixture-item', historyId: failure === 'changed' && rawReads > 1 ? 'v2' : 'v1', internalDate: String(now - 1000), labelIds: failure === 'draft' ? ['SENT', 'DRAFT'] : ['SENT'], raw: failure === 'malformed-raw' ? '%%%not-base64' : raw.toString('base64url') });
      }
      return f.fetchImpl(input);
    }) as typeof fetch;
    assert.equal((await f.read(request, [link], props, provider)).status, 'held');
  } finally { await f.mf.dispose(); }
});

test('revocation during RAW retrieval holds and never completes the acquisition', async () => {
  const f = await fixture(); try {
    const provider = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/messages/fixture-item?')) await f.driver.prepare('UPDATE google_tokens SET locally_disabled=1,grant_generation=grant_generation+1 WHERE account=?').run(link.account);
      return f.fetchImpl(input);
    }) as typeof fetch;
    const result = await f.read(request, [link], props, provider);
    assert.equal(result.status, 'held');
    assert.deepEqual(await f.driver.prepare('SELECT state FROM staff_evidence_challenges').all(), [{ state: 'claimed' }]);
  } finally { await f.mf.dispose(); }
});

test('whole-operation deadline releases a stalled body without waiting for cancel', async () => {
  const f = await fixture(); try {
    const provider = (async () => new Response(new ReadableStream({ pull() { return new Promise(() => undefined); }, cancel() { return new Promise(() => undefined); } }))) as typeof fetch;
    const result = await f.read({ ...request, expiresAt: now + 20 }, [link], props, provider);
    assert.equal(result.status, 'held');
    if (result.status === 'held') assert.equal(result.reason, 'provider_unavailable');
  } finally { await f.mf.dispose(); }
});

test('successful acquisition linkage survives60seconds but old acquisition challenges stay consumed', async () => {
  const f = await fixture(); try {
    const evidence = await f.read(); assert.equal(evidence.status, 'evidence'); if (evidence.status !== 'evidence') return;
    const later = now + 120000;
    const next = { ...request, operation: 'release_recheck', challenge: 'C'.repeat(43), issuedAt: later, expiresAt: later + 60000,
      expectedItem: { acquisitionChallenge: request.challenge, acquisitionRequestDigest: evidence.requestDigest, id: evidence.item.id, version: evidence.item.version, sentAt: evidence.item.sentAt, rawSha256: evidence.rawSha256 } };
    const result = await readStaffSentEvidence(f.env as never, props, next, { policy: [link], fetchImpl: f.fetchImpl, now: () => later });
    assert.equal(result.status, 'evidence');
    const repeated = await f.read({ ...request, issuedAt: later, expiresAt: later + 60000 });
    assert.equal(repeated.status, 'held');
  } finally { await f.mf.dispose(); }
});

for (const change of ['disabled', 'generation', 'digest'] as const) test(`durable link ${change} fences an old code-policy isolate before provider reads`, async () => {
  const f = await fixture(); try {
    const sql = change === 'disabled' ? 'UPDATE staff_evidence_links SET enabled=0' : change === 'generation' ? 'UPDATE staff_evidence_links SET enrollment_generation=enrollment_generation+1' : "UPDATE staff_evidence_links SET policy_digest='different'";
    await f.driver.prepare(sql).run();
    assert.equal((await f.read()).status, 'held'); assert.equal(f.calls.length, 0);
  } finally { await f.mf.dispose(); }
});
test('link revocation during provider read cannot complete or return evidence', async () => {
  const f = await fixture(); try {
    const provider = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/messages/fixture-item?')) await f.driver.prepare('UPDATE staff_evidence_links SET enabled=0').run();
      return f.fetchImpl(input);
    }) as typeof fetch;
    assert.equal((await f.read(request, [link], props, provider)).status, 'held');
    assert.deepEqual(await f.driver.prepare('SELECT state FROM staff_evidence_challenges').all(), [{ state: 'claimed' }]);
  } finally { await f.mf.dispose(); }
});

for (const emailScope of ['email', 'https://www.googleapis.com/auth/userinfo.email']) test(`accepts exact Google email scope ${emailScope} with fresh immutable identity`, async () => {
  const f = await fixture(); try {
    const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope: `openid ${emailScope} ${GMAIL_READONLY}` });
      return f.fetchImpl(input, init);
    }) as typeof fetch;
    const evidence = await f.read(request, [link], props, provider);
    assert.equal(evidence.status, 'evidence');
    assert.ok(f.calls.some(url => url.endsWith('/userinfo')));
    assert.ok(f.calls.some(url => url.endsWith('/profile')));
  } finally { await f.mf.dispose(); }
});
for (const scope of [
  `openid https://www.googleapis.com/auth/userinfo.profile ${GMAIL_READONLY}`,
  `https://www.googleapis.com/auth/userinfo.email ${GMAIL_READONLY}`,
  'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
  `openid https://www.googleapis.com/auth/userinfo.email.attacker ${GMAIL_READONLY}`,
]) test(`rejects insufficient or lookalike scope set ${scope}`, async () => {
  const f = await fixture(); try {
    const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/token')) return Response.json({ access_token: 'fixture-access', expires_in: 3600, scope });
      return f.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await f.read(request, [link], props, provider);
    assert.equal(result.status, 'held');
    if (result.status === 'held') assert.equal(result.reason, 'missing_grant');
    assert.ok(!f.calls.some(url => url.includes('/messages')));
  } finally { await f.mf.dispose(); }
});
