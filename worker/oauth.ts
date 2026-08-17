import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import internalWorker, { apiHandler, defaultHandler, type Env } from './index.js';

interface OAuthExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void }

export const oauthProvider = new OAuthProvider<Env>({
  apiRoute: ['/mcp', '/a2a', '/crm/v1'],
  apiHandler: apiHandler as never,
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mail-index', 'crm.read', 'crm.index', 'crm.jobs'],
  allowPlainPKCE: false,
  // The library defaults to a 90-day KV TTL on every registered client, which
  // silently deletes the CRM's client record and breaks Twenty's OAuth. These
  // registrations are operator-managed and few, so they do not expire.
  // The key must be PRESENT with an undefined value: the provider applies its
  // default via object spread, so omitting it entirely restores the 90 days.
  clientRegistrationTTL: undefined,
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
