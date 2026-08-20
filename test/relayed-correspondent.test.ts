/**
 * Relayed-correspondent header capture (migration 20).
 *
 * A relay that sends *as* the operator puts the operator's own role address in
 * `From:`, which makes the thread look like the operator talking to itself. Two
 * different headers name the actual human, depending on how the relay works:
 *
 *  - contact-form notifications (`noreply@`) put the customer in `Reply-To:`;
 *  - `[FWD]` relays (`agents@`) set `Reply-To:` to an opaque per-thread alias
 *    inside the operator's own domain, and only `X-Original-From:` names them.
 *
 * These tests pin that both are extracted, persisted, survive an enrich-phase
 * re-upsert that carries no headers, and reach the CRM feed with a dedupe key
 * that lets a metadata-only re-sync republish once they arrive.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { D1Driver } from '../dist/index/drivers/d1.js';
import { runMigrations } from '../dist/index/migrations.js';
import { toMetadata } from '../dist/source/adapters/gmail-shared.js';
import { FakeMailSource } from '../dist/source/fake.js';
import { syncMetadata } from '../dist/ingest/sync.js';
import { CrmChangeFeed, publishMessageChanges } from '../dist-worker/worker/crm-feed.js';

const ACCOUNT = 'unsold-group';

/** A contact-form notification: the customer is in `Reply-To`. */
const CONTACT_FORM = {
  id: 'relay-contact-1',
  threadId: 'thread-relay-1',
  internalDate: 1_717_000_000_000,
  dateHeader: 'Wed, 29 May 2024 18:26:40 +0000',
  from: 'Expedition Insure <noreply@expedition.insure>',
  to: 'al@unsold.group',
  cc: null,
  replyTo: 'customer@yahoo.example',
  subject: '[Contact Form] Get a Quote - Robyn',
  labels: ['INBOX'],
  snippet: 'A new quote request came in.',
  sizeEstimate: 2048,
  bodyText: 'A new quote request came in.',
  bodyHtml: null,
  mimeType: 'text/plain',
};

/** A relayed forward: `Reply-To` is an in-domain alias, `X-Original-From` is not. */
const RELAYED_FORWARD = {
  id: 'relay-fwd-1',
  threadId: 'thread-relay-2',
  internalDate: 1_716_900_000_000,
  dateHeader: 'Tue, 28 May 2024 14:40:00 +0000',
  from: 'Expedition Insure <agents@expedition.insure>',
  to: 'al@unsold.group',
  cc: null,
  replyTo: 'reply+ps7fxf5k2cg3vnmssc3mvp4t9n8ctjy6@expedition.insure',
  originFrom: 'traveller@gmail.example',
  subject: '[FWD] Re: Quote request',
  labels: ['INBOX'],
  snippet: 'Forwarded from the relay.',
  sizeEstimate: 4096,
  bodyText: 'Forwarded from the relay.',
  bodyHtml: null,
  mimeType: 'text/plain',
};

test('toMetadata lifts Reply-To and X-Original-From off the Gmail payload', () => {
  const meta = toMetadata({
    id: 'g-1',
    threadId: 't-1',
    internalDate: '1717000000000',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Expedition Insure <agents@expedition.insure>' },
        // Gmail preserves the sender's header casing; the lookup must not care.
        { name: 'reply-to', value: 'reply+abc@expedition.insure' },
        { name: 'X-Original-From', value: 'traveller@gmail.example' },
      ],
    },
  });

  assert.equal(meta.replyTo, 'reply+abc@expedition.insure');
  assert.equal(meta.originFrom, 'traveller@gmail.example');
});

test('toMetadata leaves both null when the relay headers are absent', () => {
  const meta = toMetadata({
    id: 'g-2',
    threadId: 't-2',
    labelIds: [],
    payload: { headers: [{ name: 'From', value: 'jordan@partner.example' }] },
  });

  assert.equal(meta.replyTo, null);
  assert.equal(meta.originFrom, null);
});

test('sync persists both relay headers alongside the operator role address', async () => {
  const repo = new Repo(await openDb({ path: ':memory:' }));
  const source = new FakeMailSource({
    address: 'al@unsold.group',
    messages: [CONTACT_FORM, RELAYED_FORWARD],
  });
  await syncMetadata({ account: ACCOUNT, source, repo });

  const contact = await repo.getMessage(ACCOUNT, 'relay-contact-1');
  assert.ok(contact);
  assert.equal(contact.from_addr, 'Expedition Insure <noreply@expedition.insure>');
  assert.equal(contact.reply_to, 'customer@yahoo.example');
  assert.equal(contact.origin_from, null);

  const forward = await repo.getMessage(ACCOUNT, 'relay-fwd-1');
  assert.ok(forward);
  assert.equal(forward.reply_to, 'reply+ps7fxf5k2cg3vnmssc3mvp4t9n8ctjy6@expedition.insure');
  assert.equal(forward.origin_from, 'traveller@gmail.example');
});

test('an enrich-phase upsert carrying no headers does not wipe the captured ones', async () => {
  const repo = new Repo(await openDb({ path: ':memory:' }));
  const source = new FakeMailSource({
    address: 'al@unsold.group',
    messages: [RELAYED_FORWARD],
  });
  await syncMetadata({ account: ACCOUNT, source, repo });

  // Phase 2 re-upserts the row to attach the body and supplies no header fields.
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: 'relay-fwd-1',
    bodyState: 'full',
    bodyText: 'Forwarded from the relay.',
  });

  const row = await repo.getMessage(ACCOUNT, 'relay-fwd-1');
  assert.ok(row);
  assert.equal(row.body_state, 'full');
  assert.equal(row.origin_from, 'traveller@gmail.example');
  assert.equal(row.reply_to, 'reply+ps7fxf5k2cg3vnmssc3mvp4t9n8ctjy6@expedition.insure');
});

test('the CRM feed carries both headers and republishes when they first arrive', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });

  try {
    const driver = new D1Driver(await mf.getD1Database('DB'));
    await runMigrations(driver);
    const repo = new Repo(driver);
    const feed = new CrmChangeFeed(driver);

    // A pre-migration row: indexed before the headers were ever captured.
    await repo.upsertMessage({
      account: ACCOUNT,
      gmailMessageId: 'relay-fwd-1',
      threadId: 'thread-relay-2',
      fromAddr: 'Expedition Insure <agents@expedition.insure>',
      toAddr: 'al@unsold.group',
      subject: '[FWD] Re: Quote request',
    });
    await publishMessageChanges(feed, repo, ACCOUNT, ['relay-fwd-1'], 'job-1');

    const before = await feed.read({ limit: 10 });
    assert.equal(before.events.length, 1);
    assert.equal(before.events[0]?.payload?.['originFrom'], null);

    // Re-publishing the unchanged row must stay deduped.
    await publishMessageChanges(feed, repo, ACCOUNT, ['relay-fwd-1'], 'job-2');
    assert.equal((await feed.read({ limit: 10 })).events.length, 1);

    // A metadata re-sync fills the headers. It moves neither body_state nor
    // body_fetched_at, so only the header component of the key can republish it.
    await repo.upsertMessage({
      account: ACCOUNT,
      gmailMessageId: 'relay-fwd-1',
      threadId: 'thread-relay-2',
      fromAddr: 'Expedition Insure <agents@expedition.insure>',
      toAddr: 'al@unsold.group',
      subject: '[FWD] Re: Quote request',
      replyTo: 'reply+ps7fxf5k2cg3vnmssc3mvp4t9n8ctjy6@expedition.insure',
      originFrom: 'traveller@gmail.example',
    });
    await publishMessageChanges(feed, repo, ACCOUNT, ['relay-fwd-1'], 'job-3');

    const after = await feed.read({ limit: 10 });
    assert.equal(after.events.length, 2);
    const payload = after.events[1]?.payload;
    assert.equal(payload?.['originFrom'], 'traveller@gmail.example');
    assert.equal(payload?.['replyTo'], 'reply+ps7fxf5k2cg3vnmssc3mvp4t9n8ctjy6@expedition.insure');
    assert.equal(payload?.['from'], 'Expedition Insure <agents@expedition.insure>');
  } finally {
    await mf.dispose();
  }
});
