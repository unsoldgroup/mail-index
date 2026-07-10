/**
 * Google OAuth access-token minting for the Worker's direct Gmail REST adapter.
 *
 * The consent flow (auth-handler.ts) stores the Google *refresh* token in KV
 * under {@link GMAIL_REFRESH_TOKEN_KEY}; this module turns it into short-lived
 * access tokens on demand. Tokens are cached in an instance field (Workers keep
 * an isolate warm across requests, so the cache genuinely saves round-trips)
 * with 60s of slack before the advertised expiry.
 *
 * Failure modes are deliberately distinct so the MCP surface can speak to the
 * user precisely:
 *  - no refresh token in KV → plain `Error`: the consent flow never ran.
 *  - Google answers `invalid_grant` → {@link GmailAuthError}: the stored token
 *    was revoked/expired; re-connecting the MCP server from Claude re-runs the
 *    consent flow, and the callback overwrites the stored token.
 */

import { GMAIL_REFRESH_TOKEN_KEY } from './env.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Mint a fresh token this long before the cached one's advertised expiry. */
const EXPIRY_SLACK_MS = 60_000;

/** Message when the consent flow has never stored a refresh token. */
export const NOT_CONNECTED_MESSAGE =
  'Gmail is not connected yet — complete the OAuth consent flow by connecting this MCP server from Claude.';

/**
 * The stored Google grant is broken (revoked, expired, or otherwise rejected).
 * Distinct from a plain `Error` so callers can tell "re-consent needed" apart
 * from transient failures.
 */
export class GmailAuthError extends Error {
  override name = 'GmailAuthError';
}

/**
 * The slice of KV the auth layer needs (reads the refresh token). Structural so
 * tests can pass a stub; a real `KVNamespace` satisfies it.
 */
export interface RefreshTokenStore {
  get(key: string): Promise<string | null>;
}

/** Construction options for {@link GoogleAuth}. */
export interface GoogleAuthOptions {
  /** Google OAuth client id (the Worker's `GOOGLE_CLIENT_ID` secret). */
  clientId: string;
  /** Google OAuth client secret (`GOOGLE_CLIENT_SECRET`). */
  clientSecret: string;
  /** KV namespace holding the refresh token (`OAUTH_KV`). */
  kv: RefreshTokenStore;
  /** Fetch seam for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Google token-endpoint response (only the fields we read). */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class GoogleAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #kv: RefreshTokenStore;
  readonly #fetch: typeof fetch;

  #cached: { accessToken: string; expiresAt: number } | null = null;
  /** In-flight mint, shared so concurrent callers don't stampede the endpoint. */
  #minting: Promise<string> | null = null;

  constructor(options: GoogleAuthOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#kv = options.kv;
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Return a valid access token, minting one from the stored refresh token when
   * the cache is empty or within {@link EXPIRY_SLACK_MS} of expiry.
   * `forceRefresh` drops the cache first — used by the adapter's one-shot 401
   * retry (the cached token may have been revoked server-side).
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) this.#cached = null;
    const cached = this.#cached;
    if (cached && Date.now() < cached.expiresAt - EXPIRY_SLACK_MS) {
      return cached.accessToken;
    }
    this.#minting ??= this.#mint().finally(() => {
      this.#minting = null;
    });
    return this.#minting;
  }

  async #mint(): Promise<string> {
    const refreshToken = await this.#kv.get(GMAIL_REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error(NOT_CONNECTED_MESSAGE);

    const res = await this.#fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    let body: TokenResponse = {};
    try {
      body = (await res.json()) as TokenResponse;
    } catch {
      // Non-JSON error body; fall through to the status-based error below.
    }

    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        throw new GmailAuthError(
          'Google rejected the stored Gmail grant (invalid_grant) — re-connect this MCP server ' +
            'from Claude to re-consent; the OAuth callback overwrites the stored token.' +
            (body.error_description ? ` (Google said: ${body.error_description})` : ''),
        );
      }
      throw new Error(
        `Google token refresh failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ''}).`,
      );
    }

    const expiresInMs = (body.expires_in ?? 0) * 1000;
    this.#cached = { accessToken: body.access_token, expiresAt: Date.now() + expiresInMs };
    return body.access_token;
  }
}
