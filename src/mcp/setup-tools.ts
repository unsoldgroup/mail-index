/**
 * MCP SETUP-MODE tools (the self-bootstrapping reduced surface).
 *
 * When the server starts with NO operator config (a first-run install), it
 * cannot serve the full recall surface — there is no index to read. Rather
 * than exit with an error (the old behaviour), it serves this small, advisory
 * surface so the agent/user can self-onboard from inside the MCP session.
 *
 * TRUST BOUNDARY (deliberate, documented): these tools are kept in a SEPARATE
 * module from the read-only recall core (tools.ts) because they have a different
 * profile. They are nonetheless STILL READ-ONLY / ADVISORY in this first cut:
 * they return STATUS (what is installed/authed/configured, detected by pure
 * filesystem + PATH lookups) and INSTRUCTIONS (the exact commands the human/agent
 * must run). They DO NOT spawn installers, write config, or authenticate from
 * inside the server — that stays the CLI's (`mail-index setup`) / GUI's job,
 * where the spawn seam (src/cli/proc.ts) and the egress guard live. Keeping the
 * server free of process-spawning preserves the egress invariant: the MCP server
 * never gains a new spawn surface from bootstrapping.
 *
 * Detection here is pure observation — `which` is a PATH/existsSync scan
 * (no spawn), config presence is an existsSync. The surface is intentionally
 * tiny: `setup_status` (what's done) + `setup_instructions` (what's left).
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/server';

import { defaultConfigPath } from '../config/index.js';

/** A binary-detected-on-PATH check — pure lookup, never spawns. */
function onPath(bin: string): boolean {
  const path = process.env['PATH'] ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (existsSync(join(dir, bin + ext))) return true;
    }
  }
  return false;
}

/** Observed onboarding state — all from filesystem/PATH, no process spawned. */
export interface SetupState {
  config_present: boolean;
  config_path: string;
  gog_installed: boolean;
  gws_installed: boolean;
  keyring_backend_file: boolean;
}

/** The advisory step records `setup_instructions` returns. */
export interface SetupInstruction {
  step: string;
  /** `done` when already satisfied, else `todo`. */
  status: 'done' | 'todo';
  detail: string;
  /** The exact command to run (when there is one). */
  command?: string;
  /** True when this step needs a HUMAN (browser consent / manual install). */
  human?: boolean;
}

/** Observe the current onboarding state (pure; for `setup_status`). */
export function observeState(configPath = defaultConfigPath()): SetupState {
  return {
    config_present: existsSync(configPath),
    config_path: configPath,
    gog_installed: onPath('gog'),
    gws_installed: onPath('gws'),
    keyring_backend_file: process.env['GOG_KEYRING_BACKEND'] === 'file',
  };
}

/** `setup_status`: what is installed / authed / configured (read-only). */
export function setupStatus(configPath = defaultConfigPath()): {
  mode: 'setup';
  state: SetupState;
  ready: boolean;
  summary: string;
} {
  const state = observeState(configPath);
  const ready = state.config_present;
  const summary = ready
    ? 'Config present — restart the MCP server to load the full recall surface.'
    : `Setup incomplete: ${state.gog_installed ? 'gog installed' : 'gog NOT installed'}, ` +
      `config ${state.config_present ? 'present' : 'absent'}. ` +
      'Run setup_instructions for the exact steps.';
  return { mode: 'setup', state, ready, summary };
}

/**
 * `setup_instructions`: the exact steps/commands to finish onboarding, with the
 * two HUMAN steps (browser OAuth, and a manual install when gog is absent on a
 * non-Homebrew host) flagged. The fast path is a single `mail-index setup`
 * invocation, so the primary instruction is that one command; the granular steps
 * are advisory context for an agent that wants to drive each phase.
 */
export function setupInstructions(
  account?: string,
  configPath = defaultConfigPath(),
): {
  mode: 'setup';
  recommended_command: string;
  steps: SetupInstruction[];
  note: string;
} {
  const state = observeState(configPath);
  const acct = account ?? '<your-email>';
  const steps: SetupInstruction[] = [
    {
      step: 'install_adapter',
      status: state.gog_installed ? 'done' : 'todo',
      detail: state.gog_installed
        ? 'gog adapter CLI is installed.'
        : 'Install the gog adapter CLI (macOS: Homebrew; otherwise a release binary).',
      ...(state.gog_installed ? {} : { command: 'brew install openclaw/tap/gogcli', human: true }),
    },
    {
      step: 'keyring',
      status: state.keyring_backend_file ? 'done' : 'todo',
      detail: state.keyring_backend_file
        ? 'GOG_KEYRING_BACKEND=file is set.'
        : 'Export GOG_KEYRING_BACKEND=file for a headless token store (set GOG_KEYRING_PASSWORD yourself).',
      ...(state.keyring_backend_file ? {} : { command: 'export GOG_KEYRING_BACKEND=file' }),
    },
    {
      step: 'authenticate',
      status: 'todo',
      detail: `Authenticate ${acct} for read-only Gmail (opens a browser once).`,
      command: `gog auth add ${acct} --client mail-index --services gmail --gmail-scope=readonly`,
      human: true,
    },
    {
      step: 'config_and_sync',
      status: state.config_present ? 'done' : 'todo',
      detail: state.config_present
        ? `Operator config exists at ${state.config_path}.`
        : 'Write the account into config.json and run the first sync.',
      ...(state.config_present ? {} : { command: `mail-index setup --account ${acct}` }),
    },
  ];
  return {
    mode: 'setup',
    recommended_command: `mail-index setup --account ${acct}`,
    steps,
    note:
      'These tools are advisory: the server does NOT install, authenticate, or write config. ' +
      'Run the recommended command in your shell (it handles install→auth→config→sync), then ' +
      'restart the MCP server to load the full read-only recall surface.',
  };
}

/** A registered setup tool: advertised contract + a pure, read-only handler. */
export interface SetupToolDef {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  run: (args: Record<string, unknown>) => unknown;
}

/** The reduced setup-mode surface (2 advisory, read-only tools). */
export const SETUP_TOOLS: SetupToolDef[] = [
  {
    name: 'setup_status',
    description:
      'SETUP MODE (no config yet). Report what is installed / authenticated / configured for mail-index — read-only observation (PATH + filesystem). Tells you whether onboarding is complete and the server can be restarted into full recall mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => setupStatus(),
  },
  {
    name: 'setup_instructions',
    description:
      'SETUP MODE (no config yet). Return the exact steps + commands to finish onboarding mail-index, flagging the human steps (browser OAuth consent; manual install when Homebrew is unavailable). The server is advisory only — run `mail-index setup --account <email>` in your shell, then restart the server.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string' } },
      additionalProperties: false,
    },
    run: (a) => setupInstructions(a['account'] != null ? String(a['account']) : undefined),
  },
];

/** `tools/list` payload for setup mode (name + description + schema). */
export function setupToolList(): Tool[] {
  return SETUP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Dispatch a setup-mode `tools/call` by name. Throws on an unknown tool. */
export function dispatchSetup(name: string, args: Record<string, unknown>): unknown {
  const tool = SETUP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown setup tool "${name}"`);
  return tool.run(args);
}
