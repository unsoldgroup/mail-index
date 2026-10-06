import type { D1Driver } from '../src/index/drivers/d1.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';

export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

function keyBytes(encoded: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
  if (bytes.byteLength !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes encoded as base64');
  return bytes;
}

async function aesKey(encoded: string) {
  return crypto.subtle.importKey('raw', keyBytes(encoded), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptRefreshToken(token: string, encodedKey: string): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(encodedKey), new TextEncoder().encode(token));
  return { ciphertext, iv };
}

function binary(value: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value);
}

export async function decryptRefreshToken(ciphertext: ArrayBuffer | ArrayBufferView | number[], iv: ArrayBuffer | ArrayBufferView | number[], encodedKey: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: binary(iv) }, await aesKey(encodedKey), binary(ciphertext));
  return new TextDecoder().decode(plain);
}

async function hmacKey(encoded: string) {
  return crypto.subtle.importKey('raw', keyBytes(encoded), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * `login: true` marks an identity-only round trip: the operator is proving who
 * they are to reach `/setup`, not connecting a mailbox. It reuses the
 * `/setup/google/callback` redirect URI so operators register only the two
 * callbacks INSTALL-worker.md already lists, and carries no account/writes.
 */
export interface OAuthState { account: string; writes: boolean; redirectUri: string; expiresAt: number; login?: boolean }

export async function signState(state: OAuthState, encodedKey: string): Promise<string> {
  return signPayload(state, encodedKey);
}

export async function signPayload(state: object, encodedKey: string): Promise<string> {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(encodedKey), new TextEncoder().encode(payload));
  return `${payload}.${Buffer.from(signature).toString('base64url')}`;
}

export async function verifyState(value: string, encodedKey: string): Promise<OAuthState> {
  return verifyPayload<OAuthState>(value, encodedKey);
}

export async function verifyPayload<T>(value: string, encodedKey: string): Promise<T> {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) throw new Error('Invalid OAuth state');
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(encodedKey), Buffer.from(signature, 'base64url'), new TextEncoder().encode(payload));
  if (!valid) throw new Error('Invalid OAuth state');
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T & { expiresAt?: number };
  if (state.expiresAt != null && state.expiresAt < Date.now()) throw new Error('Expired OAuth state');
  return state;
}

class GoogleTokenExchangeError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Google token exchange failed: ${code}`); }
}
export async function exchangeToken(fetchImpl: typeof fetch, params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const payload = await response.json() as { error?: string; error_description?: string };
  if (!response.ok) throw new GoogleTokenExchangeError(response.status, payload.error ?? String(response.status));
  return payload as Record<string, unknown>;
}

// Per database, account, client and generation; never shared across independent DBs.
const accessCaches = new WeakMap<object, Map<string, { token: string; expiresAt: number; generation: number }>>();
function accessCache(driver: D1Driver) {
  let cache = accessCaches.get(driver.db);
  if (!cache) { cache = new Map(); accessCaches.set(driver.db, cache); }
  return cache;
}
export interface GoogleGrant {
  address: string; scopes: string; effective_scopes: string | null; provider_subject: string | null;
  identity_verified_generation: number | null; grant_generation: number; locally_disabled: number;
  auth_error: string | null; refresh_token_ciphertext: ArrayBuffer; iv: ArrayBuffer;
}
/** Direct D1 binding (not Sessions API) routes all reads to primary. Never pass
 * a replica session here: revocation must see current durable grant state.
 * https://developers.cloudflare.com/d1/best-practices/read-replication/ */
export async function readGoogleGrant(driver: D1Driver, account: string): Promise<GoogleGrant | undefined> {
  return await driver.prepare('SELECT * FROM google_tokens WHERE account=?').get(account) as GoogleGrant | undefined;
}

/** A consent that would repoint an existing Account label at a different mailbox. */
export class AccountMismatchError extends Error {
  constructor(readonly account: string, readonly existing: string, readonly attempted: string) {
    super(`Account "${account}" is already connected to ${existing}. Connect ${attempted} under a different account label instead.`);
    this.name = 'AccountMismatchError';
  }
}

/**
 * Persist a Google grant under an Account label.
 *
 * Re-consent for the SAME mailbox is the supported path — it replaces scopes
 * (this is how `&writes=1` upgrades a read-only grant). Re-consent under the
 * same label with a DIFFERENT mailbox is refused: the upsert keys on the label,
 * so it would silently repoint that Account at another mailbox and every later
 * sync would file the wrong mail under it. Operators hit this by re-running the
 * consent link without editing `?account=`.
 */
export async function saveGrant(driver: D1Driver, input: { account: string; address: string; scopes: string[]; refreshToken: string; key: string }): Promise<void> {
  const existing = await driver.prepare('SELECT address FROM google_tokens WHERE account=?').get(input.account) as { address: string } | undefined;
  if (existing && existing.address.toLowerCase() !== input.address.toLowerCase()) {
    throw new AccountMismatchError(input.account, existing.address, input.address);
  }
  const encrypted = await encryptRefreshToken(input.refreshToken, input.key);
  const now = new Date().toISOString();
  await driver.prepare(`INSERT INTO google_tokens(account,address,scopes,refresh_token_ciphertext,iv,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET address=excluded.address,scopes=excluded.scopes,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,iv=excluded.iv,updated_at=excluded.updated_at,
    grant_generation=google_tokens.grant_generation+1,locally_disabled=0,auth_error=NULL,auth_failed_at=NULL,
    provider_subject=NULL,effective_scopes=NULL,identity_verified_generation=NULL`)
    .run(input.account, input.address, input.scopes.join(' '), new Uint8Array(encrypted.ciphertext), encrypted.iv, now, now);
  accessCache(driver).clear();
}

/**
 * Google's terminal answer for a refresh token that can no longer be traded:
 * revoked, expired (a Testing-mode consent screen expires them every 7 days),
 * or issued under credentials that have since changed. Retrying never helps —
 * only re-consent does, which is why this alone is recorded as auth failure.
 */
export const INVALID_GRANT = 'invalid_grant';

/** Record the Account as needing re-consent. Terminal states only — see {@link INVALID_GRANT}. */
export async function markAuthFailed(driver: D1Driver, account: string, error: string, expectedGeneration?: number): Promise<void> {
  await driver.prepare(`UPDATE google_tokens SET auth_error=?,auth_failed_at=?,
    grant_generation=grant_generation+1,locally_disabled=1,provider_subject=NULL,identity_verified_generation=NULL
    WHERE account=? AND locally_disabled=0 AND (? IS NULL OR grant_generation=?)`)
    .run(error, new Date().toISOString(), account, expectedGeneration ?? null, expectedGeneration ?? null);
  accessCache(driver).clear();
}

/** Clear a previously recorded auth failure. No-op when the Account is already healthy. */
export async function clearAuthFailure(driver: D1Driver, account: string): Promise<void> {
  await driver.prepare('UPDATE google_tokens SET auth_error=NULL,auth_failed_at=NULL WHERE account=? AND auth_error IS NOT NULL')
    .run(account);
}

export function accessTokenProvider(driver: D1Driver, account: string, env: { TOKEN_ENC_KEY: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }, fetchImpl: typeof fetch): () => Promise<string> {
  return async () => {
    const row = await readGoogleGrant(driver, account);
    if (!row || row.locally_disabled || row.auth_error) throw new Error('Google grant unavailable');
    const cache = accessCache(driver); const cacheKey = `${account}\n${env.GOOGLE_CLIENT_ID}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.generation === row.grant_generation && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const refreshToken = await decryptRefreshToken(row.refresh_token_ciphertext, row.iv, env.TOKEN_ENC_KEY);
    let token: Record<string, unknown>;
    try {
      token = await exchangeToken(fetchImpl, { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' });
    } catch (error) {
      // A dead grant is durable state, not a transient job failure: record it so
      // the scheduler stops sweeping this Account and every read can say why.
      if (error instanceof GoogleTokenExchangeError && error.status === 400 && error.code === INVALID_GRANT) await markAuthFailed(driver, account, INVALID_GRANT, row.grant_generation);
      throw error;
    }
    const access = String(token['access_token'] ?? '');
    if (!access) throw new Error('Google token exchange returned no access token');
    const latest = await readGoogleGrant(driver, account);
    if (!latest || latest.grant_generation !== row.grant_generation || latest.locally_disabled || latest.auth_error) throw new Error('Google grant changed during refresh');
    if (typeof token['scope'] === 'string') await driver.prepare('UPDATE google_tokens SET effective_scopes=? WHERE account=? AND grant_generation=? AND locally_disabled=0').run(token['scope'], account, row.grant_generation);
    const finalGrant = await readGoogleGrant(driver, account);
    if (!finalGrant || finalGrant.grant_generation !== row.grant_generation || finalGrant.locally_disabled || finalGrant.auth_error) throw new Error('Google grant changed during refresh');
    cache.set(cacheKey, { token: access, generation: row.grant_generation, expiresAt: Date.now() + Number(token['expires_in'] ?? 3600) * 1000 });
    return access;
  };
}

export async function verifyGoogleIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<string> {
  const identity = await new GmailRestAdapter({ fetchImpl, tokenProvider: async () => accessToken }).check();
  if (!identity.ok || !identity.address) throw new Error('Connected Google grant could not verify mailbox identity');
  return identity.address;
}
