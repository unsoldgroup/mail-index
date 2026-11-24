/**
 * JMAP MailSource adapter (RFC 8620 core + RFC 8621 mail), read-only.
 *
 * Talks plain JSON over `fetch`, so it runs inside the Worker where IMAP + MIME
 * parsing would not. Built for Stalwart, but nothing here is Stalwart-specific.
 * Auth is HTTP Basic (a per-mailbox app password). The single network seam is
 * the injected `fetchImpl`, which the contract test replaces with fixtures.
 */
import type { MailScope, MailSource, MessageFull, MessageMetadata, SourceIdentity } from '../../index.js';
import { createJmapRunner, JmapError, type JmapRunner } from './runner.js';

const MAIL = 'urn:ietf:params:jmap:mail';
const USING = ['urn:ietf:params:jmap:core', MAIL];
/** Mailbox role → the Gmail-style label the classifier already understands. */
const ROLE_LABELS: Record<string, string> = { inbox: 'INBOX', sent: 'SENT', junk: 'SPAM', trash: 'TRASH', drafts: 'DRAFT' };
const METADATA_PROPERTIES = ['id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'size', 'preview', 'subject', 'from', 'to', 'cc', 'replyTo', 'messageId', 'headers'];
const GET_BATCH = 100;

export interface JmapCredentials { username: string; password: string }

export interface JmapAdapterOptions {
  fetchImpl: typeof fetch;
  /** The session resource, e.g. `https://mail.example.com/.well-known/jmap`. */
  sessionUrl: string;
  /** Resolved lazily so callers can keep the password encrypted until a request. */
  credentials: () => Promise<JmapCredentials>;
  pageSize?: number;
  /** Called when the server answers 401, e.g. to record the Account as needing a new password. */
  onUnauthorized?: () => Promise<void>;
}

interface JmapAddress { name?: string | null; email?: string | null }
interface JmapPart { partId?: string; type?: string }
export interface JmapEmail {
  id: string; threadId?: string | null; mailboxIds?: Record<string, boolean>; keywords?: Record<string, boolean>;
  receivedAt?: string | null; size?: number | null; preview?: string | null; subject?: string | null;
  from?: JmapAddress[] | null; to?: JmapAddress[] | null; cc?: JmapAddress[] | null; replyTo?: JmapAddress[] | null;
  messageId?: string[] | null; headers?: { name: string; value: string }[];
  bodyValues?: Record<string, { value: string }>; textBody?: JmapPart[]; htmlBody?: JmapPart[];
}
interface Session { apiUrl: string; accountId: string; address: string | null }

function addresses(list: JmapAddress[] | null | undefined): string | null {
  if (!list?.length) return null;
  return list.map((a) => (a.name ? `${/[",;<>@]/.test(a.name) ? JSON.stringify(a.name) : a.name} <${a.email ?? ''}>` : (a.email ?? ''))).join(', ');
}

/** `30d` / `2w` / `1mo` / `1y` or an ISO date → JMAP UTCDate (no fractional seconds). */
export function jmapDate(token: string, now = Date.now()): string {
  const rel = /^(\d+)\s*(d|w|mo|m|y)$/i.exec(token.trim());
  const days = rel ? Number(rel[1]) * ({ d: 1, w: 7, m: 30, mo: 30, y: 365 } as Record<string, number>)[rel[2]!.toLowerCase()]! : null;
  const ms = days !== null ? now - days * 86_400_000 : Date.parse(token);
  if (Number.isNaN(ms)) throw new Error(`unparseable date bound: ${token}`);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export class JmapAdapter implements MailSource {
  readonly provider = 'jmap';
  readonly #run: JmapRunner;
  readonly #sessionUrl: string;
  readonly #pageSize: number;
  #session?: Promise<Session>;
  #labels?: Promise<Map<string, string>>;

  constructor(options: JmapAdapterOptions) {
    const authorization = async () => {
      const { username, password } = await options.credentials();
      return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    };
    this.#run = createJmapRunner(options.fetchImpl, authorization, options.onUnauthorized);
    this.#sessionUrl = options.sessionUrl;
    this.#pageSize = options.pageSize ?? 100;
  }

  #sessionInfo(): Promise<Session> {
    this.#session ??= (async () => {
      const session = (await this.#run(this.#sessionUrl)) as { apiUrl?: string; username?: string; primaryAccounts?: Record<string, string>; accounts?: Record<string, { name?: string }> };
      const accountId = session.primaryAccounts?.[MAIL];
      if (!session.apiUrl || !accountId) throw new JmapError('session exposes no mail account');
      const name = session.accounts?.[accountId]?.name;
      const address = [name, session.username].find((v) => v?.includes('@')) ?? name ?? session.username ?? null;
      return { apiUrl: new URL(session.apiUrl, this.#sessionUrl).toString(), accountId, address };
    })().catch((error: unknown) => { this.#session = undefined; throw error; });
    return this.#session;
  }

  /** One method call (the runner refuses anything but `/get` and `/query`). */
  async #call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const { apiUrl, accountId } = await this.#sessionInfo();
    const payload = (await this.#run(apiUrl, { using: USING, methodCalls: [[method, { accountId, ...args }, '0']] })) as { methodResponses?: [string, Record<string, unknown>, string][] };
    const [name, result] = payload.methodResponses?.[0] ?? [];
    if (!name || name === 'error') throw new JmapError(`${method}: ${String(result?.['type'] ?? 'no response')}`);
    return result as T;
  }

  /** mailboxId → label, for role mailboxes only. Fetched once per adapter. */
  #mailboxLabels(): Promise<Map<string, string>> {
    this.#labels ??= this.#call<{ list?: { id: string; role?: string | null }[] }>('Mailbox/get', { ids: null, properties: ['id', 'role'] })
      .then((r) => new Map((r.list ?? []).flatMap((m) => (m.role && ROLE_LABELS[m.role] ? [[m.id, ROLE_LABELS[m.role]!] as const] : []))))
      .catch((error: unknown) => { this.#labels = undefined; throw error; });
    return this.#labels;
  }

  async check(): Promise<SourceIdentity> {
    try {
      const session = await this.#sessionInfo();
      return { ok: true, address: session.address };
    } catch (error) {
      return { ok: false, address: null, reason: (error as Error).message };
    }
  }

  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    const filter: Record<string, unknown> = {};
    if (scope.query) filter['text'] = scope.query;
    if (scope.since) filter['after'] = jmapDate(scope.since);
    if (scope.until) filter['before'] = jmapDate(scope.until);
    if (scope.includeSent === false) {
      const sent = [...(await this.#mailboxLabels())].filter(([, label]) => label === 'SENT').map(([id]) => id);
      if (sent.length) filter['inMailboxOtherThan'] = sent;
    }
    let emitted = 0;
    let position = 0;
    for (;;) {
      const limit = scope.limit === undefined ? this.#pageSize : Math.min(this.#pageSize, scope.limit - emitted);
      if (limit <= 0) return;
      const page = await this.#call<{ ids?: string[]; limit?: number }>('Email/query', {
        ...(Object.keys(filter).length ? { filter } : {}),
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: false,
        position,
        limit,
      });
      const ids = page.ids ?? [];
      for (const id of ids) { emitted += 1; yield id; }
      position += ids.length;
      if (ids.length === 0 || ids.length < (page.limit ?? limit)) return;
    }
  }

  async #get(ids: readonly string[], extra: Record<string, unknown> = {}, properties = METADATA_PROPERTIES): Promise<JmapEmail[]> {
    const list: JmapEmail[] = [];
    for (let i = 0; i < ids.length; i += GET_BATCH) {
      const result = await this.#call<{ list?: JmapEmail[] }>('Email/get', { ids: ids.slice(i, i + GET_BATCH), properties, ...extra });
      list.push(...(result.list ?? []));
    }
    return list;
  }

  #toMetadata(email: JmapEmail, roles: Map<string, string>): MessageMetadata {
    const headers: Record<string, string> = {};
    for (const h of email.headers ?? []) headers[h.name] ??= h.value.trim();
    const header = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
    const labels = Object.keys(email.mailboxIds ?? {}).flatMap((id) => roles.get(id) ?? []);
    if (!email.keywords?.['$seen']) labels.push('UNREAD');
    const received = email.receivedAt ? Date.parse(email.receivedAt) : NaN;
    return {
      id: email.id,
      messageId: email.messageId?.[0] ? `<${email.messageId[0]}>` : null,
      threadId: email.threadId ?? null,
      internalDate: Number.isNaN(received) ? null : received,
      dateHeader: header('Date'),
      from: addresses(email.from),
      to: addresses(email.to),
      cc: addresses(email.cc),
      replyTo: addresses(email.replyTo),
      originFrom: header('X-Original-From'),
      subject: email.subject ?? null,
      labels: [...new Set(labels)],
      snippet: email.preview ?? null,
      sizeEstimate: email.size ?? null,
      headers,
    };
  }

  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    if (ids.length === 0) return [];
    const [emails, roles] = await Promise.all([this.#get(ids), this.#mailboxLabels()]);
    const byId = new Map(emails.map((e) => [e.id, e]));
    return ids.flatMap((id) => { const email = byId.get(id); return email ? [this.#toMetadata(email, roles)] : []; });
  }

  async getFull(id: string): Promise<MessageFull | null> {
    const [[email], roles] = await Promise.all([
      this.#get([id], { fetchTextBodyValues: true, fetchHTMLBodyValues: true }, [...METADATA_PROPERTIES, 'bodyValues', 'textBody', 'htmlBody']),
      this.#mailboxLabels(),
    ]);
    if (!email) return null;
    const body = (parts: JmapPart[] | undefined, type: string) =>
      (parts ?? []).filter((p) => p.type === type && p.partId).map((p) => email.bodyValues?.[p.partId!]?.value ?? '').join('\n') || null;
    const bodyText = body(email.textBody, 'text/plain');
    const bodyHtml = body(email.htmlBody, 'text/html');
    return { ...this.#toMetadata(email, roles), bodyText, bodyHtml, mimeType: bodyText !== null ? 'text/plain' : bodyHtml !== null ? 'text/html' : null };
  }
}

export { JmapError, createJmapRunner } from './runner.js';
export type { JmapRunner } from './runner.js';
