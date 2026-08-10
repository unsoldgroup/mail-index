export async function signCrmWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `v1=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function notifyCrmCompletion(input: {
  url?: string;
  secret?: string;
  payload: { account: string; terminalCursor: string | null; jobId: string };
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<void> {
  if (!input.url || !input.secret) return;
  const body = JSON.stringify(input.payload);
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
  const response = await (input.fetchImpl ?? fetch)(input.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mail-index-timestamp': timestamp,
      'x-mail-index-signature': await signCrmWebhook(input.secret, timestamp, body),
    },
    body,
  });
  if (!response.ok) throw new Error(`CRM completion webhook failed (${response.status})`);
}
