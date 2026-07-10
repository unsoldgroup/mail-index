import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** Bindings + vars for the mail-index Worker. Secrets are set via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into handler envs. */
  OAUTH_PROVIDER: OAuthHelpers;

  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;

  ACCOUNT: string;
  ALLOWED_EMAIL: string;
  SYNC_QUERY?: string;
  INCLUDE_SENT?: string;
  MAX_META_PER_RUN?: string;
  MAX_ENRICH_PER_RUN?: string;
}

/** KV key holding the Google refresh token captured during the consent flow. */
export const GMAIL_REFRESH_TOKEN_KEY = 'gmail_refresh_token';
