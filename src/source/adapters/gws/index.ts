/**
 * The gws `MailSource` adapter (SCOPE 0.4, D1 — adapter #1, PLAN §7 two-phase
 * sync, §8 classification, §15 multi-account).
 *
 * Wraps the gws Google Workspace CLI by shelling out (via an injectable
 * {@link GwsRunner}) with the account's per-account
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`. It is the only place that knows the Gmail
 * REST JSON shape gws emits; it translates that into the provider-neutral
 * `MailSource` records the rest of the tool consumes (no Gmail JSON leaks above
 * this layer).
 *
 * Method → gws call mapping:
 *  - {@link GwsAdapter.check}       `gmail users getProfile`            (auth/identity probe)
 *  - {@link GwsAdapter.listIds}     `gmail users messages list`         (paged; honours scope)
 *  - {@link GwsAdapter.getMetadata} `gmail users messages get format=metadata`
 *  - {@link GwsAdapter.getFull}     `gmail users messages get format=full`
 *  - {@link GwsAdapter.modify}      `gmail users messages modify`        (OPT-IN write; needs a modify scope)
 *
 * §8 pitfall: `getMetadata` uses **plain** `format=metadata` and never passes
 * `metadataHeaders` — restricting headers through gws is unreliable and silently
 * drops `List-*` headers, which would break `is_list` classification.
 *
 * Distillation is NOT done here (CONTEXT.md "Enrichment"): `getFull` hands back
 * the body parts as gws/Gmail gave them (decoded from base64url to UTF-8), and
 * the ingest layer distills.
 */

import type {
  LabelChange,
  MailScope,
  MailSource,
  MessageFull,
  MessageMetadata,
  ProviderLabel,
  SourceIdentity,
} from '../../index.js';
import { InsufficientScopeError } from '../../index.js';
import {
  type GmailMessage,
  buildGmailQuery,
  extractAttachments,
  toMessageAttachment,
  extractBodies,
  extractInlineAttachment,
  normalizeAttachmentBase64,
  parseLabelList,
  toMetadata,
} from '../gmail-shared.js';
import { type GwsRunner, GwsError, spawnGwsRunner } from './runner.js';

/** Construction options for {@link GwsAdapter}. */
export interface GwsAdapterOptions {
  /**
   * Per-account `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` — the isolated gws config for
   * this mailbox (from the operator config's `configDir`, §15).
   */
  configDir: string;
  /**
   * The gws invocation seam. Defaults to the process-backed {@link spawnGwsRunner};
   * tests inject a fixture-backed runner for replay with no network.
   */
  runner?: GwsRunner;
  /**
   * Page size for `messages list` (Gmail `maxResults`, max 500). Defaults to
   * 100 (the Gmail API default).
   */
  pageSize?: number;
}

/** Gmail `messages.list` response (only the fields the adapter reads). */
interface GmailListResponse {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
}

/** Gmail `users.getProfile` response. */
interface GmailProfile {
  emailAddress?: string;
}

export class GwsAdapter implements MailSource {
  readonly provider = 'gws';
  readonly #configDir: string;
  readonly #runner: GwsRunner;
  readonly #pageSize: number;

  constructor(options: GwsAdapterOptions) {
    if (!options.configDir || options.configDir.trim() === '') {
      throw new GwsError('GwsAdapter requires a non-empty configDir');
    }
    this.#configDir = options.configDir;
    this.#runner = options.runner ?? spawnGwsRunner();
    this.#pageSize = options.pageSize ?? 100;
  }

  #run(args: readonly string[]): Promise<unknown> {
    return this.#runner(args, this.#configDir);
  }

  async check(): Promise<SourceIdentity> {
    try {
      const res = (await this.#run([
        'gmail',
        'users',
        'getProfile',
        '--params',
        JSON.stringify({ userId: 'me' }),
      ])) as GmailProfile;
      const address = res?.emailAddress ?? null;
      if (!address) {
        return { ok: false, address: null, reason: 'gws getProfile returned no emailAddress' };
      }
      return { ok: true, address };
    } catch (err) {
      return { ok: false, address: null, reason: (err as Error).message };
    }
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    // Build the Gmail search query from the scope (shared with the gog adapter).
    // `includeSent !== false` keeps Sent in scope (D11); `includeSent: false`
    // excludes it; `since`/`query` pass through as Gmail search terms.
    const q = buildGmailQuery(scope);

    const limit = scope.limit;
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      const remaining = limit != null ? limit - emitted : undefined;
      if (remaining != null && remaining <= 0) return;
      const maxResults =
        remaining != null ? Math.min(this.#pageSize, remaining) : this.#pageSize;

      const params: Record<string, unknown> = { userId: 'me', maxResults };
      if (q) params['q'] = q;
      if (pageToken) params['pageToken'] = pageToken;

      const res = (await this.#run([
        'gmail',
        'users',
        'messages',
        'list',
        '--params',
        JSON.stringify(params),
      ])) as GmailListResponse;

      for (const m of res.messages ?? []) {
        if (!m.id) continue;
        if (limit != null && emitted >= limit) return;
        emitted += 1;
        yield m.id;
      }

      pageToken = res.nextPageToken;
    } while (pageToken);
  }

  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const out: MessageMetadata[] = [];
    for (const id of ids) {
      let res: GmailMessage;
      try {
        // §8 pitfall: plain format=metadata, NEVER metadataHeaders.
        res = (await this.#run([
          'gmail',
          'users',
          'messages',
          'get',
          '--params',
          JSON.stringify({ userId: 'me', id, format: 'metadata' }),
        ])) as GmailMessage;
      } catch {
        // An id the provider cannot return (deleted, inaccessible) is omitted
        // rather than represented as a hole — per the contract.
        continue;
      }
      if (res?.id) out.push(toMetadata(res));
    }
    return out;
  }

  async getFull(id: string): Promise<MessageFull | null> {
    let res: GmailMessage;
    try {
      res = (await this.#run([
        'gmail',
        'users',
        'messages',
        'get',
        '--params',
        JSON.stringify({ userId: 'me', id, format: 'full' }),
      ])) as GmailMessage;
    } catch {
      return null;
    }
    if (!res?.id) return null;
    const { bodyText, bodyHtml, mimeType } = extractBodies(res.payload);
    return { ...toMetadata(res), bodyText, bodyHtml, mimeType };
  }

  async listAttachments(id: string) {
    const res = (await this.#run([
      'gmail', 'users', 'messages', 'get', '--params',
      JSON.stringify({ userId: 'me', id, format: 'full' }),
    ])) as GmailMessage;
    return extractAttachments(res.payload).map(toMessageAttachment);
  }

  async getAttachment(id: string, attachmentId: string) {
    if (attachmentId.startsWith('inline:')) {
      const message = (await this.#run([
        'gmail', 'users', 'messages', 'get', '--params',
        JSON.stringify({ userId: 'me', id, format: 'full' }),
      ])) as GmailMessage;
      return extractInlineAttachment(message.payload, attachmentId);
    }
    const result = (await this.#run([
      'gmail', 'users', 'messages', 'attachments', 'get', '--params',
      JSON.stringify({ userId: 'me', messageId: id, id: attachmentId }),
    ])) as { data?: string; size?: number };
    if (!result.data) return null;
    const data = normalizeAttachmentBase64(result.data);
    return { data, size: result.size ?? Buffer.from(data, 'base64').byteLength };
  }

  /** List the mailbox label catalogue via `gws gmail users labels list`. */
  async listLabels(): Promise<ProviderLabel[]> {
    const res = (await this.#run([
      'gmail',
      'users',
      'labels',
      'list',
      '--params',
      JSON.stringify({ userId: 'me' }),
    ])) as { labels?: { id?: string; name?: string; type?: string }[] };
    return parseLabelList(res?.labels);
  }

  /**
   * OPT-IN write (the one mutating method). Apply a label change to one message
   * via `gws gmail users messages modify` — the Gmail `messages.modify` REST
   * call (addLabelIds / removeLabelIds). Archive = remove `INBOX`. A no-op change
   * is skipped (the API requires at least one of the two arrays).
   *
   * The gws config supplies the scope. A Gmail *modify* capability is required
   * (`gmail.modify` or the broader `https://mail.google.com/`); a read-only gws
   * grant makes the API return 403, which we re-throw as a typed
   * {@link InsufficientScopeError}.
   */
  async modify(id: string, change: LabelChange): Promise<void> {
    const addLabelIds = (change.addLabelIds ?? []).filter((s) => s.trim() !== '');
    const removeLabelIds = (change.removeLabelIds ?? []).filter((s) => s.trim() !== '');
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;

    // gws splits URL/path params (`--params`) from the request BODY (`--json`).
    // userId/id are path params; the label arrays are the messages.modify body —
    // putting them in --params makes gws treat the array as a single literal
    // label ("Invalid label: [...]"). So: --params for the path, --json for body.
    const body: Record<string, unknown> = {};
    if (addLabelIds.length > 0) body['addLabelIds'] = addLabelIds;
    if (removeLabelIds.length > 0) body['removeLabelIds'] = removeLabelIds;

    try {
      await this.#run([
        'gmail',
        'users',
        'messages',
        'modify',
        '--params',
        JSON.stringify({ userId: 'me', id }),
        '--json',
        JSON.stringify(body),
      ]);
    } catch (err) {
      const msg = (err as Error).message;
      if (isInsufficientScope(msg)) {
        throw new InsufficientScopeError(
          'gws',
          'gws auth login  # re-authorize this mailbox with a Gmail modify scope ' +
            '(gmail.modify or https://mail.google.com/)',
          msg,
        );
      }
      throw err;
    }
  }
}

/**
 * Heuristic: does a gws/Gmail error indicate the token lacks a mutating scope
 * (vs. a transient/other failure)? Gmail returns HTTP 403 with "insufficient
 * authentication scopes" / "PERMISSION_DENIED"; gws folds that into its error.
 */
function isInsufficientScope(message: string): boolean {
  return /\b403\b|insufficient (?:authentication )?scopes?|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(
    message,
  );
}

export { GwsError } from './runner.js';
export type { GwsRunner, SpawnRunnerOptions } from './runner.js';
export { spawnGwsRunner } from './runner.js';
