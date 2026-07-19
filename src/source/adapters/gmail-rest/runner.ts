/** The single audited network seam for the Gmail REST adapter. */

export class GmailRestError extends Error {
  override name = 'GmailRestError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Gmail REST ${status}: ${message}`);
  }
}

export interface GmailRestRequest {
  path: string;
  query?: Record<string, string | number | undefined>;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export type GmailRestRunner = (request: GmailRestRequest) => Promise<unknown>;

export function createGmailRestRunner(
  fetchImpl: typeof fetch,
  tokenProvider: () => Promise<string>,
): GmailRestRunner {
  return async ({ path, query = {}, method = 'GET', body }) => {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const token = await tokenProvider();
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) {
      throw new GmailRestError(response.status, payload.error?.message ?? response.statusText);
    }
    return payload;
  };
}
