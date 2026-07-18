/**
 * gws adapter tests (SCOPE 0.4). Runs the reusable MailSource contract suite
 * against the real GwsAdapter, driven by a fixture-backed runner that replays
 * recorded gws JSON — exercising the adapter's argument building, pagination,
 * format=metadata|full parsing, and base64url body decoding with NO child
 * process and NO live network (PLAN §19). Tests import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runMailSourceContract } from '../dist/source/contract.js';
import { GwsAdapter } from '../dist/source/adapters/gws/index.js';
import { InsufficientScopeError } from '../dist/source/index.js';
import {
  GWS_CONTRACT_FIXTURES,
  makeGwsFixtureRunner,
} from '../dist/source/adapters/gws/fixtures.js';

const makeAdapter = () =>
  new GwsAdapter({
    configDir: '/tmp/gws-fixture-config',
    runner: makeGwsFixtureRunner(),
    // Small page size so pagination across multiple pages is exercised.
    pageSize: 2,
  });

// The full contract suite, run against the real adapter over recorded fixtures.
runMailSourceContract(test, makeAdapter, GWS_CONTRACT_FIXTURES);

test('GwsAdapter exposes the gws provider id', async () => {
  assert.equal(makeAdapter().provider, 'gws');
});

test('GwsAdapter rejects an empty configDir', async () => {
  assert.throws(() => new GwsAdapter({ configDir: '', runner: makeGwsFixtureRunner() }));
});

test('GwsAdapter decodes a base64url plain-text body via getFull', async () => {
  const full = await makeAdapter().getFull('fixt-direct-1');
  assert.ok(full);
  assert.match(full.bodyText ?? '', /deposit is due Friday/);
  assert.equal(full.bodyHtml, null);
  assert.equal(full.mimeType, 'text/plain');
});

test('GwsAdapter extracts a nested text/html part from a multipart payload', async () => {
  const full = await makeAdapter().getFull('fixt-list-1');
  assert.ok(full);
  assert.match(full.bodyHtml ?? '', /polar logistics/);
  assert.equal(full.mimeType, 'text/html');
});

test('GwsAdapter maps headers + internalDate + labels in metadata', async () => {
  const [meta] = await makeAdapter().getMetadata(['fixt-direct-1']);
  assert.ok(meta);
  assert.equal(meta.from, 'Jordan Partner <jordan@partner.example.com>');
  assert.equal(meta.subject, 'Re: Deposit terms for the Antarctica charter');
  assert.equal(meta.internalDate, 1_717_000_000_000);
  assert.deepEqual(meta.labels, ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL']);
  // §8: List-* headers survive plain format=metadata (no metadataHeaders).
  const [list] = await makeAdapter().getMetadata(['fixt-list-1']);
  assert.ok(list);
});

test('GwsAdapter paginates listIds across pages (pageSize < total)', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds()) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1', 'fixt-list-1', 'fixt-sent-1']);
});

test('GwsAdapter honours the limit scope (stops before exhausting pages)', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds({ limit: 1 })) ids.push(id);
  assert.deepEqual(ids, ['fixt-direct-1']);
});

test('GwsAdapter excludes Sent via -in:sent when includeSent is false', async () => {
  const ids: string[] = [];
  for await (const id of makeAdapter().listIds({ includeSent: false })) ids.push(id);
  assert.ok(!ids.includes('fixt-sent-1'));
  assert.ok(ids.includes('fixt-direct-1'));
});

test('GwsAdapter check() reports the authenticated address', async () => {
  const identity = await makeAdapter().check();
  assert.equal(identity.ok, true);
  assert.equal(identity.address, 'al@example.com');
});

test('GwsAdapter.modify builds the messages modify params (add + remove)', async () => {
  let captured: readonly string[] = [];
  const adapter = new GwsAdapter({
    configDir: '/tmp/x',
    runner: (args) => {
      captured = args;
      return Promise.resolve({});
    },
  });
  await adapter.modify('msg-1', { addLabelIds: ['STARRED'], removeLabelIds: ['INBOX'] });
  assert.deepEqual(captured.slice(0, 4), ['gmail', 'users', 'messages', 'modify']);
  // Path params in --params; label arrays in the request BODY via --json (gws
  // mis-encodes label arrays passed through --params).
  assert.equal(captured[4], '--params');
  assert.deepEqual(JSON.parse(captured[5]), { userId: 'me', id: 'msg-1' });
  assert.equal(captured[6], '--json');
  assert.deepEqual(JSON.parse(captured[7]), {
    addLabelIds: ['STARRED'],
    removeLabelIds: ['INBOX'],
  });
});

test('GwsAdapter.modify is a no-op (no spawn) when nothing to add or remove', async () => {
  let called = false;
  const adapter = new GwsAdapter({
    configDir: '/tmp/x',
    runner: () => {
      called = true;
      return Promise.resolve({});
    },
  });
  await adapter.modify('msg-1', { addLabelIds: [], removeLabelIds: [''] });
  assert.equal(called, false);
});

test('GwsAdapter.listLabels parses the labels resource into id/name/type', async () => {
  let captured: readonly string[] = [];
  const adapter = new GwsAdapter({
    configDir: '/tmp/x',
    runner: (args) => {
      captured = args;
      return Promise.resolve({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'Label_7', name: 'Coverage Review', type: 'user' },
          { id: 'bad' }, // missing name → dropped
        ],
      });
    },
  });
  const labels = await adapter.listLabels();
  assert.deepEqual(captured, ['gmail', 'users', 'labels', 'list', '--params', '{"userId":"me"}']);
  assert.deepEqual(labels, [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'Label_7', name: 'Coverage Review', type: 'user' },
  ]);
});

test('GwsAdapter.modify maps an insufficient-scope failure to InsufficientScopeError', async () => {
  const adapter = new GwsAdapter({
    configDir: '/tmp/x',
    runner: () => Promise.reject(new Error('403 PERMISSION_DENIED: insufficient scopes')),
  });
  await assert.rejects(
    () => adapter.modify('msg-1', { removeLabelIds: ['INBOX'] }),
    (err) => {
      assert.ok(err instanceof InsufficientScopeError);
      assert.equal(err.provider, 'gws');
      assert.match(err.remedy, /gws auth login/);
      return true;
    },
  );
});
