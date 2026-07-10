/**
 * Default (non-API) handler behind OAuthProvider: implements the upstream
 * Google leg of the OAuth dance. `/authorize` sends the user to Google
 * consent requesting gmail.readonly + offline access; `/callback` verifies
 * the account is ALLOWED_EMAIL, captures the Gmail refresh token into KV
 * for the sync pipeline, and completes the MCP grant.
 */
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { GMAIL_REFRESH_TOKEN_KEY, type Env } from './env.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];
const VERIFIER_COOKIE = 'mi_pkce_verifier';

function base64UrlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

function encodeState(req: AuthRequest): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(req)));
}

function decodeState(state: string): AuthRequest {
  const b64 = state.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as AuthRequest;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/callback`;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return new Response('unknown client', { status: 400 });

  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  target.searchParams.set('redirect_uri', callbackUrl(request));
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  target.searchParams.set('access_type', 'offline');
  // Force the consent screen so Google re-issues a refresh token every time;
  // the callback overwrites KV, which is also the re-auth path after revocation.
  target.searchParams.set('prompt', 'consent');
  target.searchParams.set('login_hint', env.ALLOWED_EMAIL);
  target.searchParams.set('code_challenge', await sha256Base64Url(verifier));
  target.searchParams.set('code_challenge_method', 'S256');
  target.searchParams.set('state', encodeState(authRequest));

  const headers = new Headers({ Location: target.toString() });
  headers.append(
    'Set-Cookie',
    `${VERIFIER_COOKIE}=${verifier}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
  );
  return new Response(null, { status: 302, headers });
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

/** Decode the (Google-signed) id_token payload. We just exchanged the code over
 * TLS directly with Google, so the token is trusted without re-verifying the
 * signature — same trust base as calling the userinfo endpoint. */
function idTokenEmail(idToken: string): { email?: string; email_verified?: boolean } {
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return JSON.parse(atob(b64)) as { email?: string; email_verified?: boolean };
  } catch {
    return {};
  }
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return new Response(`Google authorization failed: ${error}`, { status: 400 });
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return new Response('missing code/state', { status: 400 });

  let authRequest: AuthRequest;
  try {
    authRequest = decodeState(state);
  } catch {
    return new Response('invalid state', { status: 400 });
  }
  const verifier = readCookie(request, VERIFIER_COOKIE);
  if (!verifier) return new Response('missing PKCE verifier cookie (retry the flow)', { status: 400 });

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl(request),
    }),
  });
  if (!tokenResponse.ok) {
    const detail = await tokenResponse.text();
    return new Response(`Google token exchange failed: ${detail}`, { status: 502 });
  }
  const tokens = (await tokenResponse.json()) as GoogleTokenResponse;

  const claims = idTokenEmail(tokens.id_token ?? '');
  const email = claims.email?.toLowerCase();
  const allowed = env.ALLOWED_EMAIL.toLowerCase();
  if (!email || claims.email_verified === false || email !== allowed) {
    return new Response(
      `This server only indexes ${allowed}; you authenticated as ${email ?? 'an unknown account'}.`,
      { status: 403 },
    );
  }

  if (tokens.refresh_token) {
    await env.OAUTH_KV.put(GMAIL_REFRESH_TOKEN_KEY, tokens.refresh_token);
  } else if (!(await env.OAUTH_KV.get(GMAIL_REFRESH_TOKEN_KEY))) {
    return new Response(
      'Google returned no refresh token and none is stored; revoke access at myaccount.google.com/permissions and retry.',
      { status: 502 },
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: email,
    metadata: { provider: 'google' },
    scope: authRequest.scope,
    props: { email },
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append('Set-Cookie', `${VERIFIER_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/callback') return handleCallback(request, env);
    return new Response('not found', { status: 404 });
  },
};
