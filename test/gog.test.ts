/**
 * gog adapter tests (adapter #2 — the public one-click-auth path). Runs the
 * reusable MailSource contract suite against the real GogAdapter, driven by a
 * fixture-backed runner that replays recorded gog JSON — exercising the
 * adapter's argument building, pagination, `gmail raw` parsing, and base64url
 * body decoding with NO child process and NO live network (PLAN §19). Tests
 * import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMailSourceContract } from '../dist/source/contract.js';
import { GogAdapter } from '../dist/source/adapters/gog/index.js';
import { InsufficientScopeError } from '../dist/source/index.js';
import {
  GOG_CONTRACT_FIXTURES,
  makeGogFixtureRunner,
} from '../dist/source/adapters/gog/fixtures.js';

const makeAdapter = () =>
  new GogAdapter({
    account: 'al@example.com',
    runner: makeGogFixtureRunner(),
    // Small page size so pagination across multiple pages is exercised.
    pageSize: 2,
  });

// The full contract suite, run against the real adapter over recorded fixtures.
runMailSourceContract(test, makeAdapter, GOG_CONTRACT_FIXTURES);

test('GogAdapter exposes the gog provider id', async () => {
  assert.equal(makeAdapter().provider, 'gog');
});

test('GogAdapter rejects an empty account', async () => {
  assert.throws(() => new GogAdapter({ account: '', runner: makeGogFixtureRunner() }));
});

test('GogAdapter decodes a base64url plain-text body via getFull', async () => {
  const full = await makeAdapter().getFull('fixt-direct-1');
  assert.ok(full);
  assert.match(full.bodyText ?? '', /deposit is due Friday/);
  assert.equal(full.bodyHtml, null);
  assert.equal(full.mimeType, 'text/plain');
});

test('GogAdapter extracts a nested text/html part from a multipart payload', async () => {
  const full = await makeAdapter().getFull('fixt-list-1');
  assert.ok(full);
  assert.match(full.bodyHtml ?? '', /polar logistics/);
  assert.equal(full.mimeType, 'text/html');
});

test('GogAdapter maps headers + internalDate + labels in metadata', async () => {
  const [meta] = await makeAdapter().getMetadata(['fixt-direct-1']);
  assert.ok(meta);
  assert.equal(meta.from, 'Jordan Partner <jordan@partner.example.com>');
  assert.equal(meta.subject, 'Re: Deposit terms for the Antarctica charter');
  assert.equal(meta.internalDate, 1_717_000_000_000);
  assert.deepEqual(meta.labels, ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL']);
  // §8: List-* headers survive `gmail raw` (no restricted projection).
  const [list] = await makeAdapter().getMetadata(['fixt-list-1']);
  assert.ok(list);
  assert.ok(list.headers);
  assert.ok('List-Id' in list.headers, 'List-Id header must survive');
});

test('GogAdapter paginates listIds across pages (pageSize < total)', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds()) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1']);
});

test('GogAdapter honours the limit scope (stops before exhausting pages)', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds({ limit: 1 })) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1']);
});

test('GogAdapter excludes Sent via -in:sent when includeSent is false', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds({ includeSent: false })) ids.push(id);
  assert.ok(!ids.includes('fixt-sent-1'));
  assert.ok(ids.includes('fixt-direct-1'));
});

test('GogAdapter check() reports the authenticated address', async () => {
  const identity = await makeAdapter().check();
  assert.equal(identity.ok, true);
  assert.equal(identity.address, 'al@example.com');
});

test('GogAdapter check() fails with a gog-auth hint for an unauthorized account', async () => {
  const adapter = new GogAdapter({ account: 'nobody@example.com', runner: makeGogFixtureRunner() });
  const identity = await adapter.check();
  assert.equal(identity.ok, false);
  assert.match(identity.reason ?? '', /gog auth add nobody@example\.com --gmail-scope=readonly/);
});

test('GogAdapter.modify builds the gmail messages modify argv (add + remove)', async () => {
  let captured: readonly string[] = [];
  const adapter = new GogAdapter({
    account: 'al@example.com',
    runner: (args) => {
      captured = args;
      return Promise.resolve({});
    },
  });
  await adapter.modify('msg-1', { addLabelIds: ['STARRED', 'Work'], removeLabelIds: ['INBOX'] });
  assert.deepEqual(captured, [
    'gmail', 'messages', 'modify', 'msg-1', '-a', 'al@example.com',
    '--add', 'STARRED,Work', '--remove', 'INBOX',
  ]);
});

test('GogAdapter.modify is a no-op (no spawn) when nothing to add or remove', async () => {
  let called = false;
  const adapter = new GogAdapter({
    account: 'al@example.com',
    runner: () => {
      called = true;
      return Promise.resolve({});
    },
  });
  await adapter.modify('msg-1', { addLabelIds: [''], removeLabelIds: [] });
  assert.equal(called, false, 'an empty change must not reach the provider');
});

test('GogAdapter.listLabels parses `gmail labels list` into id/name/type', async () => {
  let captured: readonly string[] = [];
  const adapter = new GogAdapter({
    account: 'al@example.com',
    runner: (args) => {
      captured = args;
      return Promise.resolve({
        labels: [
          { id: 'STARRED', name: 'STARRED', type: 'system' },
          { id: 'Label_7', name: 'Coverage Review', type: 'user' },
        ],
      });
    },
  });
  const labels = await adapter.listLabels();
  assert.deepEqual(captured, ['gmail', 'labels', 'list', '-a', 'al@example.com']);
  assert.equal(labels.find((l) => l.id === 'Label_7')?.name, 'Coverage Review');
});

test('GogAdapter.modify maps an insufficient-scope failure to InsufficientScopeError', async () => {
  const adapter = new GogAdapter({
    account: 'al@example.com',
    runner: () =>
      Promise.reject(new Error('gog exited 1: 403 Request had insufficient authentication scopes')),
  });
  await assert.rejects(
    () => adapter.modify('msg-1', { removeLabelIds: ['INBOX'] }),
    (err) => {
      assert.ok(err instanceof InsufficientScopeError);
      assert.match(err.message, /gmail\.modify/);
      assert.match(err.remedy, /gog auth add al@example\.com .*gmail\.modify/);
      return true;
    },
  );
});
