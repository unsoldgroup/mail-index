/**
 * Classification tests (SCOPE 0.5, PLAN §8). Pure functions — no DB, no
 * network — so these are plain table-driven unit tests over label/header
 * combinations and the address-vs-label direction paths. Imports compiled
 * output (matching the other test files); `pnpm test` builds first via pretest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCategory,
  classifyIsList,
  classifyDirection,
  classifyMessage,
  extractAddress,
} from '../dist/ingest/classify.js';

// ---- category -----------------------------------------------------------

test('category: each CATEGORY_* label maps to its category', async () => {
  assert.equal(classifyCategory(['INBOX', 'CATEGORY_PROMOTIONS']), 'promotions');
  assert.equal(classifyCategory(['CATEGORY_SOCIAL']), 'social');
  assert.equal(classifyCategory(['INBOX', 'CATEGORY_UPDATES']), 'updates');
  assert.equal(classifyCategory(['CATEGORY_FORUMS']), 'forums');
  assert.equal(classifyCategory(['INBOX', 'CATEGORY_PERSONAL']), 'personal');
});

test('category: INBOX with no CATEGORY_* label is primary', async () => {
  assert.equal(classifyCategory(['INBOX', 'IMPORTANT']), 'primary');
});

test('category: no labels is null', async () => {
  assert.equal(classifyCategory([]), null);
});

test('category: archived non-inbox mail with no category label is null', async () => {
  assert.equal(classifyCategory(['UNREAD']), null);
});

test('category: Sent with no category label is null (not primary)', async () => {
  assert.equal(classifyCategory(['SENT']), null);
});

test('category: multiple CATEGORY_* labels resolve deterministically by precedence', async () => {
  // PERSONAL outranks PROMOTIONS in the precedence order regardless of input
  // order — defensive against Gmail (rarely) attaching more than one.
  assert.equal(classifyCategory(['CATEGORY_PROMOTIONS', 'CATEGORY_PERSONAL']), 'personal');
  assert.equal(classifyCategory(['CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS']), 'personal');
  assert.equal(classifyCategory(['CATEGORY_FORUMS', 'CATEGORY_SOCIAL']), 'social');
});

// ---- is_list ------------------------------------------------------------

test('is_list: List-Id header present', async () => {
  assert.equal(classifyIsList({ 'List-Id': '<news.example.org>' }), true);
});

test('is_list: List-Unsubscribe present without List-Id', async () => {
  assert.equal(
    classifyIsList({ 'List-Unsubscribe': '<https://example.org/u>' }),
    true,
  );
});

test('is_list: both present', async () => {
  assert.equal(
    classifyIsList({ 'List-Id': '<x>', 'List-Unsubscribe': '<y>' }),
    true,
  );
});

test('is_list: neither present', async () => {
  assert.equal(classifyIsList({ From: 'a@b.com', Subject: 'hi' }), false);
});

test('is_list: no headers at all is false', async () => {
  assert.equal(classifyIsList(undefined), false);
  assert.equal(classifyIsList({}), false);
});

test('is_list: header lookup is case-insensitive (§8 — never assume absence)', async () => {
  assert.equal(classifyIsList({ 'list-id': '<x>' }), true);
  assert.equal(classifyIsList({ 'LIST-UNSUBSCRIBE': '<y>' }), true);
});

test('is_list: null/undefined header value counts as not present', async () => {
  assert.equal(classifyIsList({ 'List-Id': null }), false);
  assert.equal(classifyIsList({ 'List-Id': undefined }), false);
});

test('is_list: empty-string header value still counts as present', async () => {
  // An adapter that surfaces the header at all means the message carries it.
  assert.equal(classifyIsList({ 'List-Id': '' }), true);
});

// ---- direction ----------------------------------------------------------

test('direction: SENT label is sent', async () => {
  assert.equal(classifyDirection(['SENT', 'CATEGORY_PERSONAL']), 'sent');
});

test('direction: no SENT label is received by default', async () => {
  assert.equal(classifyDirection(['INBOX'], 'jordan@partner.example.com'), 'received');
});

test('direction: from a known account address is sent even without SENT label', async () => {
  assert.equal(
    classifyDirection(['INBOX'], 'Al Operator <al@example.com>', ['al@example.com']),
    'sent',
  );
});

test('direction: known-address match is case-insensitive', async () => {
  assert.equal(
    classifyDirection([], 'AL@EXAMPLE.COM', ['al@example.com']),
    'sent',
  );
  assert.equal(
    classifyDirection([], 'al@example.com', ['AL@EXAMPLE.COM']),
    'sent',
  );
});

test('direction: from an unknown address with no SENT label is received', async () => {
  assert.equal(
    classifyDirection(['INBOX'], 'someone@elsewhere.com', ['al@example.com']),
    'received',
  );
});

test('direction: SENT label wins even if from is not a known address', async () => {
  assert.equal(classifyDirection(['SENT'], 'delegate@example.com', []), 'sent');
});

test('direction: empty knownAddresses and no SENT label is received', async () => {
  assert.equal(classifyDirection(['INBOX'], 'al@example.com'), 'received');
});

// ---- extractAddress -----------------------------------------------------

test('extractAddress: pulls address out of display-name form, lowercased', async () => {
  assert.equal(extractAddress('Al Operator <Al@Example.com>'), 'al@example.com');
});

test('extractAddress: bare address passes through', async () => {
  assert.equal(extractAddress('jordan@partner.example.com'), 'jordan@partner.example.com');
});

test('extractAddress: null/empty/no-address yields null', async () => {
  assert.equal(extractAddress(null), null);
  assert.equal(extractAddress(''), null);
  assert.equal(extractAddress('No address here'), null);
});

// ---- classifyMessage (combined) -----------------------------------------

test('classifyMessage: a list/newsletter message', async () => {
  const result = classifyMessage({
    labels: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
    headers: { 'List-Id': '<news.bulletin.example.org>' },
    from: 'Expedition Weekly <news@bulletin.example.org>',
    knownAddresses: ['al@example.com'],
  });
  assert.deepEqual(result, { category: 'updates', isList: true, direction: 'received' });
});

test('classifyMessage: a direct received message', async () => {
  const result = classifyMessage({
    labels: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'],
    headers: { From: 'jordan@partner.example.com' },
    from: 'Jordan Partner <jordan@partner.example.com>',
    knownAddresses: ['al@example.com'],
  });
  assert.deepEqual(result, { category: 'personal', isList: false, direction: 'received' });
});

test('classifyMessage: a sent message (by label)', async () => {
  const result = classifyMessage({
    labels: ['SENT', 'CATEGORY_PERSONAL'],
    from: 'Al Operator <al@example.com>',
    knownAddresses: ['al@example.com'],
  });
  assert.deepEqual(result, { category: 'personal', isList: false, direction: 'sent' });
});

test('classifyMessage: minimal input (labels only) does not throw', async () => {
  const result = classifyMessage({ labels: [] });
  assert.deepEqual(result, { category: null, isList: false, direction: 'received' });
});
