import { randomUUID } from 'node:crypto';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { D1Driver, type D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { getUserVersion, runMigrations } from '../src/index/migrations.js';
import { buildServer } from '../src/mcp/server.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';
import { accessTokenProvider, exchangeToken, GMAIL_MODIFY, GMAIL_READONLY, saveGrant, signPayload, signState, verifyGoogleIdentity, verifyPayload, verifyState } from './google-oauth.js';
import { enqueueScheduledSyncs, jobStatus, runJob, type JobMessage } from './jobs.js';

const VERSION = '1.4.0';
const SESSION_COOKIE = 'mail_index_operator';

interface QueueBinding { send(message: unknown): Promise<void> }
interface QueueMessage<T> { body: T; ack(): void; retry(): void }
interface QueueBatch<T> { messages: QueueMessage<T>[] }
interface WorkerContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; props?: unknown }

export interface Env {
  DB: D1DatabaseBinding;
  SYNC_QUEUE: QueueBinding;
  OAUTH_KV: unknown;
  OAUTH_PROVIDER?: OAuthHelpers;
  TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPERATOR_EMAILS: string;
  SYNC_INTERVAL: string;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const servers = new Map<string, Server>();

function assertBindings(env: Partial<Env>): asserts env is Env {
  for (const name of ['DB', 'SYNC_QUEUE', 'OAUTH_KV', 'TOKEN_ENC_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPERATOR_EMAILS', 'SYNC_INTERVAL'] as const) {
    if (!env[name]) throw new Error(`Missing required Worker binding: ${name}`);
  }
}

async function storage(env: Env) { const driver = new D1Driver(env.DB); await runMigrations(driver); return { driver, repo: new Repo(driver) }; }

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const sid = request.headers.get('mcp-session-id');
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    const { driver, repo } = await storage(env);
    const connected = await driver.prepare('SELECT account FROM google_tokens ORDER BY account').all() as { account: string }[];
    const labels = connected.length ? connected.map((row) => row.account) : ['default'];
    const accounts = Object.fromEntries(labels.map((account) => [account, { adapter: 'gmail-rest' as const, account }]));
    const server = buildServer({ repo, config: { accounts }, buildSource: (account) => new GmailRestAdapter({ fetchImpl: fetch, tokenProvider: accessTokenProvider(driver, account.account ?? '', env, fetch) }), jobStatus: (account) => jobStatus(env, account) });
    transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
      onsessioninitialized: (id) => { transports.set(id, transport!); servers.set(id, server); },
      onsessionclosed: (id) => { transports.delete(id); const active = servers.get(id); servers.delete(id); void active?.close(); },
    });
    await server.connect(transport);
  }
  return transport.handleRequest(request);
}

export interface WorkerDependencies { fetchImpl?: typeof fetch }

export async function handleAuthorizedRequest(request: Request, env: Partial<Env>): Promise<Response> {
  assertBindings(env);
  const url = new URL(request.url);
  if (url.pathname === '/mcp' && ['GET', 'POST', 'DELETE'].includes(request.method)) return handleMcp(request, env);
  return Response.json({ error: 'not_found' }, { status: 404 });
}

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function operatorEmail(request: Request, env: Env): Promise<string | undefined> {
  const value = cookie(request, SESSION_COOKIE); if (!value) return undefined;
  try { const session = await verifyPayload<{ email: string; expiresAt: number }>(value, env.TOKEN_ENC_KEY); return session.email; }
  catch { return undefined; }
}

function allowed(email: string, env: Env): boolean { return env.OPERATOR_EMAILS.split(',').map((v) => v.trim().toLowerCase()).includes(email.toLowerCase()); }

export async function handlePublicRequest(request: Request, env: Partial<Env>, ctx: WorkerContext, dependencies: WorkerDependencies = {}): Promise<Response> {
  assertBindings(env); const url = new URL(request.url); const fetchImpl = dependencies.fetchImpl ?? fetch;
  if (request.method === 'GET' && url.pathname === '/healthz') { const { driver } = await storage(env); return Response.json({ ok: true, name: 'mail-index', version: VERSION, schema_version: await getUserVersion(driver) }); }
  if (url.pathname === '/authorize') {
    if (!env.OAUTH_PROVIDER) throw new Error('Missing OAuth provider helpers');
    const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const redirectUri = `${url.origin}/oauth/google/callback`;
    const state = await signPayload({ auth, redirectUri, expiresAt: Date.now() + 10 * 60_000 }, env.TOKEN_ENC_KEY);
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    google.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', state, prompt: 'select_account' }).toString();
    return Response.redirect(google, 302);
  }
  if (url.pathname === '/oauth/google/callback') {
    if (!env.OAUTH_PROVIDER) throw new Error('Missing OAuth provider helpers');
    const stateValue = url.searchParams.get('state'); const code = url.searchParams.get('code');
    if (!stateValue || !code) return Response.json({ error: 'missing_identity_callback_parameters' }, { status: 400 });
    const state = await verifyPayload<{ auth: AuthRequest; redirectUri: string }>(stateValue, env.TOKEN_ENC_KEY);
    const token = await exchangeToken(fetchImpl, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: state.redirectUri, grant_type: 'authorization_code' });
    const user = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${String(token['access_token'] ?? '')}` } });
    const identity = await user.json() as { email?: string; email_verified?: boolean };
    if (!user.ok || !identity.email || identity.email_verified === false || !allowed(identity.email, env)) return new Response('<h1>Access denied</h1>', { status: 403, headers: { 'content-type': 'text/html' } });
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: state.auth, userId: identity.email.toLowerCase(), metadata: { email: identity.email }, scope: state.auth.scope, props: { email: identity.email } });
    const session = await signPayload({ email: identity.email, expiresAt: Date.now() + 8 * 60 * 60_000 }, env.TOKEN_ENC_KEY);
    return new Response(null, { status: 302, headers: { location: redirectTo, 'set-cookie': `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800` } });
  }
  if (url.pathname === '/setup/google/callback') {
    const stateValue = url.searchParams.get('state'); const code = url.searchParams.get('code');
    if (!stateValue || !code) return Response.json({ error: 'missing_oauth_callback_parameters' }, { status: 400 });
    const state = await verifyState(stateValue, env.TOKEN_ENC_KEY);
    const token = await exchangeToken(fetchImpl, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: state.redirectUri, grant_type: 'authorization_code' });
    const accessToken = String(token['access_token'] ?? ''); const refreshToken = String(token['refresh_token'] ?? '');
    if (!accessToken || !refreshToken) throw new Error('Google callback returned incomplete tokens');
    const address = await verifyGoogleIdentity(fetchImpl, accessToken); const { driver } = await storage(env);
    await saveGrant(driver, { account: state.account, address, scopes: state.writes ? [GMAIL_READONLY, GMAIL_MODIFY] : [GMAIL_READONLY], refreshToken, key: env.TOKEN_ENC_KEY });
    return new Response(`<h1>Connected ${escapeHtml(state.account)}</h1><p>${escapeHtml(address)}</p>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname.startsWith('/setup')) {
    const email = await operatorEmail(request, env); if (!email || !allowed(email, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (url.pathname === '/setup/google/start') {
      const account = url.searchParams.get('account')?.trim(); if (!account) return Response.json({ error: 'account_required' }, { status: 400 });
      const writes = url.searchParams.get('writes') === '1'; const redirectUri = `${url.origin}/setup/google/callback`;
      const state = await signState({ account, writes, redirectUri, expiresAt: Date.now() + 10 * 60_000 }, env.TOKEN_ENC_KEY);
      const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      consent.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: (writes ? [GMAIL_READONLY, GMAIL_MODIFY] : [GMAIL_READONLY]).join(' '), state }).toString();
      return Response.redirect(consent, 302);
    }
    const { driver } = await storage(env); const accounts = await driver.prepare('SELECT account,address,scopes FROM google_tokens ORDER BY account').all() as { account: string; address: string; scopes: string }[];
    return new Response(`<h1>mail-index setup</h1><p>Operator: ${escapeHtml(email)}</p><p>Register callbacks: ${escapeHtml(`${url.origin}/oauth/google/callback`)} and ${escapeHtml(`${url.origin}/setup/google/callback`)}</p><ul>${accounts.map((a) => `<li>${escapeHtml(a.account)} — ${escapeHtml(a.address)} — ${escapeHtml(a.scopes)}</li>`).join('')}</ul>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

export const apiHandler = { fetch: (request: Request, env: Env) => handleAuthorizedRequest(request, env) };
export const defaultHandler = { fetch: (request: Request, env: Env, ctx: WorkerContext) => handlePublicRequest(request, env, ctx) };

export default {
  fetch(request: Request, env: Env, ctx: WorkerContext) { return handlePublicRequest(request, env, ctx); },
  scheduled(_controller: unknown, env: Env, ctx: WorkerContext) { ctx.waitUntil(enqueueScheduledSyncs(env)); },
  async queue(batch: QueueBatch<JobMessage>, env: Env) { for (const message of batch.messages) { try { await runJob(env, message.body); message.ack(); } catch { message.retry(); } } },
};
