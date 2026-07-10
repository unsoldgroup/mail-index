/**
 * Worker entry: OAuthProvider wraps everything — /mcp is the token-guarded API
 * route; /authorize, /callback (Google upstream) and /token, /register live on
 * the provider/default handler. /healthz is answered before the provider so it
 * stays public. scheduled() drives the incremental sync pipeline.
 */
import OAuthProvider from '@cloudflare/workers-oauth-provider';

import { authHandler } from './auth-handler.js';
import { GMAIL_REFRESH_TOKEN_KEY, type Env } from './env.js';
import { handleMcpRequest } from './mcp.js';

const apiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleMcpRequest(request, { env, waitUntil: (p) => ctx.waitUntil(p) });
  },
};

const provider = new OAuthProvider({
  apiRoute: '/mcp',
  // The provider's handler types predate ExportedHandler generics; the runtime
  // contract is just { fetch(request, env, ctx) }.
  apiHandler: apiHandler as never,
  defaultHandler: authHandler as never,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mail-index:read'],
});

async function healthz(env: Env): Promise<Response> {
  const gmailConnected = (await env.OAUTH_KV.get(GMAIL_REFRESH_TOKEN_KEY)) != null;
  return Response.json({
    ok: true,
    name: 'mail-index-worker',
    account: env.ACCOUNT,
    gmail_connected: gmailConnected,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return healthz(env);
    return provider.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Wired to runSyncSlice() as the pipeline port lands.
    const gmailConnected = (await env.OAUTH_KV.get(GMAIL_REFRESH_TOKEN_KEY)) != null;
    if (!gmailConnected) {
      console.log('scheduled: no Gmail refresh token yet; complete the consent flow first');
    }
  },
} satisfies ExportedHandler<Env>;
