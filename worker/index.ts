import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { D1Driver, type D1DatabaseBinding } from '../src/index/drivers/d1.js';
import { Repo } from '../src/index/repo.js';
import { getUserVersion, runMigrations } from '../src/index/migrations.js';
import { buildServer } from '../src/mcp/server.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const VERSION = '1.4.0';

interface QueueBinding {
  send(message: unknown): Promise<void>;
}

interface KvBinding {
  get(key: string): Promise<string | null>;
}

export interface Env {
  DB: D1DatabaseBinding;
  SYNC_QUEUE: QueueBinding;
  OAUTH_KV: KvBinding;
  DEV_BEARER_TOKEN: string;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
const servers = new Map<string, Server>();

function assertBindings(env: Partial<Env>): asserts env is Env {
  for (const name of ['DB', 'SYNC_QUEUE', 'OAUTH_KV', 'DEV_BEARER_TOKEN'] as const) {
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
    const { repo } = await storage(env);
    const server = buildServer({
      repo,
      config: { accounts: { default: { adapter: 'gmail-rest' } } },
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

export async function handleRequest(request: Request, env: Partial<Env>): Promise<Response> {
  assertBindings(env);
  const url = new URL(request.url);
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
  return Response.json({ error: 'not_found' }, { status: 404 });
}

export default {
  fetch(request: Request, env: Env, _ctx: WorkerContext): Promise<Response> {
    return handleRequest(request, env);
  },
};
