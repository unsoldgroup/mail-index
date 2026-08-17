/**
 * Shared Gmail-REST mapping helpers for the Gmail-backed adapters (gws, gog).
 *
 * Both adapters ultimately consume the *same* Gmail REST `Users.Messages.Get`
 * resource — gws via `gmail users messages get`, gog via `gmail raw` (which the
 * gog CLI documents as "Dump raw Gmail API response as JSON (Users.Messages.Get;
 * lossless)"). The translation from that JSON into the provider-neutral
 * {@link MessageMetadata}/{@link MessageFull} records is therefore identical, so
 * it lives here once rather than copy-pasted per adapter. No Gmail JSON shape
 * leaks above the adapter layer (PLAN §4); these helpers are that boundary.
 *
 * §8 pitfall lives with the callers, not here: an adapter must fetch the message
 * in a form that returns the *complete* header bag (gws plain `format=metadata`,
 * gog `raw`), never a restricted `metadataHeaders`/`--headers` projection, so
 * {@link headerBag} sees every `List-*` header `is_list` classification needs.
 */

import type { AttachmentMetadata, MessageAttachment, MessageMetadata, ProviderLabel } from '../index.js';

/** A header entry in a Gmail message payload. */
export interface GmailHeader {
  name?: string;
  value?: string;
}

/** A Gmail message payload (recursive: MIME parts nest payloads). */
export interface GmailPayload {
  filename?: string;
  mimeType?: string;
  partId?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GmailPayload[];
}

/**
 * Recursively collect provider-backed MIME attachments from a full Message.
 *
 * ONE traversal serves both consumers — the Deployment's R2 store (which needs
 * `inline` and the inline bytes) and the MCP listing (which needs id, name,
 * type, size). Two extractors would mean two id schemes, and an id listed by
 * one that the other cannot resolve is a silent "attachment not found".
 *
 * Inline parts carry no provider attachment id, so they get a synthetic one
 * derived from the part's PATH through the MIME tree — the same encoding
 * {@link extractInlineAttachment} walks back. A positional counter would not
 * round-trip: it shifts as soon as an earlier part is skipped.
 */
export function extractAttachments(payload: GmailPayload | undefined): AttachmentMetadata[] {
  const attachments: AttachmentMetadata[] = [];
  const visit = (part: GmailPayload | undefined, path: number[]): void => {
    if (!part) return;
    const filename = part.filename?.trim();
    const inlineId = part.body?.data ? `inline:${path.join('.')}` : undefined;
    if (filename && (part.body?.attachmentId || inlineId)) {
      attachments.push({
        attachmentId: part.body?.attachmentId ?? inlineId!,
        filename,
        mimeType: part.mimeType?.trim() || 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
        inline: !part.body?.attachmentId,
        ...(part.body?.data ? { inlineDataBase64: part.body.data } : {}),
      });
    }
    for (const [index, child] of (part.parts ?? []).entries()) visit(child, [...path, index]);
  };
  visit(payload, []);
  return attachments;
}

/** The listing view of an attachment — what an agent needs in order to pick one. */
export function toMessageAttachment(attachment: AttachmentMetadata): MessageAttachment {
  return {
    id: attachment.attachmentId,
    filename: attachment.filename || 'attachment',
    mimeType: attachment.mimeType,
    size: attachment.sizeBytes || null,
  };
}

/** Resolve bytes for a named MIME part whose content is inline in messages.get. */
export function extractInlineAttachment(
  payload: GmailPayload | undefined,
  id: string,
): { data: string; size: number } | null {
  if (!id.startsWith('inline:')) return null;
  const rawPath = id.slice('inline:'.length);
  const indexes = rawPath === '' ? [] : rawPath.split('.').map(Number);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0)) return null;
  let part = payload;
  for (const index of indexes) part = part?.parts?.[index];
  if (!part?.filename?.trim() || !part.body?.data) return null;
  const data = normalizeAttachmentBase64(part.body.data);
  return { data, size: part.body.size ?? Buffer.from(data, 'base64').byteLength };
}

/** Convert Gmail base64url into standard padded base64 for MCP blob content. */
export function normalizeAttachmentBase64(data: string): string {
  return Buffer.from(data, 'base64url').toString('base64');
}

/** Gmail `messages.get` response (the fields the adapters map). */
export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPayload;
}

/**
 * Collect every header on a payload into a name → value bag (§8: the complete,
 * unrestricted header set classification needs for `List-*` presence). Last
 * value wins on a duplicate header name — presence is all classification reads.
 */
export function headerBag(payload: GmailPayload | undefined): Record<string, string> {
  const bag: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    if (h.name != null && h.value != null) bag[h.name] = h.value;
  }
  return bag;
}

/** Case-insensitive lookup of a single header value from a payload. */
export function header(payload: GmailPayload | undefined, name: string): string | null {
  const headers = payload?.headers;
  if (!headers) return null;
  const want = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === want) return h.value ?? null;
  }
  return null;
}

/** Decode a Gmail base64url body part to a UTF-8 string. */
export function decodeBody(data: string | undefined): string | null {
  if (!data) return null;
  // Gmail uses base64url (`-`/`_`); Buffer's 'base64url' handles it directly.
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Walk a Gmail payload tree collecting the first text/plain and first text/html
 * body parts. Returns the decoded bodies + the mimeType the body was sourced
 * from (text/plain preferred for the distiller's `mimeType` hint).
 */
export function extractBodies(payload: GmailPayload | undefined): {
  bodyText: string | null;
  bodyHtml: string | null;
  mimeType: string | null;
} {
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;

  const visit = (p: GmailPayload | undefined): void => {
    if (!p) return;
    const mime = p.mimeType ?? '';
    if (mime === 'text/plain' && bodyText === null) {
      bodyText = decodeBody(p.body?.data);
    } else if (mime === 'text/html' && bodyHtml === null) {
      bodyHtml = decodeBody(p.body?.data);
    }
    // A non-multipart message carries its body on the top-level payload with no
    // parts; multipart messages nest text/* under `parts` (possibly deeper).
    if (p.parts) for (const child of p.parts) visit(child);
  };
  visit(payload);

  const mimeType = bodyText !== null ? 'text/plain' : bodyHtml !== null ? 'text/html' : null;
  return { bodyText, bodyHtml, mimeType };
}


/** Map a Gmail message resource to the provider-neutral metadata shape. */
export function toMetadata(msg: GmailMessage): MessageMetadata {
  const internal = msg.internalDate;
  return {
    id: msg.id ?? '',
    messageId: header(msg.payload, 'Message-ID'),
    threadId: msg.threadId ?? null,
    internalDate: internal != null && internal !== '' ? Number(internal) : null,
    dateHeader: header(msg.payload, 'Date'),
    from: header(msg.payload, 'From'),
    to: header(msg.payload, 'To'),
    cc: header(msg.payload, 'Cc'),
    subject: header(msg.payload, 'Subject'),
    labels: msg.labelIds ?? [],
    snippet: msg.snippet ?? null,
    sizeEstimate: msg.sizeEstimate ?? null,
    headers: headerBag(msg.payload),
  };
}

/**
 * Build the Gmail search query for a sweep from the provider-neutral scope
 * terms. `query` is passed through; `since` becomes `newer_than:<n>`;
 * `includeSent === false` adds `-in:sent` (D11). Shared so both Gmail adapters
 * build identical queries. Returns the joined term string (possibly empty).
 */
export function buildGmailQuery(scope: {
  query?: string;
  since?: string;
  includeSent?: boolean;
}): string {
  const terms: string[] = [];
  if (scope.query) terms.push(scope.query);
  if (scope.since) terms.push(`newer_than:${normaliseSince(scope.since)}`);
  if (scope.includeSent === false) terms.push('-in:sent');
  return terms.join(' ').trim();
}

/**
 * Normalise a `since` token to a Gmail `newer_than:` argument. Gmail accepts
 * `Nd`/`Nm`/`Ny`; the CLI/scope also allows `1mo`. ISO-8601 dates and unknown
 * tokens pass through unchanged (Gmail also accepts `newer_than:YYYY/MM/DD`).
 */
export function normaliseSince(since: string): string {
  const mo = /^(\d+)mo$/.exec(since.trim());
  if (mo) return `${mo[1]}m`;
  return since.trim();
}

/**
 * Normalise a Gmail `labels.list` payload (gog `gmail labels list` and gws
 * `gmail users labels list` return the identical `{labels:[{id,name,type}]}`
 * shape) into the provider-neutral {@link ProviderLabel} list. Drops entries
 * missing an id or name.
 */
export function parseLabelList(
  labels: { id?: string; name?: string; type?: string }[] | undefined,
): ProviderLabel[] {
  return (labels ?? [])
    .filter((l): l is { id: string; name: string; type?: string } => !!l.id && !!l.name)
    .map((l) => ({ id: l.id, name: l.name, ...(l.type ? { type: l.type } : {}) }));
}
