import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { instrumentMcpAnalytics, parseSurface, type ToolTiers } from '@unsoldgroup/mcp-telemetry';

/**
 * Tier of every advertised tool. `write` covers mailbox writes, index
 * write-backs, queued work and Deployment administration. A tool missing here
 * fails test/telemetry.test.ts.
 */
export const TOOL_TIERS: ToolTiers = {
  search: 'read', list_labeled: 'read', refresh_inbox: 'read', get_message: 'read',
  get_message_attachment: 'read', get_thread: 'read', list_contacts: 'read', get_contact: 'read',
  find_person: 'read', list_threads: 'read', graph_neighbors: 'read', graph_communities: 'read',
  interest_propose: 'read', interest_get: 'read', onboarding: 'read', settings_get: 'read',
  domains_to_categorize: 'read', cadence: 'read', sync_status: 'read', relay_menu_status: 'read',
  catch_up: 'read', digest_sources: 'read', trigger_rule_list: 'read',
  archive_message: 'write', modify_labels: 'write', create_draft: 'write',
  interest_set: 'write', settings_set: 'write', backfill_bodies: 'write', save_summary: 'write',
  save_domain_category: 'write', sync_now: 'write',
  trigger_rule_save: 'write', trigger_rule_delete: 'write',
  webhook_consumer_register: 'write', webhook_consumer_delete: 'write',
};

/** Reads that return mail content, correspondents or attachments. */
export const SENSITIVE_TOOLS = [
  'search', 'list_labeled', 'refresh_inbox', 'get_message', 'get_message_attachment', 'get_thread',
  'list_contacts', 'get_contact', 'find_person', 'list_threads', 'graph_neighbors', 'graph_communities',
  'interest_propose', 'domains_to_categorize', 'cadence', 'catch_up', 'digest_sources',
] as const;

export interface TelemetryEnv { POSTHOG_PROJECT_TOKEN?: string; POSTHOG_HOST?: string; ENVIRONMENT?: string; DEPLOY_GIT_SHA?: string }

/**
 * Operational metadata only (tool, tier, duration, error flag); the shared
 * package drops arguments and results. No-op without POSTHOG_PROJECT_TOKEN.
 * ponytail: the MCP route is stateless, so each request is its own PostHog
 * session. Thread mcp-session-id through if per-conversation funnels matter.
 */
export function instrumentWorkerMcp(server: Server, request: Request, env: TelemetryEnv, lifetime?: { waitUntil(promise: Promise<unknown>): void }): boolean {
  if (!env.POSTHOG_PROJECT_TOKEN || !lifetime) return false;
  // @posthog/mcp instruments the low-level Server too; the package types only McpServer.
  instrumentMcpAnalytics(server as unknown as McpServer, {
    token: env.POSTHOG_PROJECT_TOKEN,
    host: env.POSTHOG_HOST,
    lifetime,
    serverName: 'mail-index',
    environment: env.ENVIRONMENT ?? 'production',
    deploySha: env.DEPLOY_GIT_SHA,
    surface: parseSurface(request.url),
    tiers: TOOL_TIERS,
    sensitive: SENSITIVE_TOOLS,
  });
  return true;
}
