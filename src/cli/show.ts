/**
 * `mail-index show <account:message-id>` (SCOPE 1.2, PLAN §13, ADR-0001).
 *
 * Prints one message's full record from the index. The lazy-enrichment hook: if
 * the row is still `body_state='meta'`, `show` auto-enriches it first — one
 * bounded `getFull` → distil → upsert ({@link enrichOne}) — then prints the
 * distilled body. This is the O(1) inline pattern (ADR-0001: a single bounded
 * provider fetch mid-conversation is allowed; bulk fetches are not).
 *
 * The `<ref>` handle is the `<account>:<gmail-message-id>` string `search` /
 * `open` emit. Account resolution and adapter construction reuse the sync CLI
 * seam ({@link buildSource}), so `show` knows nothing provider-specific.
 */

import { resolveAccount, type AccountConfig, type OperatorConfig } from '../config/index.js';
import { Repo, type MessageRow } from '../index/repo.js';
import type { MailSource } from '../source/index.js';
import { enrichOne } from '../ingest/enrich.js';
import { isLikelyImageOnly } from '../intelligence/images.js';

import { buildSource } from './sync.js';

/** Error thrown for malformed/unresolvable `show`/`open` references. */
export class RefError extends Error {
  override name = 'RefError';
}

/** A parsed `<account>:<gmail-message-id>` reference. */
export interface MessageRef {
  account: string;
  id: string;
}

/**
 * Parse the `<account>:<gmail-message-id>` ref `search`/`open` emit. The account
 * label is everything before the FIRST colon; the id is the remainder (gmail
 * message ids are hex and colon-free, but splitting on the first colon keeps the
 * id intact even if that ever changes). Both sides must be non-empty.
 */
export function parseRef(raw: string): MessageRef {
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx === raw.length - 1) {
    throw new RefError(
      `invalid reference "${raw}" — expected <account>:<message-id> (e.g. personal:18f0a1b2c3)`,
    );
  }
  return { account: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

/** Outcome of {@link runShow}: the (possibly just-enriched) row + whether we enriched. */
export interface ShowResult {
  ref: MessageRef;
  row: MessageRow;
  /** True when the row was at `meta` and we auto-enriched it on this call. */
  enriched: boolean;
}

/**
 * Resolve a ref to its full record, auto-enriching a `meta` row first (ADR-0001
 * O(1) inline). Reads the row, and when it is still `meta` runs a single-message
 * {@link enrichOne} through the account's adapter, then re-reads so the returned
 * row carries the distilled body. Throws {@link RefError} when the account is
 * not configured or the message is not in the index.
 *
 * `buildSourceFn` is injectable so tests can wire a fake source without an
 * operator config or a live provider.
 */
export async function runShow(
  config: OperatorConfig,
  repo: Repo,
  ref: MessageRef,
  buildSourceFn: (account: AccountConfig) => MailSource = buildSource,
): Promise<ShowResult> {
  let row = await repo.getMessage(ref.account, ref.id);
  if (!row) {
    // Surface a config error early when the account label itself is unknown, so
    // the message is "unknown account" rather than a bare "not in the index".
    resolveAccount(config, ref.account);
    throw new RefError(
      `message ${ref.account}:${ref.id} is not in the index — sync the account first`,
    );
  }

  let enriched = false;
  if (row.body_state === 'meta') {
    const account = resolveAccount(config, ref.account);
    const source = buildSourceFn(account);
    enriched = await enrichOne({ account: ref.account, id: ref.id, source, repo });
    const refreshed = await repo.getMessage(ref.account, ref.id);
    if (refreshed) row = refreshed;
  }

  return { ref, row, enriched };
}

/** Render `internal_date` (epoch ms) as `YYYY-MM-DD HH:MM` UTC, or `?`. */
function formatTimestamp(internalDate: number | null): string {
  if (internalDate == null) return '?';
  const d = new Date(internalDate);
  if (Number.isNaN(d.getTime())) return '?';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Render the full record as a readable block: a header of the structured fields,
 * then the distilled body (or a note that it is not yet enriched — only reached
 * when enrichment found no body to fetch).
 */
export function formatShow(result: ShowResult): string {
  const { row, ref, enriched } = result;
  const lines: string[] = [];

  lines.push(`ref:      ${ref.account}:${ref.id}`);
  if (row.subject) lines.push(`subject:  ${row.subject}`);
  if (row.from_addr) lines.push(`from:     ${row.from_addr}`);
  if (row.to_addr) lines.push(`to:       ${row.to_addr}`);
  if (row.cc_addr) lines.push(`cc:       ${row.cc_addr}`);
  lines.push(`date:     ${formatTimestamp(row.internal_date)}`);
  if (row.thread_id) lines.push(`thread:   ${row.thread_id}`);
  if (row.category) lines.push(`category: ${row.category}`);

  const flags: string[] = [];
  if (row.unread) flags.push('unread');
  if (row.starred) flags.push('starred');
  if (row.important) flags.push('important');
  if (row.is_list) flags.push('list');
  flags.push(row.direction);
  lines.push(`flags:    ${flags.join(', ')}`);
  lines.push(`body:     ${row.body_state}${enriched ? ' (just enriched)' : ''}`);

  // OCR candidates: when the offer lives in images rather than text, list the
  // content-bearing images so an agent (or the reader) can open + read them.
  // mail-index never OCRs — it only points at the images.
  const ocr = parseOcrImages(row.ocr_images_json);
  if (ocr.length > 0) {
    const thin = isLikelyImageOnly(row.body_text, ocr.length);
    lines.push(
      `images:   ${ocr.length} OCR candidate(s)${thin ? ' — offer likely in images, not text' : ''}`,
    );
    for (const img of ocr.slice(0, 6)) {
      const dim = img.width && img.height ? ` (${img.width}x${img.height})` : '';
      lines.push(`            • ${img.src}${dim}`);
    }
  }

  lines.push('');
  if (row.body_state === 'full' && row.body_text) {
    lines.push(row.body_text);
  } else if (row.body_text) {
    lines.push(row.body_text);
  } else {
    // Still meta after an enrich attempt → the provider returned no body.
    lines.push(`(no distilled body available — snippet: ${row.snippet ?? '∅'})`);
  }

  return lines.join('\n') + '\n';
}

/** A stored OCR-candidate image, as much as `show` renders of it. */
interface OcrImage {
  src: string;
  width?: number | null;
  height?: number | null;
}

/** Parse `ocr_images_json` into a render-ready list (or `[]` on absent/bad JSON). */
function parseOcrImages(json: string | null): OcrImage[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as OcrImage[]).filter((x) => x && typeof x.src === 'string') : [];
  } catch {
    return [];
  }
}
