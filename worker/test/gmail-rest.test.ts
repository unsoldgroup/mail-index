// The project doesn't wire @cloudflare/vitest-pool-workers' ambient types into
// tsconfig `types`, so pull in its `cloudflare:test` declaration here.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * GmailRestSource + GoogleAuth over a stubbed fetch — no live network. The
 * stub serves canned Gmail REST JSON generated from the core contract fixtures
 * (DEFAULT_FIXTURES), so the reusable MailSource conformance suite
 * (src/source/contract.ts) runs unmodified over this adapter, plus direct
 * assertions for the REST-specific behaviours (paging, listPage, the 401 and
 * 429 retry policies, invalid_grant, not-connected).
 */
import { Buffer } from 'node:buffer';

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runMailSourceContract } from '../../src/source/contract.js';
import {
  DEFAULT_FIXTURES,
  DIRECT_MESSAGE,
  LIST_MESSAGE,
  SENT_MESSAGE,
} from '../../src/source/fixtures/index.js';
import type { MessageFull } from '../../src/source/index.js';
import { GMAIL_REFRESH_TOKEN_KEY, type Env } from '../src/env.js';
import { GmailRestSource } from '../src/gmail-rest.js';
import { GmailAuthError, GoogleAuth, NOT_CONNECTED_MESSAGE } from '../src/google-auth.js';

/* -------------------------------------------------------------------------- */
/* Canned Gmail JSON, generated from the provider-neutral contract fixtures.  */
/* -------------------------------------------------------------------------- */

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

function gmailHeaders(m: MessageFull): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const push = (name: string, value: string | null): void => {
    if (value != null) out.push({ name, value });
  };
  push('Date', m.dateHeader);
  push('From', m.from);
  push('To', m.to);
  push('Cc', m.cc);
  push('Subject', m.subject);
  for (const [name, value] of Object.entries(m.headers ?? {})) out.push({ name, value });
  return out;
}

/** A fixture as Gmail's `users.messages.get` would return it. */
function gmailMessage(m: MessageFull, format: 'metadata' | 'full'): unknown {
  const parts: unknown[] = [];
  if (format === 'full') {
    if (m.bodyText != null) parts.push({ mimeType: 'text/plain', body: { data: b64url(m.bodyText) } });
    if (m.bodyHtml != null) parts.push({ mimeType: 'text/html', body: { data: b64url(m.bodyHtml) } });
  }
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labels,
    snippet: m.snippet,
    internalDate: m.internalDate != null ? String(m.internalDate) : undefined,
    sizeEstimate: m.sizeEstimate,
    payload: { mimeType: 'multipart/alternative', headers: gmailHeaders(m), parts },
  };
}

const LABELS_FIXTURE = {
  labels: [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'Label_1', name: 'Trips', type: 'user' },
    { id: 'Label_broken' }, // no name → parseLabelList drops it
  ],
};

/* -------------------------------------------------------------------------- */
/* Fetch stub                                                                 */
/* -------------------------------------------------------------------------- */

interface RecordedCall {
  path: string;
  params: URLSearchParams;
  auth: string | null;
  body: string | null;
}

interface StubState {
  /** Answer this many Gmail API calls with 401 before behaving. */
  gmail401s: number;
  /** Answer this many Gmail API calls with 429 (Retry-After: 0) first. */
  gmail429s: number;
  /** Every Gmail API call fails with 500. */
  always500: boolean;
  /** Token endpoint answers 400 invalid_grant. */
  invalidGrant: boolean;
  /** Artificial per-messages.get delay, to observe pool concurrency. */
  getDelayMs: number;
}

function makeStub() {
  const state: StubState = {
    gmail401s: 0,
    gmail429s: 0,
    always500: false,
    invalidGrant: false,
    getDelayMs: 0,
  };
  const calls: RecordedCall[] = [];
  let tokenRequests = 0;
  let inflightGets = 0;
  let maxInflightGets = 0;

  const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers = new Headers(init?.headers);
    calls.push({
      path: url.pathname,
      params: url.searchParams,
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    });

    // --- OAuth token endpoint -------------------------------------------
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      tokenRequests += 1;
      if (state.invalidGrant) {
        return json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        );
      }
      return json({ access_token: `tok-${tokenRequests}`, expires_in: 3600, token_type: 'Bearer' });
    }

    // --- Gmail API --------------------------------------------------------
    if (url.hostname !== 'gmail.googleapis.com') return json({ error: 'unexpected host' }, 500);
    if (state.always500) return json({ error: { code: 500, message: 'backend error' } }, 500);
    if (state.gmail401s > 0) {
      state.gmail401s -= 1;
      return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401);
    }
    if (state.gmail429s > 0) {
      state.gmail429s -= 1;
      return json({ error: { code: 429, message: 'rate limited' } }, 429, { 'retry-after': '0' });
    }

    const path = url.pathname;
    if (path === '/gmail/v1/users/me/profile') {
      return json({ emailAddress: DEFAULT_FIXTURES.address, messagesTotal: 3 });
    }
    if (path === '/gmail/v1/users/me/labels') return json(LABELS_FIXTURE);
    if (path === '/gmail/v1/users/me/messages') {
      const pageToken = url.searchParams.get('pageToken');
      if (pageToken == null) {
        return json({
          messages: [
            { id: DIRECT_MESSAGE.id, threadId: DIRECT_MESSAGE.threadId },
            { id: LIST_MESSAGE.id, threadId: LIST_MESSAGE.threadId },
          ],
          nextPageToken: 'page-2',
          resultSizeEstimate: 3,
        });
      }
      if (pageToken === 'page-2') {
        return json({
          messages: [{ id: SENT_MESSAGE.id, threadId: SENT_MESSAGE.threadId }],
          resultSizeEstimate: 3,
        });
      }
      return json({ error: { code: 400, message: 'bad page token' } }, 400);
    }
    const get = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (get) {
      inflightGets += 1;
      maxInflightGets = Math.max(maxInflightGets, inflightGets);
      try {
        if (state.getDelayMs > 0) await new Promise((res) => setTimeout(res, state.getDelayMs));
        const id = decodeURIComponent(get[1] as string);
        const fixture = DEFAULT_FIXTURES.messages.find((m) => m.id === id);
        if (!fixture) return json({ error: { code: 404, message: 'Not Found' } }, 404);
        const format = url.searchParams.get('format') === 'full' ? 'full' : 'metadata';
        return json(gmailMessage(fixture, format));
      } finally {
        inflightGets -= 1;
      }
    }
    return json({ error: { code: 404, message: `unhandled path ${path}` } }, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    state,
    get tokenRequests() {
      return tokenRequests;
    },
    get maxInflightGets() {
      return maxInflightGets;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness helpers                                                            */
/* -------------------------------------------------------------------------- */

const memKv = (token: string | null) => ({
  get: async (key: string): Promise<string | null> =>
    key === GMAIL_REFRESH_TOKEN_KEY ? token : null,
});

function makeHarness(options?: { refreshToken?: string | null; concurrency?: number }) {
  const stub = makeStub();
  const sleeps: number[] = [];
  const auth = new GoogleAuth({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    kv: memKv(options?.refreshToken === undefined ? 'refresh-tok' : options.refreshToken),
    fetchImpl: stub.fetchImpl,
  });
  const source = new GmailRestSource({
    auth,
    email: DEFAULT_FIXTURES.address,
    fetchImpl: stub.fetchImpl,
    concurrency: options?.concurrency ?? 4,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { stub, auth, source, sleeps };
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const id of iter) out.push(id);
  return out;
}

/* -------------------------------------------------------------------------- */
/* The reusable MailSource conformance suite                                  */
/* -------------------------------------------------------------------------- */

describe('MailSource contract (GmailRestSource over stubbed fetch)', () => {
  runMailSourceContract(it, () => makeHarness().source, DEFAULT_FIXTURES);
});

/* -------------------------------------------------------------------------- */
/* REST-specific behaviour                                                    */
/* -------------------------------------------------------------------------- */

describe('GoogleAuth', () => {
  it('mints a token from the refresh token stored in real KV (OAUTH_KV)', async () => {
    const testEnv = env as unknown as Env;
    await testEnv.OAUTH_KV.put(GMAIL_REFRESH_TOKEN_KEY, 'kv-refresh-token');
    const stub = makeStub();
    const auth = new GoogleAuth({
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      kv: testEnv.OAUTH_KV,
      fetchImpl: stub.fetchImpl,
    });
    await expect(auth.getAccessToken()).resolves.toBe('tok-1');
    const tokenCall = stub.calls.find((c) => c.path === '/token');
    expect(tokenCall?.body).toContain('grant_type=refresh_token');
    expect(tokenCall?.body).toContain('refresh_token=kv-refresh-token');
  });

  it('caches the access token across calls (single mint)', async () => {
    const { stub, auth } = makeHarness();
    expect(await auth.getAccessToken()).toBe('tok-1');
    expect(await auth.getAccessToken()).toBe('tok-1');
    expect(stub.tokenRequests).toBe(1);
  });

  it('surfaces the not-connected error when KV holds no refresh token', async () => {
    const { auth, source } = makeHarness({ refreshToken: null });
    await expect(auth.getAccessToken()).rejects.toThrow(NOT_CONNECTED_MESSAGE);
    // check() reports it as ok:false rather than throwing (contract).
    const identity = await source.check();
    expect(identity.ok).toBe(false);
    expect(identity.address).toBeNull();
    expect(identity.reason).toContain('not connected yet');
  });

  it('surfaces GmailAuthError on invalid_grant', async () => {
    const { stub, auth, source } = makeHarness();
    stub.state.invalidGrant = true;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(GmailAuthError);
    await expect(auth.getAccessToken()).rejects.toThrow(/re-connect this MCP server from Claude/);
    const identity = await source.check();
    expect(identity.ok).toBe(false);
    expect(identity.reason).toMatch(/invalid_grant/);
  });
});

describe('GmailRestSource', () => {
  it('check() reports the profile address', async () => {
    const { source } = makeHarness();
    await expect(source.check()).resolves.toEqual({
      ok: true,
      address: DEFAULT_FIXTURES.address,
    });
  });

  it('listIds() joins pages and passes the shared-built query', async () => {
    const { stub, source } = makeHarness();
    const ids = await collect(source.listIds({ query: 'from:partner', includeSent: false }));
    expect(ids).toEqual([DIRECT_MESSAGE.id, LIST_MESSAGE.id, SENT_MESSAGE.id]);

    const listCalls = stub.calls.filter((c) => c.path === '/gmail/v1/users/me/messages');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.params.get('q')).toBe('from:partner -in:sent');
    expect(listCalls[0]?.params.get('maxResults')).toBe('500');
    expect(listCalls[0]?.params.get('pageToken')).toBeNull();
    expect(listCalls[1]?.params.get('pageToken')).toBe('page-2');
    expect(listCalls[0]?.auth).toBe('Bearer tok-1');
  });

  it('listPage() returns ids plus nextPageToken for the resumable backfill', async () => {
    const { source } = makeHarness();
    const page1 = await source.listPage('', undefined, 500);
    expect(page1.ids).toEqual([DIRECT_MESSAGE.id, LIST_MESSAGE.id]);
    expect(page1.nextPageToken).toBe('page-2');

    const page2 = await source.listPage('', page1.nextPageToken);
    expect(page2.ids).toEqual([SENT_MESSAGE.id]);
    expect(page2.nextPageToken).toBeUndefined();
  });

  it('getMetadata() maps headers via gmail-shared and never projects metadataHeaders', async () => {
    const { stub, source } = makeHarness();
    const metas = await source.getMetadata([DIRECT_MESSAGE.id, LIST_MESSAGE.id]);
    expect(metas.map((m) => m.id)).toEqual([DIRECT_MESSAGE.id, LIST_MESSAGE.id]);

    const direct = metas[0];
    expect(direct?.subject).toBe(DIRECT_MESSAGE.subject);
    expect(direct?.from).toBe(DIRECT_MESSAGE.from);
    expect(direct?.labels).toEqual(DIRECT_MESSAGE.labels);
    expect(direct?.internalDate).toBe(DIRECT_MESSAGE.internalDate);

    // §8: the complete header bag survives (List-* presence drives is_list).
    const list = metas[1];
    expect(list?.headers?.['List-Id']).toBe(LIST_MESSAGE.headers?.['List-Id']);
    expect(list?.headers?.['List-Unsubscribe']).toBe(LIST_MESSAGE.headers?.['List-Unsubscribe']);

    const getCalls = stub.calls.filter((c) => c.path.includes('/messages/'));
    expect(getCalls).toHaveLength(2);
    for (const call of getCalls) {
      expect(call.params.get('format')).toBe('metadata');
      expect(call.params.has('metadataHeaders')).toBe(false);
    }
  });

  it('getMetadata() bounds in-flight fetches to the injected pool width', async () => {
    const { stub, source } = makeHarness({ concurrency: 2 });
    stub.state.getDelayMs = 5;
    const metas = await source.getMetadata(DEFAULT_FIXTURES.messages.map((m) => m.id));
    expect(metas).toHaveLength(3);
    expect(stub.maxInflightGets).toBeGreaterThan(0);
    expect(stub.maxInflightGets).toBeLessThanOrEqual(2);
  });

  it('getFull() carries the decoded body', async () => {
    const { source } = makeHarness();
    const direct = await source.getFull(DIRECT_MESSAGE.id);
    expect(direct?.bodyText).toBe(DIRECT_MESSAGE.bodyText);
    expect(direct?.mimeType).toBe('text/plain');

    const list = await source.getFull(LIST_MESSAGE.id);
    expect(list?.bodyHtml).toBe(LIST_MESSAGE.bodyHtml);
    expect(list?.bodyText).toBeNull();
    expect(list?.mimeType).toBe('text/html');
  });

  it('listLabels() maps via gmail-shared label parsing (drops nameless entries)', async () => {
    const { source } = makeHarness();
    await expect(source.listLabels()).resolves.toEqual([
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_1', name: 'Trips', type: 'user' },
    ]);
  });

  it('retries a 401 once with a force-minted token, then succeeds', async () => {
    const { stub, source } = makeHarness();
    stub.state.gmail401s = 1;
    const identity = await source.check();
    expect(identity).toEqual({ ok: true, address: DEFAULT_FIXTURES.address });

    const profileCalls = stub.calls.filter((c) => c.path === '/gmail/v1/users/me/profile');
    expect(profileCalls.map((c) => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(stub.tokenRequests).toBe(2);
  });

  it('surfaces GmailAuthError when the 401 persists after a refresh', async () => {
    const { stub, source } = makeHarness();
    stub.state.gmail401s = 99;
    await expect(source.listPage('')).rejects.toBeInstanceOf(GmailAuthError);
  });

  it('retries a 429 once honouring Retry-After, then succeeds', async () => {
    const { stub, source, sleeps } = makeHarness();
    stub.state.gmail429s = 1;
    const page = await source.listPage('');
    expect(page.ids).toEqual([DIRECT_MESSAGE.id, LIST_MESSAGE.id]);
    expect(sleeps).toHaveLength(1);
    // Retry-After: 0 → jitter only (< 2s default backoff).
    expect(sleeps[0]).toBeLessThan(2000);
  });

  it('throws a clean (resumable) Error when 5xx persists after one retry', async () => {
    const { stub, source, sleeps } = makeHarness();
    stub.state.always500 = true;
    await expect(source.getFull(DIRECT_MESSAGE.id)).rejects.toThrow(/after one retry \(HTTP 500\)/);
    expect(sleeps).toHaveLength(1);
    // No Retry-After header → the 2s default (plus jitter).
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });
});
