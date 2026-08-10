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
  extractBodies,
  extractAttachments,
  parseLabelList,
  toMetadata,
} from '../gmail-shared.js';
import {
  createGmailRestRunner,
  GmailRestError,
  type GmailRestRunner,
} from './runner.js';

export interface GmailRestAdapterOptions {
  fetchImpl: typeof fetch;
  tokenProvider: () => Promise<string>;
  pageSize?: number;
}

interface GmailListResponse {
  messages?: { id?: string }[];
  nextPageToken?: string;
}

export class GmailRestAdapter implements MailSource {
  readonly provider = 'gmail-rest';
  readonly #run: GmailRestRunner;
  readonly #pageSize: number;

  constructor(options: GmailRestAdapterOptions) {
    this.#run = createGmailRestRunner(options.fetchImpl, options.tokenProvider);
    this.#pageSize = options.pageSize ?? 100;
  }

  async check(): Promise<SourceIdentity> {
    try {
      const profile = (await this.#run({ path: 'profile' })) as { emailAddress?: string };
      return profile.emailAddress
        ? { ok: true, address: profile.emailAddress }
        : { ok: false, address: null, reason: 'Gmail profile returned no emailAddress' };
    } catch (error) {
      return { ok: false, address: null, reason: (error as Error).message };
    }
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    const q = buildGmailQuery(scope);
    let emitted = 0;
    let pageToken: string | undefined;
    do {
      const remaining = scope.limit === undefined ? undefined : scope.limit - emitted;
      if (remaining !== undefined && remaining <= 0) return;
      const maxResults = remaining === undefined ? this.#pageSize : Math.min(this.#pageSize, remaining);
      const response = (await this.#run({
        path: 'messages',
        query: { maxResults, q: q || undefined, pageToken },
      })) as GmailListResponse;
      for (const message of response.messages ?? []) {
        if (!message.id) continue;
        if (scope.limit !== undefined && emitted >= scope.limit) return;
        emitted += 1;
        yield message.id;
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
  }

  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const messages: MessageMetadata[] = [];
    for (const id of ids) {
      try {
        const message = (await this.#run({
          path: `messages/${encodeURIComponent(id)}`,
          query: { format: 'metadata' },
        })) as GmailMessage;
        if (message.id) messages.push(toMetadata(message));
      } catch (error) {
        if (!(error instanceof GmailRestError) || error.status !== 404) throw error;
      }
    }
    return messages;
  }

  async getFull(id: string): Promise<MessageFull | null> {
    try {
      const message = (await this.#run({
        path: `messages/${encodeURIComponent(id)}`,
        query: { format: 'full' },
      })) as GmailMessage;
      if (!message.id) return null;
      return { ...toMetadata(message), ...extractBodies(message.payload), attachments: extractAttachments(message.payload) };
    } catch (error) {
      if (error instanceof GmailRestError && error.status === 404) return null;
      throw error;
    }
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<ArrayBuffer> {
    const response = await this.#run({
      path: `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    }) as { data?: string };
    if (!response.data) throw new Error(`Gmail attachment ${attachmentId} returned no data`);
    const bytes = Buffer.from(response.data, 'base64url');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async listLabels(): Promise<ProviderLabel[]> {
    const response = (await this.#run({ path: 'labels' })) as {
      labels?: { id?: string; name?: string; type?: string }[];
    };
    return parseLabelList(response.labels);
  }

  async modify(id: string, change: LabelChange): Promise<void> {
    const addLabelIds = (change.addLabelIds ?? []).filter(Boolean);
    const removeLabelIds = (change.removeLabelIds ?? []).filter(Boolean);
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;
    try {
      await this.#run({
        path: `messages/${encodeURIComponent(id)}/modify`,
        method: 'POST',
        body: { addLabelIds, removeLabelIds },
      });
    } catch (error) {
      if (error instanceof GmailRestError && error.status === 403) {
        throw new InsufficientScopeError(
          this.provider,
          'Reconnect this Account with Gmail mailbox writes enabled.',
          error.message,
        );
      }
      throw error;
    }
  }
}

export { GmailRestError, createGmailRestRunner } from './runner.js';
export type { GmailRestRequest, GmailRestRunner } from './runner.js';
