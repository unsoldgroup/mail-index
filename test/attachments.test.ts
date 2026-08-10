import assert from 'node:assert/strict';
import { test } from 'node:test';

import { storeMessageAttachments } from '../dist-worker/worker/attachments.js';

test('attachment storage writes safe R2 keys and emits CRM metadata', async () => {
  const puts: Array<{ key: string; bytes: ArrayBuffer }> = [];
  const events: Array<Record<string, unknown>> = [];
  const source = {
    getFull: async () => ({ attachments: [{ attachmentId: 'att-1', filename: 'quote final.pdf', mimeType: 'application/pdf', sizeBytes: 2, inline: false }] }),
    getAttachment: async () => Uint8Array.from([1, 2]).buffer,
  };
  const result = await storeMessageAttachments({
    source,
    feed: { append: async (event: Record<string, unknown>) => { events.push(event); return 'crm_v1_1'; } } as never,
    bucket: { put: async (key: string, bytes: ArrayBuffer) => { puts.push({ key, bytes }); } },
    account: 'unsold-group', messageIds: ['gmail-1'], jobId: 'job-1',
  });
  assert.equal(result.stored, 1);
  assert.match(puts[0]!.key, /quote_final\.pdf$/);
  assert.equal(puts[0]!.bytes.byteLength, 2);
  assert.equal((events[0]!.payload as { importStatus: string }).importStatus, 'stored');
});

test('attachment storage rejects oversized files without writing bytes', async () => {
  let writes = 0;
  const result = await storeMessageAttachments({
    source: { getFull: async () => ({ attachments: [{ attachmentId: 'att-1', filename: 'large.zip', mimeType: 'application/zip', sizeBytes: 26 * 1024 * 1024, inline: false }] }) },
    feed: { append: async () => 'crm_v1_1' } as never,
    bucket: { put: async () => { writes += 1; } },
    account: 'a', messageIds: ['m'], jobId: 'j',
  });
  assert.deepEqual(result, { stored: 0, skipped: 1, lastCursor: 'crm_v1_1' });
  assert.equal(writes, 0);
});
