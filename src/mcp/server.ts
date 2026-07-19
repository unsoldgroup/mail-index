/**
 * MCP server wiring (SCOPE 3.4, PLAN §12, ADR-0001/0005).
 *
 * Turns the pure tool engine (`tools.ts`) into a stdio
 * `@modelcontextprotocol/sdk` Server. One {@link TOOLS} registry drives BOTH the
 * `tools/list` response (name + description + input JSON Schema) and the
 * `tools/call` dispatch (each entry's `run`), so the advertised schema and the
 * executed handler can never drift. The registry + {@link dispatch} are exported
 * so the golden-response tests exercise the exact surface the agent sees without
 * a live transport.
 *
 * The server is READ-ONLY on the mailbox (D15) — the only provider contact is
 * `get_message`'s single inline O(1) enrich (ADR-0001), wired via the
 * {@link ToolContext.buildSource} seam. O(N) work is returned as a command
 * handback by the tools themselves; the server never spawns bulk work inside a
 * request. Stale time-sensitive reads spawn a DETACHED `mail-index sync` child
 * (ADR-0005) via {@link spawnDetachedSync}, which outlives the request.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import {
  search,
  listLabeled,
  refreshInbox,
  getMessage,
  getThread,
  listContacts,
  getContact,
  findPerson,
  listThreads,
  graphNeighbors,
  graphCommunities,
  interestPropose,
  interestSet,
  interestGet,
  saveSummaryTool,
  domainsToCategorizeTool,
  saveDomainCategoryTool,
  cadenceTool,
  syncStatus,
  relayMenuStatus,
  syncNow,
  catchUp,
  digestSources,
  archiveMessage,
  modifyLabels,
  McpToolError,
  type ToolContext,
} from './tools.js';
import { dispatchSetup, setupToolList } from './setup-tools.js';

/** A JSON Schema object (the subset the SDK advertises for `inputSchema`). */
type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/** One registered tool: its advertised contract + its handler. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
  /** Run the tool over the context with the (validated-by-schema) args. */
  run: (ctx: ToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const str = { type: 'string' as const };
const num = { type: 'integer' as const };
const bool = { type: 'boolean' as const };
const strArr = { type: 'array' as const, items: { type: 'string' as const } };

function obj(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The full PLAN §12 surface — 23 tools: 21 read-only (recall primitives,
 * curation/categorization write-back, composites incl. list_labeled/
 * refresh_inbox) plus the two OPT-IN mailbox writers archive_message /
 * modify_labels (ADR-0007). Every entry advertises a compact input schema and
 * dispatches to the pure engine. Descriptions tell the agent the recall-first,
 * token-conscious contract (compact shapes, handbacks for bulk work,
 * `index_as_of` on every response).
 */
export const TOOLS: ToolDef[] = [
  // ---- primitives ----
  {
    name: 'search',
    description:
      'Ranked fuzzy full-text recall over the indexed mail (subject/sender/snippet/body/summaries), porter-stemmed so word forms match (refund≈refunds). Snippet-first and compact (each row already has sender/subject/date) — open a full body with get_message only when you need details. Recall, not lookup: a half-remembered phrase still surfaces ranked neighbours. Use it for things like "what did I buy / order / pay for", receipts, invoices, order confirmations, bookings, travel, "find the email about X", "the message from the recruiter", a confirmation/booking number, etc. For aggregating purchases, search a sender or keyword (e.g. "Amazon order", "receipt") rather than fetching every message. Semantic expansion is YOUR job: if a query returns too little, reissue with your own synonyms/related terms and across a few phrasings — the index does light stemming + a tiny synonym net, not concept search.',
    inputSchema: obj(
      { query: str, account: str, limit: num },
      ['query'],
    ),
    run: (ctx, a) =>
      search(ctx, { query: String(a['query']), ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'list_labeled',
    description:
      'Messages carrying a Gmail label, newest-first (label membership, not full-text). Use label "INBOX" to answer "what is in my inbox right now" — INBOX membership is reconciled on every sync, so it reflects the mailbox now (archived mail is dropped). "UNREAD" answers "what is unread", "STARRED" what is starred; any user label filters to it. Compact, snippet-first like search.',
    inputSchema: obj(
      { label: str, account: str, limit: num },
      ['label'],
    ),
    run: (ctx, a) =>
      listLabeled(ctx, { label: String(a['label']), ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'refresh_inbox',
    description:
      'Answer "what is in my inbox right now" with live-accurate membership. Reconciles INBOX against the live mailbox (archived mail drops, new inbox mail is pulled) THEN returns the current inbox — prefer this over list_labeled INBOX whenever freshness matters. One bounded provider round-trip (inbox-sized); degrades to the indexed inbox (refreshed=false) when no creds are wired.',
    inputSchema: obj({ account: str, limit: num }),
    run: (ctx, a) => refreshInbox(ctx, { ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'get_message',
    description:
      'One message by <account:id>. level: "summary" (default — agent summary or snippet), "body" (distilled body; inline-enriches a still-meta row once, the only provider fetch), or "meta". Bodies are opt-in.',
    inputSchema: obj(
      { ref: str, level: { type: 'string', enum: ['summary', 'body', 'meta'] } },
      ['ref'],
    ),
    run: (ctx, a) =>
      getMessage(ctx, {
        ref: String(a['ref']),
        ...(a['level'] != null ? { level: a['level'] as 'summary' | 'body' | 'meta' } : {}),
      }),
  },
  {
    name: 'get_thread',
    description:
      'A thread by <account:thread-id>: metadata, its messages (compact, snippet-first), and the thread summary if present.',
    inputSchema: obj({ ref: str }, ['ref']),
    run: (ctx, a) => getThread(ctx, { ref: String(a['ref']) }),
  },
  {
    name: 'list_contacts',
    description:
      'Ranked contacts. sort: engagement (default) | volume | recency | community. filter: "correspondent" (people you have written to) | important | muted | blocked.',
    inputSchema: obj({
      account: str,
      sort: { type: 'string', enum: ['engagement', 'volume', 'recency', 'community'] },
      filter: str,
      limit: num,
    }),
    run: (ctx, a) =>
      listContacts(ctx, {
        ...optStr(a, 'account'),
        ...(a['sort'] != null ? { sort: a['sort'] as never } : {}),
        ...optStr(a, 'filter'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'get_contact',
    description:
      'One contact by address: stats, curation, recent threads. A near-miss returns ranked candidates rather than nothing.',
    inputSchema: obj({ address: str, account: str }, ['address']),
    run: (ctx, a) => getContact(ctx, { address: String(a['address']), ...optStr(a, 'account') }),
  },
  {
    name: 'find_person',
    description:
      'Fuzzy contact resolution from a vague hint (name fragment, handle, or domain). Ranks Correspondents (people you have written to) first. The entry point for "who was that contact from last spring?".',
    inputSchema: obj({ hint: str, account: str, limit: num }, ['hint']),
    run: (ctx, a) =>
      findPerson(ctx, { hint: String(a['hint']), ...optStr(a, 'account'), ...optNum(a, 'limit') }),
  },
  {
    name: 'list_threads',
    description: 'Conversations by contact (address) OR by query (FTS). Compact thread shapes.',
    inputSchema: obj({ contact: str, query: str, account: str, limit: num }),
    run: (ctx, a) =>
      listThreads(ctx, {
        ...optStr(a, 'contact'),
        ...optStr(a, 'query'),
        ...optStr(a, 'account'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'graph_neighbors',
    description:
      'Co-recipiency neighbours of a contact, ranked by shared threads. On a miss, returns ranked near-miss contacts so the answer is never empty.',
    inputSchema: obj({ address: str, account: str, limit: num }, ['address']),
    run: (ctx, a) =>
      graphNeighbors(ctx, {
        address: String(a['address']),
        ...optStr(a, 'account'),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'graph_communities',
    description:
      'Detected social circles (Louvain communities) with top members by centrality. Returns a build command handback when no graph exists yet.',
    inputSchema: obj({ account: str, memberLimit: num }),
    run: (ctx, a) => graphCommunities(ctx, { ...optStr(a, 'account'), ...optNum(a, 'memberLimit') }),
  },
  // ---- curation write-back loop ----
  {
    name: 'interest_propose',
    description:
      'The curation SEED: a ranked shortlist of top contacts + domains by engagement, each with a suggested action (important/muted/none). Present it, take fuzzy edits, then interest_set.',
    inputSchema: obj({ account: str, contactLimit: num, domainLimit: num }),
    run: (ctx, a) =>
      interestPropose(ctx, {
        ...optStr(a, 'account'),
        ...optNum(a, 'contactLimit'),
        ...optNum(a, 'domainLimit'),
      }),
  },
  {
    name: 'interest_set',
    description:
      'Persist the curation disposition: contact/domain curation labels (important/muted/blocked, or null to clear) and freeform interest keywords (replaces the set). This profile drives which bodies get enriched.',
    inputSchema: obj({
      account: str,
      contacts: {
        type: 'array',
        items: obj(
          { address: str, curation: { type: ['string', 'null'], enum: ['important', 'muted', 'blocked', null] } },
          ['address'],
        ),
      },
      domains: {
        type: 'array',
        items: obj(
          { domain: str, curation: { type: ['string', 'null'], enum: ['important', 'muted', 'blocked', null] } },
          ['domain'],
        ),
      },
      keywords: { type: 'array', items: str },
    }),
    run: (ctx, a) =>
      interestSet(ctx, {
        ...optStr(a, 'account'),
        ...(Array.isArray(a['contacts']) ? { contacts: a['contacts'] as never } : {}),
        ...(Array.isArray(a['domains']) ? { domains: a['domains'] as never } : {}),
        ...(Array.isArray(a['keywords']) ? { keywords: a['keywords'] as string[] } : {}),
      }),
  },
  {
    name: 'interest_get',
    description: 'Read back the curated interest profile: curated contacts/domains + keywords.',
    inputSchema: obj({ account: str }),
    run: (ctx, a) => interestGet(ctx, { ...optStr(a, 'account') }),
  },
  // ---- summarization write-back ----
  {
    name: 'save_summary',
    description:
      'Persist your summary of a message or thread (provenance-marked, FTS-indexed). level: "message" (default) or "thread". For bulk/non-curated mail this makes the body eligible for demotion after a grace window.',
    inputSchema: obj(
      { ref: str, text: str, level: { type: 'string', enum: ['message', 'thread'] } },
      ['ref', 'text'],
    ),
    run: (ctx, a) =>
      saveSummaryTool(ctx, {
        ref: String(a['ref']),
        text: String(a['text']),
        ...(a['level'] != null ? { level: a['level'] as 'message' | 'thread' } : {}),
      }),
  },
  // ---- domain categorization write-back ----
  {
    name: 'domains_to_categorize',
    description:
      'PROPOSE domains with back-and-forth contacts (Correspondents) plus sample senders/subjects as context, so you can assign an entity category. Then save_domain_category.',
    inputSchema: obj({ account: str, includeCategorized: bool, limit: num }),
    run: (ctx, a) =>
      domainsToCategorizeTool(ctx, {
        ...optStr(a, 'account'),
        ...(a['includeCategorized'] != null ? { includeCategorized: Boolean(a['includeCategorized']) } : {}),
        ...optNum(a, 'limit'),
      }),
  },
  {
    name: 'save_domain_category',
    description:
      'PERSIST an entity category you assigned to a domain (open vocabulary: client, vendor, travel operator, finance, publisher, …). Used as a filter/grouping axis.',
    inputSchema: obj({ domain: str, category: str, note: str, account: str }, ['domain', 'category']),
    run: (ctx, a) =>
      saveDomainCategoryTool(ctx, {
        domain: String(a['domain']),
        category: String(a['category']),
        ...optStr(a, 'note'),
        ...optStr(a, 'account'),
      }),
  },
  // ---- cadence (deterministic correspondent frequency) ----
  {
    name: 'cadence',
    description:
      'Inbound frequency per sender BRAND (registrable domain): volume, distinct senders, first/last seen, messages-per-month — over the whole index or since a time (30d, 1mo, ISO). Pass "category" to scope to one entity category you assigned via save_domain_category (e.g. all "expedition-operator" senders at once). Deterministic — use this instead of hand-writing SQL over senders.',
    inputSchema: obj({ account: str, category: str, since: str, limit: num }),
    run: (ctx, a) =>
      cadenceTool(ctx, {
        ...optStr(a, 'account'),
        ...optStr(a, 'category'),
        ...optStr(a, 'since'),
        ...optNum(a, 'limit'),
      }),
  },
  // ---- status + composites ----
  {
    name: 'sync_status',
    description:
      'Per-account freshness (index_as_of), whether a sync is running, message counts, and the meta/full/summary-only body-ladder split.',
    inputSchema: obj({ account: str }),
    annotations: {
      title: 'Sync Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (ctx, a) => syncStatus(ctx, { ...optStr(a, 'account') }),
  },
  {
    name: 'relay_menu_status',
    description:
      'Read-only menu/status payload for local MCP relay hosts: compact state, SF Symbol names, detail rows, and quick actions expressed as ordinary MCP tool calls. Safe for frequent polling; it never starts syncs.',
    inputSchema: obj({}),
    annotations: {
      title: 'Menu Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: (ctx) => relayMenuStatus(ctx),
  },
  {
    name: 'sync_now',
    description:
      'Quick action for relay/menu hosts. Starts a detached incremental sync for one account, or all configured/indexed accounts when omitted, and returns immediately with the equivalent CLI command handback.',
    inputSchema: obj({ account: str }),
    annotations: {
      title: 'Sync Now',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: (ctx, a) => syncNow(ctx, { ...optStr(a, 'account') }),
  },
  {
    name: 'catch_up',
    description:
      'The "what did I miss" briefing since a time (30d, 2w, 12h, 1mo, or ISO): new mail from curated-important contacts, new replies in your threads, and interest-keyword hits. Compact rows + a body command handback. If the index is stale it returns now and spawns a background sync.',
    inputSchema: obj({ since: str, account: str }, ['since']),
    run: (ctx, a) => catchUp(ctx, { since: String(a['since']), ...optStr(a, 'account') }),
  },
  {
    name: 'digest_sources',
    description:
      'Newsletter/list senders ranked by engagement + interest, with unread/unsummarized issue counts — the digest routine worklist. Stale index returns now and spawns a background sync.',
    inputSchema: obj({ since: str, account: str }),
    run: (ctx, a) => digestSources(ctx, { ...optStr(a, 'since'), ...optStr(a, 'account') }),
  },
  // ---- opt-in writers (the ONLY mailbox-mutating tools; need gmail.modify) ----
  {
    name: 'archive_message',
    description:
      'OPT-IN WRITE — MUTATES the mailbox. Archive one message (remove its INBOX label), given its <account:message-id> ref. Requires a gmail.modify grant; the default read-only install refuses with the exact re-auth command. Use only when the user explicitly asked to archive.',
    inputSchema: obj({ ref: str }, ['ref']),
    run: (ctx, a) => archiveMessage(ctx, { ref: String(a['ref']) }),
  },
  {
    name: 'modify_labels',
    description:
      'OPT-IN WRITE — MUTATES the mailbox. Add and/or remove Gmail labels on one message (system ids like STARRED/UNREAD, or existing user-label NAMES; creating new labels is not supported). Requires a gmail.modify grant; the default read-only install refuses with the exact re-auth command. Use only when the user explicitly asked to change labels.',
    inputSchema: obj({ ref: str, add: strArr, remove: strArr }, ['ref']),
    run: (ctx, a) =>
      modifyLabels(ctx, {
        ref: String(a['ref']),
        ...(Array.isArray(a['add']) ? { add: (a['add'] as unknown[]).map(String) } : {}),
        ...(Array.isArray(a['remove']) ? { remove: (a['remove'] as unknown[]).map(String) } : {}),
      }),
  },
];

/** Pull an optional string arg into a spread-able partial (omit when absent). */
function optStr(a: Record<string, unknown>, key: string): Record<string, string> {
  return a[key] != null ? { [key]: String(a[key]) } : {};
}
/** Pull an optional numeric arg into a spread-able partial (omit when absent). */
function optNum(a: Record<string, unknown>, key: string): Record<string, number> {
  return a[key] != null ? { [key]: Number(a[key]) } : {};
}

/** Tool lookup by name (built once from {@link TOOLS}). */
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Dispatch a `tools/call` to the named tool's handler (exported for the golden
 * tests). Throws {@link McpToolError} for an unknown tool. The result is the
 * tool's plain object — the server JSON-stringifies it into a text content block.
 */
export async function dispatch(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new McpToolError(`unknown tool "${name}"`);
  return tool.run(ctx, args);
}

async function remoteizeHandbacks(ctx: ToolContext, value: unknown, fallbackAccount?: string): Promise<unknown> {
  if (!ctx.enqueueJob) return value;
  if (typeof value === 'string' && value.startsWith('mail-index ')) {
    const account = /--account\s+([^\s]+)/.exec(value)?.[1] ?? fallbackAccount;
    if (!account) return { status: 'requires_account', poll: 'sync_status' };
    const kind = value.includes(' enrich ') ? 'enrich_bulk' : value.includes(' graph ') ? 'backfill' : 'sync';
    const jobId = await ctx.enqueueJob(kind, account, { command: value });
    return { job_id: jobId, status: 'queued', poll: 'sync_status' };
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => remoteizeHandbacks(ctx, item, fallbackAccount)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await remoteizeHandbacks(ctx, item, fallbackAccount)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

/** The `tools/list` payload (exported for tests): name + description + schema. */
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

/**
 * Build the stdio MCP {@link Server} bound to a {@link ToolContext}. Registers
 * the `tools/list` and `tools/call` handlers from the one {@link TOOLS} registry.
 * A tool error is returned as an `isError` content result (the MCP convention)
 * rather than throwing, so the client sees a clean tool error, not a transport
 * fault.
 */
export function buildServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: 'mail-index', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // Surfaced to the agent once at connect (no per-tool token cost). mail-index
      // has no telemetry, so feedback is explicit + opt-in: point the user at
      // GitHub. Nothing is ever sent automatically.
      instructions:
        'mail-index — local, read-only recall over THIS user\'s mailbox (Gmail), ' +
        'over MCP. REACH FOR THESE TOOLS WHENEVER a question could be answered from ' +
        'the user\'s email — even when no dedicated connector exists. That includes: ' +
        'what they bought / ordered / paid for (receipts, invoices, order ' +
        'confirmations, Amazon and other online purchases), bookings, travel, bills ' +
        'and subscriptions; what someone said or agreed; who emailed about X; a ' +
        'contact\'s address or details; newsletters; and "what did I miss / catch me ' +
        'up". For "what is in my inbox (right now / unread)" use `refresh_inbox` — it ' +
        'reconciles inbox membership against the live mailbox before returning, so the ' +
        'answer is current (plain index reads can lag as mail is archived/read). ' +
        'Start with `search` (fuzzy, ranked, snippet-first), `find_person`, or ' +
        '`catch_up`; the snippet rows already carry sender/subject/date, so only call ' +
        '`get_message` for the few rows you actually need the full body of — do not ' +
        'fetch every result. Local-first and read-only: it never sends or changes ' +
        'mail. No telemetry — to report a bug or give feedback, help the user draft ' +
        'it and point them to https://github.com/unsoldgroup/mail-index/issues ' +
        '(nothing is sent automatically).',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const callArgs = (args ?? {}) as Record<string, unknown>;
      const result = await remoteizeHandbacks(ctx, await dispatch(ctx, name, callArgs), typeof callArgs['account'] === 'string' ? callArgs['account'] : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** Connect the server to a fresh stdio transport (the production wiring). */
export async function serve(ctx: ToolContext): Promise<Server> {
  const server = buildServer(ctx);
  await server.connect(new StdioServerTransport());
  return server;
}

export interface HttpServeOptions {
  host: string;
  port: number;
  path: string;
  mode: 'full' | 'setup';
  build: () => Server;
  onShutdown?: () => void;
}

/** Serve one long-lived Streamable HTTP MCP endpoint for many agent sessions. */
export async function serveHttp(opts: HttpServeOptions): Promise<void> {
  const startedAt = Date.now();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, Server>();

  const closeSession = async (transport: StreamableHTTPServerTransport) => {
    const sid = transport.sessionId;
    if (!sid) return;
    transports.delete(sid);
    const server = servers.get(sid);
    servers.delete(sid);
    await server?.close();
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    const sessionId = req.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: initialize required' },
          id: null,
        }));
        return;
      }

      const server = opts.build();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport as StreamableHTTPServerTransport);
          servers.set(newSessionId, server);
        },
      });
      transport.onclose = () => {
        void closeSession(transport as StreamableHTTPServerTransport);
      };
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, body);
  };

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${opts.host}:${opts.port}`}`);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          name: 'mail-index',
          mode: opts.mode,
          uptime_ms: Date.now() - startedAt,
          sessions: transports.size,
        }));
        return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
        const transport = sid ? transports.get(sid) : undefined;
        if (!transport) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: unknown session' },
            id: null,
          }));
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST, DELETE' });
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      await handleMcp(req, res, body);
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message },
        id: null,
      }));
    });
  });

  const shutdown = async () => {
    opts.onShutdown?.();
    for (const transport of transports.values()) await transport.close();
    transports.clear();
    for (const server of servers.values()) await server.close();
    servers.clear();
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, resolve);
  });
  process.stderr.write(`mail-index-mcp: Streamable HTTP listening on http://${opts.host}:${opts.port}${opts.path}\n`);
}

/**
 * Build the SETUP-MODE server (the self-bootstrapping fallback). When no
 * operator config exists, the recall surface cannot be served (no index), so
 * instead of exiting we serve the reduced, ADVISORY {@link SETUP_TOOLS} surface
 * (`setup_status` + `setup_instructions`) so the agent/user can self-onboard
 * from inside the session. These tools are read-only (PATH + filesystem
 * observation) and never spawn — the install/auth/config work stays in the CLI
 * (`mail-index setup`), preserving the server's no-new-spawn egress invariant.
 * Kept in a separate registry/module (setup-tools.ts) from the trusted recall
 * core for exactly that reason.
 */
export function buildSetupServer(): Server {
  const server = new Server(
    { name: 'mail-index', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'mail-index — SETUP MODE: no operator config found yet, so only onboarding ' +
        'tools are available. Call setup_status to see what is installed/configured ' +
        'and setup_instructions for the exact steps. The server is advisory only — ' +
        'run `mail-index setup --account <email>` in your shell, then restart this ' +
        'server to load the full read-only recall surface.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: setupToolList() }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = dispatchSetup(name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** Connect a setup-mode server to a fresh stdio transport. */
export async function serveSetup(): Promise<Server> {
  const server = buildSetupServer();
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * The ADR-0005 detached background sync: re-exec the `mail-index` CLI as a
 * DETACHED, unref'd child running an incremental sync for the account, so it
 * outlives the MCP request (a request-scoped child cannot, per ADR-0005). The
 * child takes the per-account sync lock itself, so two of these never both
 * write (WAL is on; the sync_runs lock is the guard). Returns true once spawned.
 * Best-effort: a spawn failure returns false rather than throwing into a read.
 */
export function spawnDetachedSync(account: string, since?: string): boolean {
  try {
    // ADR-0005: incremental, never a full sweep — pass the caller-derived
    // `--since` so an account with a whole-mailbox policy still syncs only the
    // recent window on a stale read.
    const args = [cliEntry(), 'sync', '--account', account];
    if (since) args.push('--since', since);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Resolve the sibling `mail-index` CLI entry next to this MCP entry in dist/. */
function cliEntry(): string {
  // dist/mcp/server.js → dist/cli/index.js
  return new URL('../cli/index.js', import.meta.url).pathname;
}
