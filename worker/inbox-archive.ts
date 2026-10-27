import { D1Driver } from '../src/index/drivers/d1.js';
import { applyLabelChange, archiveChange } from '../src/ingest/mutate.js';
import { InsufficientScopeError, type MailSource } from '../src/source/index.js';
import { buildWorkerToolContext, type Env } from './index.js';

export type InboxArchiveStatus = 'archived' | 'already_archived' | 'not_found' | 'insufficient_scope' | 'disabled' | 'account_not_allowed' | 'invalid';
export interface InboxArchiveResult { status: InboxArchiveStatus; ref?: string }

/** One RFC 5322 msg-id: angle brackets, no whitespace (so no CR/LF), within the 998-char line limit. */
const RFC_MESSAGE_ID = /^<[^<>\s]+>$/;

/**
 * Archive (drop INBOX from) every message in `account` whose RFC Message-ID is
 * `rfcMessageId` (EXP-5030). Expected outcomes return a status, never throw.
 * Ships disabled: `INBOX_ARCHIVE_ACCOUNTS` (comma-separated labels/addresses)
 * must name the account. The write goes through the one mutate path, and the
 * Worker's `buildSource` refuses it unless the grant carries gmail.modify.
 */
export async function archiveInboxMessage(env: Env, input: unknown, fetchImpl: typeof fetch = fetch): Promise<InboxArchiveResult> {
  const allowed = new Set((env.INBOX_ARCHIVE_ACCOUNTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) return { status: 'disabled' };
  const { account, rfcMessageId } = (input ?? {}) as { account?: unknown; rfcMessageId?: unknown };
  if (typeof account !== 'string' || !account.trim() || typeof rfcMessageId !== 'string'
    || rfcMessageId.length > 998 || !RFC_MESSAGE_ID.test(rfcMessageId)) return { status: 'invalid' };

  const ctx = await buildWorkerToolContext(env, fetchImpl); // also runs migrations
  const driver = new D1Driver(env.DB);
  const wanted = account.trim().toLowerCase();
  const rows = await driver.prepare('SELECT account,address FROM google_tokens').all() as { account: string; address: string | null }[];
  const row = rows.find((r) => r.account.toLowerCase() === wanted) ?? rows.find((r) => r.address?.toLowerCase() === wanted);
  if (!row || !(allowed.has(row.account.toLowerCase()) || (row.address && allowed.has(row.address.toLowerCase())))) return { status: 'account_not_allowed' };
  const label = row.account;
  const source = ctx.buildSource!(ctx.config.accounts[label]!);

  // Index first; sync lags up to an hour, so fall back to a Gmail search.
  const indexed = await driver.prepare('SELECT gmail_message_id AS id, labels_json FROM messages WHERE account=? AND rfc_message_id=?')
    .all(label, rfcMessageId) as { id: string; labels_json: string | null }[];
  const matches = indexed.length
    ? indexed.map((m) => ({ id: m.id, labels: JSON.parse(m.labels_json ?? '[]') as string[] }))
    : await searchProvider(source, rfcMessageId);
  if (matches.length === 0) return { status: 'not_found' };

  const ref = (id: string) => `${label}:${id}`;
  const inbox = matches.filter((m) => m.labels.includes('INBOX'));
  if (inbox.length === 0) return { status: 'already_archived', ref: ref(matches[0]!.id) };
  try {
    for (const m of inbox) await applyLabelChange({ account: label, id: m.id, source, repo: ctx.repo, change: archiveChange() });
  } catch (error) {
    if (error instanceof InsufficientScopeError) return { status: 'insufficient_scope' };
    throw error;
  }
  return { status: 'archived', ref: ref(inbox[0]!.id) };
}

async function searchProvider(source: MailSource, rfcMessageId: string) {
  const ids: string[] = [];
  // ponytail: first 10 hits; one Message-ID never legitimately has more copies than that.
  for await (const id of source.listIds({ query: `rfc822msgid:${rfcMessageId.slice(1, -1)}`, limit: 10 })) ids.push(id);
  if (ids.length === 0) return [];
  return (await source.getMetadata(ids)).map((m) => ({ id: m.id, labels: m.labels }));
}
