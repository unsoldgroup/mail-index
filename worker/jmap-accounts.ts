import type { D1Driver } from '../src/index/drivers/d1.js';
import { JmapAdapter } from '../src/source/adapters/jmap/index.js';
import type { MailSource } from '../src/source/index.js';
import { accessTokenProvider, decryptRefreshToken, encryptRefreshToken } from './google-oauth.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';

export const DEFAULT_JMAP_SESSION_URL = 'https://mail.unsold.group/.well-known/jmap';

export interface JmapAccountRow {
  account: string; address: string; session_url: string; username: string;
  password_ciphertext: ArrayBuffer; iv: ArrayBuffer; auth_error: string | null;
}

export async function readJmapAccount(driver: D1Driver, account: string): Promise<JmapAccountRow | undefined> {
  return await driver.prepare('SELECT * FROM jmap_accounts WHERE account=?').get(account) as JmapAccountRow | undefined;
}

/**
 * A read-only JMAP source for a stored row. The password is decrypted only when
 * a request is made, and a 401 is recorded as `auth_error` so the scheduler
 * stops syncing the Account until the password is re-saved in /setup.
 */
export function jmapSource(driver: D1Driver, row: Pick<JmapAccountRow, 'account' | 'session_url' | 'username'>, key: string, fetchImpl: typeof fetch): JmapAdapter {
  return new JmapAdapter({
    fetchImpl,
    onUnauthorized: async () => { await driver.prepare('UPDATE jmap_accounts SET auth_error=? WHERE account=?').run('unauthorized', row.account); },
    sessionUrl: row.session_url,
    credentials: async () => {
      const stored = await readJmapAccount(driver, row.account);
      if (!stored) throw new Error(`JMAP Account ${row.account} was removed`);
      return { username: stored.username, password: await decryptRefreshToken(stored.password_ciphertext, stored.iv, key) };
    },
  });
}

/** Build the right source for an Account label: a stored JMAP mailbox, else its Google grant. */
export async function buildAccountSource(driver: D1Driver, env: { TOKEN_ENC_KEY: string; GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }, account: string, fetchImpl: typeof fetch): Promise<MailSource> {
  const jmap = await readJmapAccount(driver, account);
  if (jmap) return jmapSource(driver, jmap, env.TOKEN_ENC_KEY, fetchImpl);
  return new GmailRestAdapter({ fetchImpl, tokenProvider: accessTokenProvider(driver, account, env, fetchImpl) });
}

/**
 * Verify the credentials with a live `check()` and store them. Refuses a label
 * already used by a Google grant, and refuses anything the server rejects.
 */
export async function saveJmapAccount(driver: D1Driver, input: { account: string; address: string; sessionUrl: string; password: string; key: string }, fetchImpl: typeof fetch): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (await driver.prepare('SELECT 1 FROM google_tokens WHERE account=?').get(input.account)) return { ok: false, reason: `"${input.account}" is already a Google Account label` };
  let url: URL;
  try { url = new URL(input.sessionUrl); } catch { return { ok: false, reason: 'session URL is not a valid URL' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'session URL must use https' };
  const identity = await new JmapAdapter({ fetchImpl, sessionUrl: url.toString(), credentials: async () => ({ username: input.address, password: input.password }) }).check();
  if (!identity.ok) return { ok: false, reason: identity.reason ?? 'JMAP login failed' };
  const encrypted = await encryptRefreshToken(input.password, input.key);
  await driver.prepare(`INSERT INTO jmap_accounts(account,address,session_url,username,password_ciphertext,iv,auth_error,created_at)
    VALUES(?,?,?,?,?,?,NULL,?) ON CONFLICT(account) DO UPDATE SET address=excluded.address,session_url=excluded.session_url,
    username=excluded.username,password_ciphertext=excluded.password_ciphertext,iv=excluded.iv,auth_error=NULL`)
    .run(input.account, input.address, url.toString(), input.address, new Uint8Array(encrypted.ciphertext), encrypted.iv, new Date().toISOString());
  return { ok: true };
}
