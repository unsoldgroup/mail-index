import type { AttachmentMetadata, MailSource } from '../src/source/index.js';
import type { CrmChangeFeed } from './crm-feed.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const BLOCKED_MIME_TYPES = new Set(['application/x-msdownload', 'application/x-dosexec']);

export interface AttachmentBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; contentDisposition?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get?(key: string): Promise<AttachmentObject | null>;
}

export interface AttachmentObject {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

function safeFilename(filename: string): string {
  const value = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
  return value || 'attachment.bin';
}

function decodeBase64(data: string): ArrayBuffer {
  const bytes = Buffer.from(data, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function inlineBytes(attachment: AttachmentMetadata): ArrayBuffer | null {
  // Inline part data comes straight off the Gmail payload, still base64url.
  if (!attachment.inlineDataBase64) return null;
  const bytes = Buffer.from(attachment.inlineDataBase64, 'base64url');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function eligibleMessage(message: Awaited<ReturnType<MailSource['getFull']>>): boolean {
  if (!message) return false;
  const labels = new Set((message.labels ?? []).map((label) => label.toUpperCase()));
  if (labels.has('SPAM') || labels.has('TRASH')) return false;
  if (message.headers && Object.keys(message.headers).some((key) => ['list-id', 'list-unsubscribe', 'auto-submitted'].includes(key.toLowerCase()))) return false;
  return true;
}

export async function storeMessageAttachments(input: {
  source: MailSource;
  feed: CrmChangeFeed;
  bucket?: AttachmentBucket;
  account: string;
  messageIds: readonly string[];
  jobId: string;
}): Promise<{ stored: number; skipped: number; lastCursor?: string }> {
  if (!input.bucket) return { stored: 0, skipped: 0 };
  let stored = 0;
  let skipped = 0;
  let lastCursor: string | undefined;
  for (const messageId of input.messageIds) {
    const message = await input.source.getFull(messageId);
    if (!eligibleMessage(message)) continue;
    for (const attachment of message?.attachments ?? []) {
      if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES || BLOCKED_MIME_TYPES.has(attachment.mimeType.toLowerCase())) {
        skipped += 1;
        lastCursor = await input.feed.append({
          account: input.account,
          entityType: 'attachment',
          entityKey: `${messageId}:${attachment.attachmentId}`,
          operation: 'upsert',
          dedupeKey: `attachment:${input.account}:${messageId}:${attachment.attachmentId}:rejected`,
          payload: { messageKey: messageId, filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, importStatus: 'rejected_by_policy' },
        });
        continue;
      }
      // `getAttachment` returns standard base64 (it also feeds the MCP tool,
      // which must hand bytes to an agent through JSON); R2 wants binary back.
      const fetched = attachment.inline || !input.source.getAttachment
        ? null
        : await input.source.getAttachment(messageId, attachment.attachmentId);
      const bytes = attachment.inline ? inlineBytes(attachment) : fetched ? decodeBase64(fetched.data) : null;
      if (!bytes) {
        skipped += 1;
        continue;
      }
      const filename = safeFilename(attachment.filename);
      const storageKey = `crm/${encodeURIComponent(input.account)}/${encodeURIComponent(messageId)}/${encodeURIComponent(attachment.attachmentId)}-${filename}`;
      await input.bucket.put(storageKey, bytes, {
        httpMetadata: { contentType: attachment.mimeType, contentDisposition: `attachment; filename="${filename}"` },
        customMetadata: { account: input.account, messageKey: messageId },
      });
      lastCursor = await input.feed.append({
        account: input.account,
        entityType: 'attachment',
        entityKey: `${messageId}:${attachment.attachmentId}`,
        operation: 'upsert',
        dedupeKey: `attachment:${input.account}:${messageId}:${attachment.attachmentId}:${storageKey}`,
        payload: { messageKey: messageId, filename, mimeType: attachment.mimeType, sizeBytes: bytes.byteLength, storageKey, importStatus: 'stored' },
      });
      stored += 1;
    }
  }
  return { stored, skipped, ...(lastCursor ? { lastCursor } : {}) };
}
