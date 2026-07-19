import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import internalWorker, { apiHandler, defaultHandler, type Env } from './index.js';

interface OAuthExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }

export const oauthProvider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: apiHandler as never,
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mail-index'],
  allowPlainPKCE: false,
});

export default {
  fetch(request: Request, env: Env, ctx: OAuthExecutionContext) {
    return oauthProvider.fetch(request, env, ctx as never);
  },
  scheduled(controller: unknown, env: Env, ctx: OAuthExecutionContext) {
    ctx.waitUntil(oauthProvider.purgeExpiredData(env));
    return internalWorker.scheduled(controller, env, ctx as never);
  },
  queue: internalWorker.queue,
};
