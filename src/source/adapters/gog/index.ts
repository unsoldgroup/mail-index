/**
 * The gog `MailSource` adapter (adapter #2 — the recommended Gmail transport).
 *
 * Wraps the gog CLI (github.com/openclaw/gogcli) by shelling out (via an
 * injectable {@link GogRunner}). gog needs a Google OAuth client (its own or a
 * shared one) configured via `gog auth credentials set` before `gog auth add`;
 * it then keeps its own tokens. The mailbox is selected per call with
 * `-a <account>` (the account email), not a config dir.
 *
 * Method → gog call mapping (the runner appends `-j --gmail-no-send`):
 *  - {@link GogAdapter.check}       `auth list`                       (is this account authorized?)
 *  - {@link GogAdapter.listIds}     `gmail messages search <q> --max --page`
 *  - {@link GogAdapter.getMetadata} `gmail raw <id>`                  (lossless Users.Messages.Get)
 *  - {@link GogAdapter.getFull}     `gmail raw <id>`                  (same call; body extracted)
 *  - {@link GogAdapter.modify}      `gmail messages modify <id> --add/--remove`  (OPT-IN write; needs gmail.modify)
 *
 * §8 pitfall: metadata is fetched with `gmail raw` (the lossless full resource),
 * NOT gog's `--format=metadata --headers <allow-list>` projection — `raw`
 * returns the complete header bag `is_list` classification needs. The body that
 * `raw` also returns is simply ignored for the metadata phase.
 *
 * The Gmail-JSON → neutral-record translation is shared with the gws adapter
 * (../gmail-shared.ts); both consume the identical Gmail REST resource. The body
 * is handed back as gog/Gmail gave it (base64url decoded); the ingest layer
 * distills (CONTEXT.md "Enrichment").
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
import { InsufficientScopeError, MAX_ATTACHMENT_BYTES } from '../../index.js';
import {
  type GmailMessage,
  buildGmailQuery,
  extractBodies,
  extractAttachments,
  toMessageAttachment,
  extractInlineAttachment,
  parseLabelList,
  toMetadata,
} from '../gmail-shared.js';
import { type GogRunner, GogError, spawnGogRunner } from './runner.js';

/** Construction options for {@link GogAdapter}. */
export interface GogAdapterOptions {
  /**
   * The mailbox email gog selects with `-a` and that `auth list` must show as
   * authorized (from the operator config's `account`).
   */
  account: string;
  /**
   * The gog invocation seam. Defaults to the process-backed {@link spawnGogRunner};
   * tests inject a fixture-backed runner for replay with no network.
   */
  runner?: GogRunner;
  /**
   * Page size for `gmail messages search` (`--max`). Defaults to 100.
   */
  pageSize?: number;
}

/** `gog auth list` response (only the fields the adapter reads). */
interface GogAuthList {
  accounts?: { email?: string; status?: string }[];
}

/**
 * Extract the `{id}` message stubs and next page token from a gog
 * `gmail messages search` response. gog returns the Gmail list shape
 * (`messages(id,threadId),nextPageToken`); tolerate a wrapping `result`
 * envelope just in case a gog version nests it.
 */
function readSearchPage(res: unknown): {
  messages: { id?: string; threadId?: string }[];
  nextPageToken?: string;
} {
  const root = (res ?? {}) as Record<string, unknown>;
  const body = (
    'messages' in root || 'nextPageToken' in root ? root : (root['result'] ?? root)
  ) as Record<string, unknown>;
  const messages = Array.isArray(body['messages'])
    ? (body['messages'] as { id?: string; threadId?: string }[])
    : [];
  const nextPageToken =
    typeof body['nextPageToken'] === 'string' ? (body['nextPageToken'] as string) : undefined;
  return { messages, nextPageToken };
}

export class GogAdapter implements MailSource {
  readonly provider = 'gog';
  readonly #account: string;
  readonly #runner: GogRunner;
  readonly #pageSize: number;

  constructor(options: GogAdapterOptions) {
    if (!options.account || options.account.trim() === '') {
      throw new GogError('GogAdapter requires a non-empty account email');
    }
    this.#account = options.account.trim();
    this.#runner = options.runner ?? spawnGogRunner();
    this.#pageSize = options.pageSize ?? 100;
  }

  #run(args: readonly string[]): Promise<unknown> {
    return this.#runner(args);
  }

  async check(): Promise<SourceIdentity> {
    try {
      const res = (await this.#run(['auth', 'list'])) as GogAuthList;
      const authed = (res?.accounts ?? []).some(
        (a) => a.email?.toLowerCase() === this.#account.toLowerCase(),
      );
      if (!authed) {
        return {
          ok: false,
          address: null,
          reason:
            `gog has no authorized account "${this.#account}" — run: ` +
            `gog auth add ${this.#account} --gmail-scope=readonly`,
        };
      }
      return { ok: true, address: this.#account };
    } catch (err) {
      return { ok: false, address: null, reason: (err as Error).message };
    }
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    // Shared Gmail query build (D11 Sent handling, since→newer_than). gog's
    // `messages search` requires a positive query term, so an unbounded sweep
    // (no query/since) falls back to `in:anywhere` (all mail incl. spam/trash),
    // matching the "whole mailbox" intent of an empty scope.
    const q = buildGmailQuery(scope) || 'in:anywhere';

    const limit = scope.limit;
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      const remaining = limit != null ? limit - emitted : undefined;
      if (remaining != null && remaining <= 0) return;
      const max = remaining != null ? Math.min(this.#pageSize, remaining) : this.#pageSize;

      const args = ['gmail', 'messages', 'search', q, '-a', this.#account, '--max', String(max)];
      if (pageToken) args.push('--page', pageToken);

      const { messages, nextPageToken } = readSearchPage(await this.#run(args));

      for (const m of messages) {
        if (!m.id) continue;
        if (limit != null && emitted >= limit) return;
        emitted += 1;
        yield m.id;
      }

      pageToken = nextPageToken;
    } while (pageToken);
  }

  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const out: MessageMetadata[] = [];
    for (const id of ids) {
      let res: GmailMessage;
      try {
        // §8 pitfall: `raw` (lossless full resource) so every header survives.
        res = (await this.#run(['gmail', 'raw', id, '-a', this.#account])) as GmailMessage;
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
      res = (await this.#run(['gmail', 'raw', id, '-a', this.#account])) as GmailMessage;
    } catch {
      return null;
    }
    if (!res?.id) return null;
    const { bodyText, bodyHtml, mimeType } = extractBodies(res.payload);
    return { ...toMetadata(res), bodyText, bodyHtml, mimeType };
  }

  async listAttachments(id: string) {
    const message = (await this.#run(['gmail', 'raw', id, '-a', this.#account])) as GmailMessage;
    return extractAttachments(message.payload).map(toMessageAttachment);
  }

  async getAttachment(id: string, attachmentId: string) {
    if (attachmentId.startsWith('inline:')) {
      const message = (await this.#run(['gmail', 'raw', id, '-a', this.#account])) as GmailMessage;
      return extractInlineAttachment(message.payload, attachmentId);
    }
    const result = (await this.#run([
      'gmail', 'attachment', id, attachmentId,
      '-a', this.#account,
      '--inline', '--inline-max-bytes', String(MAX_ATTACHMENT_BYTES),
      '--out', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ])) as { contentBase64?: string; bytes?: number; reason?: string };
    if (!result.contentBase64) {
      if (result.reason) throw new GogError(result.reason);
      return null;
    }
    return {
      data: result.contentBase64,
      size: result.bytes ?? Buffer.from(result.contentBase64, 'base64').byteLength,
    };
  }

  /** List the mailbox label catalogue via `gog gmail labels list`. */
  async listLabels(): Promise<ProviderLabel[]> {
    const res = (await this.#run(['gmail', 'labels', 'list', '-a', this.#account])) as {
      labels?: { id?: string; name?: string; type?: string }[];
    };
    return parseLabelList(res?.labels);
  }

  /**
   * OPT-IN write (the one mutating method). Apply a label change to one message
   * via `gog gmail messages modify <id> --add <csv> --remove <csv>`. gog's
   * `--gmail-no-send` guard (appended by the runner) blocks *send*, not modify,
   * so no runner change is needed. A no-op change (nothing to add or remove) is
   * skipped — gog requires at least one of the flags.
   *
   * Requires a `gmail.modify` grant; the default `gmail.readonly` install makes
   * gog exit with a 403/insufficient-scope error, which we re-throw as a typed
   * {@link InsufficientScopeError} carrying the exact re-auth command.
   */
  async modify(id: string, change: LabelChange): Promise<void> {
    const add = (change.addLabelIds ?? []).filter((s) => s.trim() !== '');
    const remove = (change.removeLabelIds ?? []).filter((s) => s.trim() !== '');
    if (add.length === 0 && remove.length === 0) return;

    const args = ['gmail', 'messages', 'modify', id, '-a', this.#account];
    if (add.length > 0) args.push('--add', add.join(','));
    if (remove.length > 0) args.push('--remove', remove.join(','));

    try {
      await this.#run(args);
    } catch (err) {
      const msg = (err as Error).message;
      if (isInsufficientScope(msg)) {
        throw new InsufficientScopeError('gog', this.reauthCommand(), msg);
      }
      throw err;
    }
  }

  /** The exact command to grant gog the least-privilege write (modify) scope. */
  reauthCommand(): string {
    return (
      `gog auth add ${this.#account} --client mail-index --services gmail ` +
      `--extra-scopes=https://www.googleapis.com/auth/gmail.modify`
    );
  }
}

/**
 * Heuristic: does a gog/Gmail error message indicate the token lacks a mutating
 * scope (vs. a transient/other failure)? Gmail returns HTTP 403 with
 * "Request had insufficient authentication scopes" / "PERMISSION_DENIED"; gog
 * surfaces that in stderr, which the runner folds into the GogError message.
 */
function isInsufficientScope(message: string): boolean {
  return /\b403\b|insufficient (?:authentication )?scopes?|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(
    message,
  );
}

export { GogError } from './runner.js';
export type { GogRunner, SpawnRunnerOptions } from './runner.js';
export { spawnGogRunner } from './runner.js';
