/**
 * FTS contract tests (CONTEXT.md "FTS contract", src/index/fts.ts).
 *
 * The contract is the single home for how a Message becomes searchable and
 * ranked, so index-time (the Repo's FTS sync + index rebuilds) and query-time
 * (search) can never drift. These tests pin both halves:
 *
 *  - {@link buildMatch} — the query-time MATCH builder (moved here from the CLI
 *    so it is no longer owned by one caller).
 *  - {@link projectBody} — the index-time `body` projection across the Body-state
 *    ladder; the property the drift-free guarantee rests on.
 *
 * Imports the built JS (`../dist/...`) like the other suites so it runs after
 * the `pretest` compile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BM25_WEIGHTS,
  FTS_TABLE_DDL,
  bm25Expr,
  buildMatch,
  expandQuery,
  projectBody,
  projectFtsRow,
  projectRecipients,
} from '../dist/index/fts.js';
import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';

// ---- buildMatch (query-time) ---------------------------------------------

test('buildMatch quotes terms, prefixes, and OR-combines', async () => {
  assert.equal(buildMatch(['deposit', 'antarctica']), '"deposit"* OR "antarctica"*');
});

test('buildMatch escapes embedded quotes and drops blanks', async () => {
  assert.equal(buildMatch(['  ', 'a"b']), '"a""b"*');
});

test('buildMatch handles FTS operator characters safely', async () => {
  // Bare `OR`/punctuation as a literal term must not break the query — it is
  // quoted, so FTS5 treats it as a string, not an operator.
  assert.equal(buildMatch(['OR', 'a-b']), '"OR"* OR "a-b"*');
});

test('buildMatch returns empty string when no usable term remains', async () => {
  assert.equal(buildMatch([]), '');
  assert.equal(buildMatch(['   ', '']), '');
});

// ---- projectBody (index-time, the ladder) --------------------------------

test('projectBody at meta indexes the snippet only', async () => {
  assert.equal(
    projectBody({ snippet: 'a snippet', bodyText: null, summary: null }),
    'a snippet',
  );
});

test('projectBody at full indexes snippet + distilled body', async () => {
  assert.equal(
    projectBody({ snippet: 'snip', bodyText: 'distilled body', summary: null }),
    'snip\ndistilled body',
  );
});

test('projectBody on a full row with a summary is additive (ADR-0003)', async () => {
  // A summary present on a `full` row feeds FTS alongside the body, not instead.
  assert.equal(
    projectBody({ snippet: 'snip', bodyText: 'body', summary: 'the summary' }),
    'snip\nbody\nthe summary',
  );
});

test('projectBody at summary-only indexes snippet + summary (body demoted)', async () => {
  assert.equal(
    projectBody({ snippet: 'snip', bodyText: null, summary: 'the summary' }),
    'snip\nthe summary',
  );
});

test('projectBody returns null when nothing is searchable', async () => {
  assert.equal(projectBody({ snippet: null, bodyText: null, summary: null }), null);
  assert.equal(projectBody({ snippet: null, bodyText: null }), null);
});

test('projectRecipients joins to + cc on a space, null when neither', async () => {
  assert.equal(projectRecipients('a@x.com', 'b@x.com'), 'a@x.com b@x.com');
  assert.equal(projectRecipients('a@x.com', null), 'a@x.com');
  assert.equal(projectRecipients(null, 'b@x.com'), 'b@x.com');
  assert.equal(projectRecipients(null, null), null);
});

test('projectFtsRow maps a message row to the four FTS columns', async () => {
  assert.deepEqual(
    projectFtsRow({
      subject: 'Re: deposit',
      fromAddr: 'sender@x.com',
      toAddr: 'me@x.com',
      ccAddr: 'cc@x.com',
      snippet: 'snip',
      bodyText: 'body',
      summary: 'sum',
    }),
    {
      subject: 'Re: deposit',
      sender: 'sender@x.com',
      recipients: 'me@x.com cc@x.com',
      body: 'snip\nbody\nsum',
    },
  );
});

// ---- query expansion (opt-in synonyms) -----------------------------------

test('expandQuery adds curated synonyms, term-first and de-duplicated', async () => {
  assert.deepEqual(expandQuery(['invoice']), ['invoice', 'receipt', 'bill']);
  // A term with no synonyms is passed through untouched.
  assert.deepEqual(expandQuery(['antarctica']), ['antarctica']);
  // Overlapping synonym sets de-dupe (invoice+receipt both pull "bill").
  assert.deepEqual(expandQuery(['invoice', 'receipt']), ['invoice', 'receipt', 'bill']);
});

test('buildMatch expands only when asked', async () => {
  assert.equal(buildMatch(['invoice']), '"invoice"*');
  assert.equal(buildMatch(['invoice'], { expand: true }), '"invoice"* OR "receipt"* OR "bill"*');
});

// ---- bm25 ranking contract -----------------------------------------------

test('bm25Expr weights subject/sender above body', async () => {
  assert.deepEqual([...BM25_WEIGHTS], [10, 8, 4, 1]);
  assert.equal(bm25Expr(), 'bm25(messages_fts, 10, 8, 4, 1)');
});

// ---- index DDL ------------------------------------------------------------

test('FTS_TABLE_DDL uses the porter tokenizer', async () => {
  assert.match(FTS_TABLE_DDL, /tokenize = 'porter unicode61'/);
});

// ---- the drift-free guarantee, made executable ---------------------------

test('index-time FTS rows match the contract projection (no drift)', async () => {
  // What the repo's live sync writes to messages_fts MUST equal projectFtsRow —
  // the same function the m005 rebuild migration uses to repopulate. If these
  // ever disagree, ranking becomes non-reproducible. This pins the guarantee.
  const db = await openDb({ path: ':memory:' });
  const repo = new Repo(db);

  // Seed messages across the Body-state ladder.
  await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm-meta',
    subject: 'Deposit refund',
    fromAddr: 'ops@travel.com',
    toAddr: 'me@x.com',
    ccAddr: 'cc@x.com',
    snippet: 'your deposit',
  });
  await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm-full',
    subject: 'Itinerary',
    fromAddr: 'agent@travel.com',
    toAddr: 'me@x.com',
    ccAddr: null,
    snippet: 'flight details',
    bodyState: 'full',
    bodyText: 'distilled flight body',
  });
  await repo.saveMessageSummary({ account: 'a', gmailMessageId: 'm-full', text: 'a summary' });

  const rows = await db
    .prepare(
      `SELECT m.rowid, m.subject, m.from_addr, m.to_addr, m.cc_addr, m.snippet,
              m.body_text, m.summary_text,
              f.subject AS f_subject, f.sender AS f_sender,
              f.recipients AS f_recipients, f.body AS f_body
         FROM messages m JOIN messages_fts f ON f.rowid = m.rowid
        ORDER BY m.gmail_message_id`,
    )
    .all();

  assert.equal(rows.length, 2);
  for (const r of rows) {
    const expected = projectFtsRow({
      subject: r.subject,
      fromAddr: r.from_addr,
      toAddr: r.to_addr,
      ccAddr: r.cc_addr,
      snippet: r.snippet,
      bodyText: r.body_text,
      summary: r.summary_text,
    });
    assert.deepEqual(
      { subject: r.f_subject, sender: r.f_sender, recipients: r.f_recipients, body: r.f_body },
      expected,
    );
  }
});

test('porter stemming makes search match word forms (refunds query ↔ refund doc)', async () => {
  const db = await openDb({ path: ':memory:' });
  const repo = new Repo(db);
  await repo.upsertMessage({
    account: 'a',
    gmailMessageId: 'm1',
    subject: 'Your refund is processed',
    fromAddr: 'ops@x.com',
    snippet: 'all set',
  });
  // Plural query against a singular doc: prefix-matching alone ("refunds"*)
  // would NOT match "refund" — only the porter stemmer (both → "refund") does.
  const hits = await repo.searchMessages(buildMatch(['refunds']));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].gmail_message_id, 'm1');
});
