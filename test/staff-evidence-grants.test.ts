import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { saveGrant, accessTokenProvider, markAuthFailed } from '../dist-worker/worker/google-oauth.js';

const key = Buffer.alloc(32, 19).toString('base64');
const env = { TOKEN_ENC_KEY: key, GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret' };

test('durable generation replacement and local revocation fence cached token consumers', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = new D1Driver(await mf.getD1Database('DB')); await runMigrations(db);
    await saveGrant(db, { account: 'fixture', address: 'fixture@example.test', scopes: ['readonly'], refreshToken: 'fixture-refresh', key });
    let reads = 0;
    const provider = accessTokenProvider(db, 'fixture', env, (async () => { reads++; return Response.json({ access_token: 'fixture-access', expires_in: 3600 }); }) as typeof fetch);
    assert.equal(await provider(), 'fixture-access');
    await db.prepare('UPDATE google_tokens SET locally_disabled=1,grant_generation=grant_generation+1 WHERE account=?').run('fixture');
    await assert.rejects(provider); assert.equal(reads, 1);
    await saveGrant(db, { account: 'fixture', address: 'fixture@example.test', scopes: ['readonly'], refreshToken: 'fixture-replacement', key });
    const row = await db.prepare('SELECT grant_generation,provider_subject,identity_verified_generation FROM google_tokens WHERE account=?').get('fixture');
    assert.deepEqual(row, { grant_generation: 3, provider_subject: null, identity_verified_generation: null });
    assert.equal(await provider(), 'fixture-access');
    await markAuthFailed(db, 'fixture', 'invalid_grant');
    await assert.rejects(provider); assert.equal(reads, 2);
  } finally { await mf.dispose(); }
});

test('replacement during refresh cannot return old-generation access token or clear its failure', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = new D1Driver(await mf.getD1Database('DB')); await runMigrations(db);
    await saveGrant(db, { account: 'race', address: 'fixture@example.test', scopes: ['readonly'], refreshToken: 'fixture-refresh', key });
    const provider = accessTokenProvider(db, 'race', env, (async () => {
      await saveGrant(db, { account: 'race', address: 'fixture@example.test', scopes: ['readonly'], refreshToken: 'fixture-new', key });
      return Response.json({ access_token: 'stale-fixture-access', expires_in: 3600 });
    }) as typeof fetch);
    await assert.rejects(provider, /changed/);
  } finally { await mf.dispose(); }
});

test('contradictory server invalid_grant errors do not retire a usable grant', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
  try {
    const db = new D1Driver(await mf.getD1Database('DB')); await runMigrations(db);
    await saveGrant(db, { account: 'transient', address: 'fixture@example.test', scopes: ['readonly'], refreshToken: 'fixture-refresh', key });
    const provider = accessTokenProvider(db, 'transient', env, (async () => Response.json({ error: 'invalid_grant' }, { status: 503 })) as typeof fetch);
    await assert.rejects(provider);
    assert.deepEqual(await db.prepare('SELECT grant_generation,locally_disabled,auth_error FROM google_tokens WHERE account=?').get('transient'), { grant_generation: 1, locally_disabled: 0, auth_error: null });
  } finally { await mf.dispose(); }
});
