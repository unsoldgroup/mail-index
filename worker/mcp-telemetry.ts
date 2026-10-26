// Vendored from unsoldgroup/mcp-telemetry src/index.ts at c7db138 [USG-329].
// The package repo is private and ships no dist/, so CI cannot install it.
// Re-vendor here when the shared copy changes.
import { PostHog, instrument, type BeforeSendFn, type MCPAnalyticsOptions } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolTier = "read" | "write" | "send" | "money" | "destructive" | "exec";
export type ToolTiers = Readonly<Record<string, ToolTier>>;
export interface WaitUntil { waitUntil(promise: Promise<unknown>): void }
type CaptureEvent = Parameters<BeforeSendFn>[0];

export interface McpTelemetryOptions {
  /** PostHog project token. Missing token makes instrumentation a no-op. */
  token?: string;
  host?: string;
  /** Durable Object state (or ExecutionContext) that keeps delivery alive. */
  lifetime: WaitUntil;
  serverName: string;
  environment: string;
  deploySha?: string;
  /** Use parseSurface(request.url). Defaults to "claude". */
  surface?: string;
  tiers: ToolTiers;
  /** Tool names whose calls touch sensitive data. */
  sensitive?: readonly string[];
  /** Per-server hook run after the default allowlist. Return null to drop. */
  redact?: (event: CaptureEvent) => CaptureEvent | null | undefined;
  /** Scrubs get_more_tools intent text. Defaults to scrubPii. */
  scrubIntent?: (text: string) => string;
  /** Escape hatch for @posthog/mcp options; spread last. */
  sdkOptions?: MCPAnalyticsOptions;
}

export const GET_MORE_TOOLS = "get_more_tools";
const MISSING_CAPABILITY_EVENT = "$mcp_missing_capability";

// SDK credential redaction does not remove customer names, health disclosures,
// quote results, or signed checkout URLs. Keep operational metadata only.
export const ANALYTICS_PROPERTIES: ReadonlySet<string> = new Set([
  "$session_id", "$mcp_session_id", "$mcp_source", "$mcp_tool_name",
  "$mcp_resource_name", "$mcp_duration_ms", "$mcp_is_error",
  "$mcp_server_name", "$mcp_server_version", "$mcp_client_name",
  "$mcp_client_version", "$mcp_protocol_version", "$mcp_listed_tool_names",
  "$process_person_profile", "mcp_surface", "environment", "deployment_sha",
  "tool_tier", "sensitive", "mcp_server_name",
]);

const SURFACE = /^[a-z0-9_-]{1,32}$/;

/** Reads ?surface= from a connector URL; anything missing or malformed is "claude". */
export function parseSurface(url: string | URL): string {
  try {
    const surface = new URL(url).searchParams.get("surface")?.toLowerCase() ?? "";
    return SURFACE.test(surface) ? surface : "claude";
  } catch {
    return "claude";
  }
}

export function toolTier(tiers: ToolTiers, toolName: string): ToolTier | undefined {
  return Object.hasOwn(tiers, toolName) ? tiers[toolName] : undefined;
}

/** Throws when a listed tool has no tier, so CI catches unclassified tools. */
export function assertTierCoverage(listedToolNames: Iterable<string>, tiers: ToolTiers): void {
  const missing = [...listedToolNames].filter((name) => name !== GET_MORE_TOOLS && !toolTier(tiers, name));
  if (missing.length) throw new Error(`MCP tools without a tier: ${missing.join(", ")}`);
}

// ponytail: regex heuristics, over-redacts capitalised word pairs and misses
// lower-case names. Swap for a real NER pass if intent analysis needs names.
export function scrubPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/\bEXP-[A-Z0-9]{5,}\b/gi, "[quote_id]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m))
    .replace(/\b[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\b/g, "[name]");
}

/** The @posthog/mcp options instrumentMcpAnalytics uses; exported for custom clients and tests. */
export function mcpAnalyticsOptions(opts: Omit<McpTelemetryOptions, "token" | "host" | "lifetime">): MCPAnalyticsOptions {
  const sensitive = new Set(opts.sensitive ?? []);
  const scrub = opts.scrubIntent ?? scrubPii;
  const surface = opts.surface ?? "claude";
  return {
    // Failure flags and duration support reliability analysis without free
    // text intent or exception payloads. Preserve the existing tool schemas.
    context: false,
    captureModel: false,
    enableConversationId: false,
    enableExceptionAutocapture: false,
    reportMissing: true,
    serverBuild: opts.deploySha,
    beforeSend: (event) => {
      const properties = Object.fromEntries(
        Object.entries(event.properties ?? {}).filter(([key]) => ANALYTICS_PROPERTIES.has(key)),
      );
      // The only free text kept: what capability the agent was missing.
      const intent = event.properties?.$mcp_intent;
      if (event.event === MISSING_CAPABILITY_EVENT && typeof intent === "string") properties.$mcp_intent = scrub(intent);
      const filtered = { ...event, properties };
      return opts.redact ? opts.redact(filtered) : filtered;
    },
    eventProperties: (request) => {
      const name = (request as { params?: { name?: unknown } }).params?.name;
      const tool = typeof name === "string" ? name : undefined;
      const tier = tool && toolTier(opts.tiers, tool);
      return {
        mcp_surface: surface,
        mcp_server_name: opts.serverName,
        environment: opts.environment,
        deployment_sha: opts.deploySha ?? "unknown",
        ...(tier ? { tool_tier: tier } : {}),
        ...(tool ? { sensitive: sensitive.has(tool) } : {}),
      };
    },
    ...opts.sdkOptions,
  };
}

/** Each session owns its client and its Durable Object lifetime protection. */
export class WorkerPostHog extends PostHog {
  constructor(token: string, host: string, private readonly lifetime: WaitUntil) {
    super(token, { host, flushAt: 1, flushInterval: 0, disableGeoip: true });
  }

  override capture(event: Parameters<PostHog["capture"]>[0]): void {
    // Retain delivery on the owning DO without adding it to tool latency.
    this.lifetime.waitUntil(this.captureImmediate(event).catch(() => {
      console.error("[posthog-mcp] event delivery failed");
    }));
  }
}

export function instrumentMcpAnalytics(server: McpServer, opts: McpTelemetryOptions): void {
  if (!opts.token) return;
  try {
    const posthog = new WorkerPostHog(opts.token, opts.host || "https://us.i.posthog.com", opts.lifetime);
    instrument(server, posthog, mcpAnalyticsOptions(opts));
  } catch {
    console.error("[posthog-mcp] failed to instrument MCP server");
  }
}
