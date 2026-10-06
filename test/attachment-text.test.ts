/**
 * get_attachment_text: deterministic PDF text extraction (USG-222).
 *
 * Exercises the extraction path through the pure engine against a hand-built
 * text-layer PDF fixture and a fake MailSource — no transport, no provider, no
 * OCR/LLM (ADR-0004). Asserts: PDF text is extracted, non-PDF attachments are
 * ignored, and the top-level `text` concatenates the PDF text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { getAttachmentText } from '../dist/mcp/tools.js';

const ACCOUNT = 'acct';
const ME = 'al@example.com';
const NOW = new Date(Date.UTC(2026, 5, 15));

/** Build a minimal single-page text-layer PDF with a valid xref table. */
function buildTextPdf(message: string): Uint8Array {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = `BT /F1 24 Tf 40 120 Td (${message}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function freshRepo() {
  return new Repo(await openDb({ path: ':memory:' }));
}

async function seed(repo: Repo, id: string) {
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: id,
    threadId: null,
    internalDate: null,
    fromAddr: null,
    toAddr: null,
    ccAddr: null,
    subject: 'PDF carrier',
    direction: 'received',
    isList: false,
    category: null,
    unread: false,
    starred: false,
    important: false,
    snippet: null,
    bodyText: null,
    bodyState: 'meta',
  });
}

function ctxFor(repo: Repo, buildSource: unknown) {
  return {
    repo,
    config: { accounts: { [ACCOUNT]: { adapter: 'gws', configDir: '/tmp/x' } } },
    now: () => NOW,
    buildSource,
  } as never;
}

test('get_attachment_text extracts PDF text, ignores non-PDFs, concatenates', async () => {
  const repo = await freshRepo();
  await seed(repo, 'msg');

  const pdfBase64 = Buffer.from(buildTextPdf('Hello PDF world 42')).toString('base64');
  const calls: string[] = [];
  const source = {
    provider: 'fake',
    check: async () => ({ ok: true, address: ME }),
    async *listIds() {},
    async getMetadata() { return []; },
    async getFull() { return null; },
    async listAttachments(id: string) {
      calls.push(`list:${id}`);
      return [
        { id: 'att-pdf', filename: 'receipt.pdf', mimeType: 'application/pdf', size: null },
        { id: 'att-img', filename: 'logo.png', mimeType: 'image/png', size: 12 },
      ];
    },
    async getAttachment(messageId: string, attachmentId: string) {
      calls.push(`get:${attachmentId}`);
      if (attachmentId === 'att-pdf') return { data: pdfBase64, size: pdfBase64.length };
      throw new Error('should not fetch non-PDF bytes');
    },
  };

  const res = await getAttachmentText(ctxFor(repo, () => source), { ref: `${ACCOUNT}:msg` });

  // Only the PDF is fetched; the PNG is never downloaded.
  assert.deepEqual(calls, ['list:msg', 'get:att-pdf']);
  assert.equal(res.attachments.length, 1, 'only the PDF is returned');
  const only = res.attachments[0];
  assert.equal(only.filename, 'receipt.pdf');
  assert.equal(only.mimetype, 'application/pdf');
  assert.equal(only.hasText, true);
  assert.equal(only.text, 'Hello PDF world 42');
  // Convenience concatenation mirrors the per-attachment text.
  assert.equal(res.text, 'Hello PDF world 42');
  // Freshness stamp is present like every tool response.
  assert.ok('index_as_of' in res);
});

test('get_attachment_text returns empty text array when there are no PDFs', async () => {
  const repo = await freshRepo();
  await seed(repo, 'msg2');
  const source = {
    provider: 'fake',
    check: async () => ({ ok: true, address: ME }),
    async *listIds() {},
    async getMetadata() { return []; },
    async getFull() { return null; },
    async listAttachments() {
      return [{ id: 'att-img', filename: 'logo.png', mimeType: 'image/png', size: 12 }];
    },
    async getAttachment() { throw new Error('should not be called'); },
  };
  const res = await getAttachmentText(ctxFor(repo, () => source), { ref: `${ACCOUNT}:msg2` });
  assert.deepEqual(res.attachments, []);
  assert.equal(res.text, '');
});
