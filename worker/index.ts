import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { D1Driver, type D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { getUserVersion, runMigrations } from '../src/index/migrations.js';
import { buildServer } from '../src/mcp/server.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GMAIL_MODIFY, GMAIL_READONLY, saveGrant, signState, verifyGoogleIdentity, verifyState, exchangeToken } from './google-oauth.js';
import { accessTokenProvider } from './google-oauth.js';
import { GmailRestAdapter } from '../src/source/adapters/gmail-rest/index.js';
import { enqueueScheduledSyncs, jobStatus, runJob, type JobMessage } from './jobs.js';

const VERSION = '1.4.0';

interface QueueBinding {
  send(message: unknown): Promise<void>;
}
interface QueueMessage<T> { body: T; ack(): void; retry(): void }
interface QueueBatch<T> { messages: QueueMessage<T>[] }

interface KvBinding {
  get(key: string): Promise<string | null>;
}

export interface Env {
  DB: D1DatabaseBinding;
  SYNC_QUEUE: QueueBinding;
  OAUTH_KV: KvBinding;
  DEV_BEARER_TOKEN: string;
  TOKEN_ENC_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SYNC_INTERVAL: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const servers = new Map<string, Server>();

function assertBindings(env: Partial<Env>): asserts env is Env {
  for (const name of ['DB', 'SYNC_QUEUE', 'OAUTH_KV', 'DEV_BEARER_TOKEN', 'TOKEN_ENC_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SYNC_INTERVAL'] as const) {
    if (!env[name]) throw new Error(`Missing required Worker binding: ${name}`);
  }
}

function authorized(request: Request, secret: string): boolean {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function storage(env: Env): Promise<{ driver: D1Driver; repo: Repo }> {
  const driver = new D1Driver(env.DB);
  await runMigrations(driver);
  return { driver, repo: new Repo(driver) };
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // TEMPORARY — replaced by Ticket 007 MCP OAuth.
  if (!authorized(request, env.DEV_BEARER_TOKEN)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sid = request.headers.get('mcp-session-id');
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    const { driver, repo } = await storage(env);
    const connected = await driver.prepare('SELECT account FROM google_tokens ORDER BY account').all() as { account: string }[];
    const accountLabels = connected.length > 0 ? connected.map((row) => row.account) : ['default'];
    const accounts = Object.fromEntries(accountLabels.map((account) => [account, { adapter: 'gmail-rest' as const, account }]));
    const server = buildServer({
      repo,
      config: { accounts },
      buildSource: (account) => new GmailRestAdapter({
        fetchImpl: fetch,
        tokenProvider: accessTokenProvider(driver, account.account ?? '', env, fetch),
      }),
      jobStatus: (account) => jobStatus(env, account),
    });
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport as WebStandardStreamableHTTPServerTransport);
        servers.set(sessionId, server);
      },
      onsessionclosed: (sessionId) => {
        transports.delete(sessionId);
        const activeServer = servers.get(sessionId);
        servers.delete(sessionId);
        void activeServer?.close();
      },
    });
    await server.connect(transport);
  }
  return transport.handleRequest(request);
}

export interface WorkerDependencies { fetchImpl?: typeof fetch }

export async function handleRequest(request: Request, env: Partial<Env>, dependencies: WorkerDependencies = {}): Promise<Response> {
  assertBindings(env);
  const url = new URL(request.url);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  if (request.method === 'GET' && url.pathname === '/healthz') {
    const { driver } = await storage(env);
    return Response.json({
      ok: true,
      name: 'mail-index',
      version: VERSION,
      schema_version: await getUserVersion(driver),
    });
  }
  if (url.pathname === '/mcp' && ['GET', 'POST', 'DELETE'].includes(request.method)) {
    return handleMcp(request, env);
  }
  if (url.pathname === '/setup/google/callback') {
    const stateValue = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!stateValue || !code) return Response.json({ error: 'missing_oauth_callback_parameters' }, { status: 400 });
    const state = await verifyState(stateValue, env.TOKEN_ENC_KEY);
    const token = await exchangeToken(fetchImpl, { code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: state.redirectUri, grant_type: 'authorization_code' });
    const accessToken = String(token['access_token'] ?? '');
    const refreshToken = String(token['refresh_token'] ?? '');
    if (!accessToken || !refreshToken) throw new Error('Google callback returned incomplete tokens');
    const address = await verifyGoogleIdentity(fetchImpl, accessToken);
    const { driver } = await storage(env);
    const scopes = state.writes ? [GMAIL_READONLY, GMAIL_MODIFY] : [GMAIL_READONLY];
    await saveGrant(driver, { account: state.account, address, scopes, refreshToken, key: env.TOKEN_ENC_KEY });
    return new Response(`<h1>Connected ${escapeHtml(state.account)}</h1><p>${escapeHtml(address)}</p>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname.startsWith('/setup')) {
    if (!authorized(new Request(request, { headers: { ...Object.fromEntries(request.headers), authorization: `Bearer ${url.searchParams.get('token') ?? ''}` } }), env.DEV_BEARER_TOKEN)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (url.pathname === '/setup/google/start') {
      const account = url.searchParams.get('account')?.trim();
      if (!account) return Response.json({ error: 'account_required' }, { status: 400 });
      const writes = url.searchParams.get('writes') === '1';
      const redirectUri = `${url.origin}/setup/google/callback`;
      const state = await signState({ account, writes, redirectUri, expiresAt: Date.now() + 10 * 60_000 }, env.TOKEN_ENC_KEY);
      const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      consent.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: (writes ? [GMAIL_READONLY, GMAIL_MODIFY] : [GMAIL_READONLY]).join(' '), state }).toString();
      return Response.redirect(consent, 302);
    }
    const { driver } = await storage(env);
    const accounts = await driver.prepare('SELECT account,address,scopes FROM google_tokens ORDER BY account').all() as { account: string; address: string; scopes: string }[];
    return new Response(`<h1>mail-index setup</h1><p>Register callback: ${escapeHtml(`${url.origin}/setup/google/callback`)}</p><ul>${accounts.map((a) => `<li>${escapeHtml(a.account)} — ${escapeHtml(a.address)} — ${escapeHtml(a.scopes)}</li>`).join('')}</ul>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

export default {
  fetch(request: Request, env: Env, _ctx: WorkerContext): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller: unknown, env: Env, ctx: WorkerContext): void {
    ctx.waitUntil(enqueueScheduledSyncs(env));
  },
  async queue(batch: QueueBatch<JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try { await runJob(env, message.body); message.ack(); }
      catch { message.retry(); }
    }
  },
};
