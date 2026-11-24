/** The single audited network seam for the JMAP adapter. Read-only by construction. */

export class JmapError extends Error {
  override name = 'JmapError';
  constructor(message: string, readonly status?: number) { super(`JMAP${status ? ` ${status}` : ''}: ${message}`); }
}

/** GET (no body) or POST a JSON body; returns the parsed JSON or throws {@link JmapError}. */
export type JmapRunner = (url: string, body?: unknown) => Promise<unknown>;

export function createJmapRunner(fetchImpl: typeof fetch, authorization: () => Promise<string>, onUnauthorized?: () => Promise<void>): JmapRunner {
  return async (url, body) => {
    // Only reads: `/get` and `/query` method calls. JMAP writes are `/set`,
    // `/copy`, `/import` and EmailSubmission — none of them pass.
    const calls = (body as { methodCalls?: [string][] } | undefined)?.methodCalls ?? [];
    if (calls.some(([method]) => !/\/(get|query)$/.test(method))) throw new Error('mail-index JMAP adapter is read-only');
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: await authorization(), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) await onUnauthorized?.();
    if (!response.ok) throw new JmapError(response.statusText || 'request failed', response.status);
    return response.json();
  };
}
