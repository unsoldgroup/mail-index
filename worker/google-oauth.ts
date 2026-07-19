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

export interface OAuthState { account: string; writes: boolean; redirectUri: string; expiresAt: number }

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

export async function exchangeToken(fetchImpl: typeof fetch, params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const payload = await response.json() as { error?: string; error_description?: string };
  if (!response.ok) throw new Error(`Google token exchange failed: ${payload.error ?? response.status}`);
  return payload as Record<string, unknown>;
}

export async function saveGrant(driver: D1Driver, input: { account: string; address: string; scopes: string[]; refreshToken: string; key: string }): Promise<void> {
  const encrypted = await encryptRefreshToken(input.refreshToken, input.key);
  const now = new Date().toISOString();
  await driver.prepare(`INSERT INTO google_tokens(account,address,scopes,refresh_token_ciphertext,iv,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET address=excluded.address,scopes=excluded.scopes,
    refresh_token_ciphertext=excluded.refresh_token_ciphertext,iv=excluded.iv,updated_at=excluded.updated_at`)
    .run(input.account, input.address, input.scopes.join(' '), new Uint8Array(encrypted.ciphertext), encrypted.iv, now, now);
}

const accessCache = new Map<string, { token: string; expiresAt: number }>();

export function accessTokenProvider(driver: D1Driver, account: string, env: { TOKEN_ENC_KEY: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }, fetchImpl: typeof fetch): () => Promise<string> {
  return async () => {
    const cached = accessCache.get(account);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const row = await driver.prepare('SELECT refresh_token_ciphertext,iv FROM google_tokens WHERE account=?').get(account) as { refresh_token_ciphertext: ArrayBuffer; iv: ArrayBuffer } | undefined;
    if (!row) throw new Error(`No Google grant for Account "${account}"`);
    const refreshToken = await decryptRefreshToken(row.refresh_token_ciphertext, row.iv, env.TOKEN_ENC_KEY);
    const token = await exchangeToken(fetchImpl, { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' });
    const access = String(token['access_token'] ?? '');
    if (!access) throw new Error('Google token exchange returned no access token');
    accessCache.set(account, { token: access, expiresAt: Date.now() + Number(token['expires_in'] ?? 3600) * 1000 });
    return access;
  };
}

export async function verifyGoogleIdentity(fetchImpl: typeof fetch, accessToken: string): Promise<string> {
  const identity = await new GmailRestAdapter({ fetchImpl, tokenProvider: async () => accessToken }).check();
  if (!identity.ok || !identity.address) throw new Error('Connected Google grant could not verify mailbox identity');
  return identity.address;
}
