/**
 * MCP wiring for the Worker — mirrors src/mcp/server.ts's one-registry design
 * (the TOOLS registry drives both tools/list and tools/call so schema and
 * handler can never drift), but over the SDK's web-standard Streamable HTTP
 * transport in STATELESS mode: a fresh Server + transport per request (the
 * required pattern since SDK 1.26), no sessions, no SSE, plain JSON responses.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Env } from './env.js';

/** A JSON Schema object (the subset the SDK advertises for `inputSchema`). */
type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** Per-request context handed to every tool run. */
export interface WorkerToolContext {
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}

/** One registered tool: its advertised contract + its handler. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
  run: (ctx: WorkerToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

function obj(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

// Spike surface: proves the OAuth + transport stack end-to-end. Replaced by the
// full forked recall registry (worker tools engine) as the port proceeds.
export const TOOLS: ToolDef[] = [
  {
    name: 'ping',
    description: 'Connectivity probe: returns ok plus the authenticated deployment identity.',
    inputSchema: obj({}),
    annotations: { title: 'Ping', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: (ctx) => ({ ok: true, account: ctx.env.ACCOUNT, allowed_email: ctx.env.ALLOWED_EMAIL }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export class McpToolError extends Error {}

/** Dispatch a tools/call to the named tool's handler (exported for tests). */
export async function dispatch(
  ctx: WorkerToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new McpToolError(`unknown tool "${name}"`);
  return tool.run(ctx, args);
}

/** The tools/list payload (exported for tests). */
export function toolList(): {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));
}

export function buildServer(ctx: WorkerToolContext): Server {
  const server = new Server(
    { name: 'mail-index', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        "mail-index (remote) — read-only recall over THIS user's mailbox (Gmail), " +
        'indexed into Cloudflare D1. REACH FOR THESE TOOLS WHENEVER a question could ' +
        "be answered from the user's email — receipts, orders, bookings, travel, " +
        'bills, what someone said or agreed, who emailed about X, newsletters, and ' +
        '"what did I miss / catch me up". Snippet rows already carry ' +
        'sender/subject/date; only fetch full bodies for the few rows you need. ' +
        'Read-only: it never sends or changes mail.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(ctx, name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** Handle one HTTP request against a fresh stateless server+transport pair. */
export async function handleMcpRequest(request: Request, ctx: WorkerToolContext): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildServer(ctx);
  await server.connect(transport);
  return transport.handleRequest(request);
}
