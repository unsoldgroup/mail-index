import assert from 'node:assert/strict';
import test from 'node:test';

import { notifyCrmCompletion, signCrmWebhook } from '../dist-worker/worker/crm-webhook.js';

test('CRM completion webhook is timestamped and signed', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  };
  const payload = { account: 'unsold-group', terminalCursor: 'crm_v1_1', jobId: 'job-1' };

  await notifyCrmCompletion({
    url: 'https://twenty.example/hooks/mail-index', secret: 'secret', payload, fetchImpl: fetchImpl as typeof fetch, now: 1_700_000_000_000,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal((requests[0]?.init?.headers as Record<string, string>)['x-mail-index-timestamp'], '1700000000');
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)['x-mail-index-signature'],
    await signCrmWebhook('secret', '1700000000', JSON.stringify(payload)),
  );
});

test('CRM completion webhook is disabled when not configured', async () => {
  let called = false;
  await notifyCrmCompletion({ url: undefined, secret: undefined, payload: { account: 'a', terminalCursor: null, jobId: 'j' }, fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch });
  assert.equal(called, false);
});
