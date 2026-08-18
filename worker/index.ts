import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { D1Driver, type D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { getUserVersion, runMigrations } from '../src/index/migrations.js';
import { SCHEMA_VERSION } from '../src/index/schema.js';
import { buildServer } from '../src/mcp/server.js';
import type { ToolContext } from '../src/mcp/tools.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';
import { InsufficientScopeError } from '../src/source/index.js';
import { AccountMismatchError, accessTokenProvider, exchangeToken, GMAIL_MODIFY, GMAIL_READONLY, saveGrant, signPayload, signState, verifyGoogleIdentity, verifyPayload, verifyState } from './google-oauth.js';
import { enqueueJob, enqueueScheduledSyncs, jobStatus, runJob, type JobMessage } from './jobs.js';
import { triggerAdmin } from './triggers.js';
import { agentCard, handleA2a } from './a2a.js';
import { handleCrmRequest } from './crm-api.js';
import type { AttachmentBucket } from './attachments.js';

const VERSION = '1.4.0';
const SESSION_COOKIE = 'mail_index_operator';

interface QueueBinding { send(message: unknown): Promise<void> }
interface QueueMessage<T> { body: T; ack(): void; retry(): void }
interface QueueBatch<T> { messages: QueueMessage<T>[] }
interface WorkerContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; props?: unknown }

export interface Env {
  DB: D1DatabaseBinding;
  SYNC_QUEUE: QueueBinding;
  // The sweeps ride their OWN Queue so a sync can never starve them. A sync Job
  // holds its consumer slot for 8-15 minutes (it is O(mailbox)), and with one
  // slot per connected mailbox that meant every slot was a sync for most of the
  // hour: the sweeps sat queued until their 50-minute lease expired and were
  // reaped as "queued Job was never delivered" (UNS-1335). Two Queues means two
  // concurrency budgets. Routing lives in `queueFor` (job-state.ts).
  SWEEP_QUEUE: QueueBinding;
  OAUTH_KV: unknown;
  OAUTH_PROVIDER?: OAuthHelpers;
  TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPERATOR_EMAILS: string;
  SYNC_INTERVAL: string;
  SYNC_LOOKBACK_MONTHS?: string;
  CRM_WEBHOOK_URL?: string;
  CRM_WEBHOOK_SECRET?: string;
  /** Comma-separated mailboxes allowed to reach the CRM; unset means all. */
  CRM_ACCOUNTS?: string;
  ATTACHMENTS?: AttachmentBucket;
}

function assertBindings(env: Partial<Env>): asserts env is Env {
  for (const name of ['DB', 'SYNC_QUEUE', 'SWEEP_QUEUE', 'OAUTH_KV', 'TOKEN_ENC_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPERATOR_EMAILS', 'SYNC_INTERVAL'] as const) {
    if (!env[name]) throw new Error(`Missing required Worker binding: ${name}`);
  }
}

async function storage(env: Env) { const driver = new D1Driver(env.DB); await runMigrations(driver); return { driver, repo: new Repo(driver) }; }

/**
 * Serve one MCP request STATELESSLY (SDK "stateless mode", the documented
 * Cloudflare Workers pattern).
 *
 * A session map keyed by `mcp-session-id` cannot work here: Workers give no
 * cross-request isolate affinity, so the POST that follows `initialize`
 * routinely lands in an isolate whose map is empty. The old code then built a
 * fresh transport carrying a NEW session id while the client was still sending
 * the old one, and the SDK rejected the mismatch — every connection went 200 on
 * initialize then 400 on `tools/list`, surfacing in claude.ai as "couldn't
 * reload tools from the server".
 *
 * Each request therefore gets its own server + transport. The tool surface is
 * rebuilt from D1 per request, so nothing of value lived in that map anyway.
 */
async function handleMcp(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const server = buildServer(await buildWorkerToolContext(env, fetchImpl, new URL(request.url).origin));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function buildWorkerToolContext(env: Env, fetchImpl: typeof fetch = fetch, origin?: string): Promise<ToolContext> {
  const { driver, repo } = await storage(env);
  const connected = await driver.prepare('SELECT account,scopes FROM google_tokens ORDER BY account').all() as { account: string; scopes: string }[];
  const labels = connected.length ? connected.map((row) => row.account) : ['default'];
  const accounts = Object.fromEntries(labels.map((account) => [account, { adapter: 'gmail-rest' as const, account }]));
  const scopes = new Map(connected.map((row) => [row.account, row.scopes]));
  return { repo, config: { accounts }, buildSource: (account) => {
    const label = account.account ?? '';
    const source = new GmailRestAdapter({ fetchImpl, tokenProvider: accessTokenProvider(driver, label, env, fetchImpl) });
    if (!scopes.get(label)?.includes(GMAIL_MODIFY)) Object.defineProperty(source, 'modify', { value: async () => { throw new InsufficientScopeError('gmail-rest', `/setup?account=${encodeURIComponent(label)}&writes=1`, 'Reconnect this Account with mailbox writes enabled.'); } });
    return source;
  }, jobStatus: (account) => jobStatus(env, account), enqueueJob: (kind, account, params) => enqueueJob(env, kind, account, params),
    // The exact link a human must open to repair a rejected grant. Keeping the
    // `account=` label verbatim matters: consenting a different mailbox under an
    // existing label is refused (AccountMismatchError), by design.
    reauthUrl: origin ? (account: string) => `${origin}/setup/google/start?account=${encodeURIComponent(account)}` : undefined,
    triggerAdmin: triggerAdmin(driver) };
}

export interface WorkerDependencies { fetchImpl?: typeof fetch }

export async function handleAuthorizedRequest(request: Request, env: Partial<Env>, dependencies: WorkerDependencies = {}): Promise<Response> {
  assertBindings(env);
  const url = new URL(request.url);
  if (url.pathname === '/mcp' && ['GET', 'POST', 'DELETE'].includes(request.method)) return handleMcp(request, env, dependencies.fetchImpl);
  if (url.pathname === '/a2a' && request.method === 'POST') return handleA2a(request, await buildWorkerToolContext(env));
  if (url.pathname.startsWith('/crm/v1/')) return handleCrmRequest(request, env);
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

/** Resolve an OIDC access token to an ALLOWLISTED operator address, else undefined. */
async function operatorIdentity(fetchImpl: typeof fetch, accessToken: string, env: Env): Promise<string | undefined> {
  const user = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
  const identity = await user.json() as { email?: string; email_verified?: boolean };
  if (!user.ok || !identity.email || identity.email_verified === false || !allowed(identity.email, env)) return undefined;
  return identity.email;
}

/** The 8-hour operator session cookie minted after a verified allowlisted sign-in. */
async function sessionCookie(email: string, env: Env): Promise<string> {
  const session = await signPayload({ email, expiresAt: Date.now() + 8 * 60 * 60_000 }, env.TOKEN_ENC_KEY);
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`;
}

export async function handlePublicRequest(request: Request, env: Partial<Env>, ctx: WorkerContext, dependencies: WorkerDependencies = {}): Promise<Response> {
  assertBindings(env); const url = new URL(request.url); const fetchImpl = dependencies.fetchImpl ?? fetch;
  if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') return Response.json(agentCard(url.origin));
  if (request.method === 'GET' && url.pathname === '/healthz') { const { driver } = await storage(env); const schemaVersion = await getUserVersion(driver); return Response.json({ ok: true, name: 'mail-index', version: VERSION, schema_version: schemaVersion, migration_state: schemaVersion === SCHEMA_VERSION ? 'current' : 'pending' }); }
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
    const email = await operatorIdentity(fetchImpl, String(token['access_token'] ?? ''), env);
    if (!email) return new Response('<h1>Access denied</h1>', { status: 403, headers: { 'content-type': 'text/html' } });
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: state.auth, userId: email.toLowerCase(), metadata: { email }, scope: state.auth.scope, props: { email } });
    return new Response(null, { status: 302, headers: { location: redirectTo, 'set-cookie': await sessionCookie(email, env) } });
  }
  if (url.pathname === '/setup/google/callback') {
    const stateValue = url.searchParams.get('state'); const code = url.searchParams.get('code');
    if (!stateValue || !code) return Response.json({ error: 'missing_oauth_callback_parameters' }, { status: 400 });
    const state = await verifyState(stateValue, env.TOKEN_ENC_KEY);
    const token = await exchangeToken(fetchImpl, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: state.redirectUri, grant_type: 'authorization_code' });
    const accessToken = String(token['access_token'] ?? '');
    // Identity-only sign-in (/setup/login): mint the operator session and stop.
    // No mailbox scope was requested, so there is no grant to save here.
    if (state.login) {
      if (!accessToken) throw new Error('Google callback returned no access token');
      const email = await operatorIdentity(fetchImpl, accessToken, env);
      if (!email) return new Response('<h1>Access denied</h1>', { status: 403, headers: { 'content-type': 'text/html' } });
      return new Response(null, { status: 302, headers: { location: '/setup', 'set-cookie': await sessionCookie(email, env) } });
    }
    const refreshToken = String(token['refresh_token'] ?? '');
    if (!accessToken || !refreshToken) throw new Error('Google callback returned incomplete tokens');
    const address = await verifyGoogleIdentity(fetchImpl, accessToken); const { driver } = await storage(env);
    try {
      await saveGrant(driver, { account: state.account, address, scopes: state.writes ? [GMAIL_READONLY, GMAIL_MODIFY] : [GMAIL_READONLY], refreshToken, key: env.TOKEN_ENC_KEY });
    } catch (err) {
      if (!(err instanceof AccountMismatchError)) throw err;
      return new Response(`<h1>Wrong account label</h1><p>${escapeHtml(err.message)}</p><p><a href="/setup/google/start?account=${encodeURIComponent(address.split('@')[0] ?? 'account')}">Connect ${escapeHtml(address)} under its own label</a></p>`, { status: 409, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response(`<h1>Connected ${escapeHtml(state.account)}</h1><p>${escapeHtml(address)}</p>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // Identity-only sign-in, reachable WITHOUT a session — this is how a browser
  // that never ran the MCP /authorize flow gets an operator cookie for /setup.
  if (url.pathname === '/setup/login') {
    const redirectUri = `${url.origin}/setup/google/callback`;
    const state = await signState({ account: '', writes: false, login: true, redirectUri, expiresAt: Date.now() + 10 * 60_000 }, env.TOKEN_ENC_KEY);
    const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    consent.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', state, prompt: 'select_account' }).toString();
    return Response.redirect(consent, 302);
  }
  if (url.pathname.startsWith('/setup')) {
    const email = await operatorEmail(request, env); if (!email || !allowed(email, env)) return new Response(`<h1>mail-index</h1><p><a href="/setup/login">Sign in as an operator</a> to continue.</p>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
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
  // An unobserved rejection here loses the whole hour's fan-out for EVERY
  // Account silently — a single D1 hiccup would look identical to a healthy
  // quiet tick. Log it so a missed cycle is visible in Workers logs.
  scheduled(_controller: unknown, env: Env, ctx: WorkerContext) {
    ctx.waitUntil(enqueueScheduledSyncs(env).then((ids) => {
      // The count is what distinguishes a fan-out that finished from one whose
      // isolate died partway. A tick with no cron_ok at all, or one whose count
      // is below the number of `jobs` rows that tick created, stranded the rest.
      console.log(JSON.stringify({ event: 'cron_ok', enqueued: ids.length }));
    }).catch((error: unknown) => {
      console.log(JSON.stringify({ event: 'cron_fail', error_name: error instanceof Error ? error.name : 'Error' }));
    }));
  },
  async queue(batch: QueueBatch<JobMessage>, env: Env) { for (const message of batch.messages) { try { await runJob(env, message.body); message.ack(); } catch { message.retry(); } } },
};
