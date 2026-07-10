/**
 * Direct Gmail REST `MailSource` adapter for the Worker (adapter #3).
 *
 * The local adapters (gws, gog) shell out to CLIs — impossible in a Worker —
 * so this one calls the Gmail REST API with `fetch`, authenticated by
 * {@link GoogleAuth} (refresh token in KV → access token). The Gmail-JSON →
 * neutral-record translation is the same `gmail-shared` code the local
 * adapters use; nothing Gmail-shaped leaks above this file (PLAN §4).
 *
 * Method → endpoint mapping:
 *  - {@link GmailRestSource.check}       `GET users/me/profile`
 *  - {@link GmailRestSource.listIds}     `GET users/me/messages?q=…` (paged)
 *  - {@link GmailRestSource.listPage}    same endpoint, one page (NON-interface;
 *                                        the resumable backfill drives it)
 *  - {@link GmailRestSource.getMetadata} `GET users/me/messages/{id}?format=metadata`
 *  - {@link GmailRestSource.getFull}     `GET users/me/messages/{id}?format=full`
 *  - {@link GmailRestSource.listLabels}  `GET users/me/labels`
 *
 * No `modify` — this deployment is granted `gmail.readonly` only, so the
 * adapter simply omits the opt-in write seam (callers feature-detect).
 *
 * §8 pitfall: metadata is fetched with plain `format=metadata` and NO
 * `metadataHeaders` projection, so the complete header bag (every `List-*`
 * header `is_list` classification needs) survives.
 *
 * Retry policy (per request):
 *  - 401 → force a token re-mint and retry once; a second 401 is a broken
 *    grant → {@link GmailAuthError}.
 *  - 429/5xx → wait `Retry-After` (else 2s) plus jitter, retry once, then
 *    throw a plain Error — callers treat a failed slice as resumable.
 */

import type {
  MailScope,
  MailSource,
  MessageFull,
  MessageMetadata,
  ProviderLabel,
  SourceIdentity,
} from '../../src/source/index.js';
import {
  type GmailMessage,
  buildGmailQuery,
  extractBodies,
  parseLabelList,
  toMetadata,
} from '../../src/source/adapters/gmail-shared.js';
import { GmailAuthError, type GoogleAuth } from './google-auth.js';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/';

/** Base backoff when a 429/5xx response carries no Retry-After header. */
const DEFAULT_BACKOFF_MS = 2_000;
/** Upper bound on the random jitter added to the backoff. */
const JITTER_MS = 250;

/**
 * A non-OK Gmail response that survived the retry policy. Carries the HTTP
 * status so callers can distinguish "id gone" (404) from real failures.
 */
export class GmailHttpError extends Error {
  override name = 'GmailHttpError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Construction options for {@link GmailRestSource}. */
export interface GmailRestSourceOptions {
  /** Access-token minting seam (refresh token in KV → bearer token). */
  auth: GoogleAuth;
  /** The mailbox this deployment expects; {@link GmailRestSource.check} verifies it. */
  email: string;
  /** Fetch seam for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Max in-flight `messages.get` calls in {@link GmailRestSource.getMetadata}. Default 12. */
  concurrency?: number;
  /** Page size for {@link GmailRestSource.listIds} / {@link GmailRestSource.listPage}. Default 500. */
  pageSize?: number;
  /** Sleep seam for the backoff retry, injectable so tests don't wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Gmail `users.messages.list` response (the fields we read). */
interface GmailListResponse {
  messages?: { id?: string; threadId?: string }[];
  nextPageToken?: string;
}

/** One id page from {@link GmailRestSource.listPage}. */
export interface GmailIdPage {
  ids: string[];
  /** Present when another page follows; feed back in to resume. */
  nextPageToken?: string;
}

export class GmailRestSource implements MailSource {
  readonly provider = 'gmail-rest';

  readonly #auth: GoogleAuth;
  readonly #email: string;
  readonly #fetch: typeof fetch;
  readonly #concurrency: number;
  readonly #pageSize: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GmailRestSourceOptions) {
    if (!options.email || options.email.trim() === '') {
      throw new Error('GmailRestSource requires a non-empty mailbox email');
    }
    this.#auth = options.auth;
    this.#email = options.email.trim();
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#concurrency = options.concurrency ?? 12;
    this.#pageSize = options.pageSize ?? 500;
    this.#sleep = options.sleepImpl ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  /** One authenticated GET; `forceMint` drops the cached access token first. */
  async #send(url: string, forceMint: boolean): Promise<Response> {
    const token = await this.#auth.getAccessToken(forceMint);
    return this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });
  }

  /** Authenticated GET with the 401-once and 429/5xx-once retry policy. */
  async #api<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const href = url.toString();

    let res = await this.#send(href, false);

    if (res.status === 401) {
      // The cached token may have been revoked server-side: re-mint and retry
      // once. A second 401 means the grant itself is broken.
      res = await this.#send(href, true);
      if (res.status === 401) {
        throw new GmailAuthError(
          'Gmail rejected the access token even after a refresh — re-connect this MCP server ' +
            'from Claude to re-consent.',
        );
      }
    }

    if (res.status === 429 || res.status >= 500) {
      await this.#sleep(retryDelayMs(res));
      res = await this.#send(href, false);
      if (res.status === 429 || res.status >= 500) {
        // Callers treat a failed slice as resumable; keep the error clean.
        throw new Error(`Gmail request failed after one retry (HTTP ${res.status}): ${path}`);
      }
    }

    if (!res.ok) {
      throw new GmailHttpError(res.status, `Gmail request failed (HTTP ${res.status}): ${path}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Auth/identity probe. Never throws for ordinary auth failures — reports
   * `ok:false` with a reason instead (contract). Also verifies the profile is
   * the mailbox this deployment was configured for.
   */
  async check(): Promise<SourceIdentity> {
    try {
      const profile = await this.#api<{ emailAddress?: string }>('users/me/profile');
      const address = profile.emailAddress ?? null;
      if (address && address.toLowerCase() !== this.#email.toLowerCase()) {
        return {
          ok: false,
          address,
          reason: `Gmail is connected as ${address}, but this deployment expects ${this.#email}.`,
        };
      }
      return { ok: true, address: address ?? this.#email };
    } catch (err) {
      return { ok: false, address: null, reason: (err as Error).message };
    }
  }

  /**
   * Enumerate message ids in `scope`, newest-first (Gmail's natural list
   * order), paging lazily. The scope → `q=` translation is the shared
   * {@link buildGmailQuery}; an empty scope lists the whole mailbox (no `q`).
   */
  async *listIds(scope: MailScope = {}): AsyncIterable<string> {
    const q = buildGmailQuery(scope);
    const limit = scope.limit;
    let emitted = 0;
    let pageToken: string | undefined;

    do {
      const remaining = limit != null ? limit - emitted : undefined;
      if (remaining != null && remaining <= 0) return;
      const max = remaining != null ? Math.min(this.#pageSize, remaining) : this.#pageSize;

      const page = await this.listPage(q, pageToken, max);
      for (const id of page.ids) {
        if (limit != null && emitted >= limit) return;
        emitted += 1;
        yield id;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /**
   * NON-interface: fetch ONE page of message ids for `query`. The cron-driven
   * backfill persists `nextPageToken` between runs so a mailbox sweep survives
   * Worker time limits; `listIds` composes this internally.
   */
  async listPage(query: string, pageToken?: string, maxResults = 500): Promise<GmailIdPage> {
    const res = await this.#api<GmailListResponse>('users/me/messages', {
      q: query || undefined,
      maxResults: String(maxResults),
      pageToken,
    });
    const ids = (res.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    return res.nextPageToken ? { ids, nextPageToken: res.nextPageToken } : { ids };
  }

  /**
   * Fetch metadata records through a small concurrency pool (default 12 in
   * flight), preserving input order. §8: plain `format=metadata`, never a
   * `metadataHeaders` projection. Ids Gmail cannot return are omitted.
   */
  async getMetadata(ids: readonly string[]): Promise<MessageMetadata[]> {
    const results: (MessageMetadata | undefined)[] = new Array(ids.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= ids.length) return;
        const msg = await this.#getMessage(ids[i] as string, 'metadata');
        if (msg?.id) results[i] = toMetadata(msg);
      }
    };

    const width = Math.max(1, Math.min(this.#concurrency, ids.length));
    await Promise.all(Array.from({ length: width }, () => worker()));
    return results.filter((m): m is MessageMetadata => m !== undefined);
  }

  /** Fetch the full record (metadata + raw body) for one id, or null if gone. */
  async getFull(id: string): Promise<MessageFull | null> {
    const msg = await this.#getMessage(id, 'full');
    if (!msg?.id) return null;
    const { bodyText, bodyHtml, mimeType } = extractBodies(msg.payload);
    return { ...toMetadata(msg), bodyText, bodyHtml, mimeType };
  }

  /** List the mailbox label catalogue. */
  async listLabels(): Promise<ProviderLabel[]> {
    const res = await this.#api<{ labels?: { id?: string; name?: string; type?: string }[] }>(
      'users/me/labels',
    );
    return parseLabelList(res.labels);
  }

  /**
   * One `messages.get`. An id the provider cannot return (deleted: 404,
   * inaccessible: 403, malformed: 400) yields null so callers omit it per the
   * contract; anything else (post-retry 429/5xx, auth) propagates — the slice
   * is resumable.
   */
  async #getMessage(id: string, format: 'metadata' | 'full'): Promise<GmailMessage | null> {
    try {
      return await this.#api<GmailMessage>(`users/me/messages/${encodeURIComponent(id)}`, {
        format,
      });
    } catch (err) {
      if (err instanceof GmailHttpError && [400, 403, 404].includes(err.status)) return null;
      throw err;
    }
  }
}

/** Backoff for a 429/5xx: Retry-After seconds when present, else 2s; + jitter. */
function retryDelayMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header != null ? Number(header) : NaN;
  const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_BACKOFF_MS;
  return base + Math.floor(Math.random() * JITTER_MS);
}

export { GmailAuthError } from './google-auth.js';
