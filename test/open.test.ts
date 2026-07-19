/**
 * `open` tests (SCOPE 1.3, UNS-1218, PLAN §13). Cover:
 *
 *  - providerUrl builds the canonical Gmail #all deep link for a gws account.
 *  - runOpen resolves a ref to that URL (no provider fetch, message need not be
 *    indexed) and prefers a stored gmail_url when the row carries one.
 *  - runOpen errors clearly for an unknown account (shared config resolution).
 *  - formatOpen prints the bare URL.
 *
 * Imports the compiled output, like the other suites (runs after pretest:tsc).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../dist/index/db.js';
import { Repo } from '../dist/index/repo.js';
import { providerUrl, runOpen, formatOpen } from '../dist/cli/open.js';
import { parseRef } from '../dist/cli/show.js';
import { ConfigError } from '../dist/config/index.js';

const ACCOUNT = 'test-acct';
const CONFIG = { accounts: { [ACCOUNT]: { adapter: 'gws', configDir: '/x' } } } as never;

async function freshRepo(): Repo {
  return new Repo(await openDb({ path: ':memory:' }));
}

test('providerUrl builds the canonical Gmail #all deep link for gws', async () => {
  const url = providerUrl({ adapter: 'gws', configDir: '/x' } as never, '18f0a1b2c3');
  assert.equal(url, 'https://mail.google.com/mail/u/0/#all/18f0a1b2c3');
});

test('runOpen resolves a ref to its provider URL without touching the provider', async () => {
  const repo = await freshRepo();
  // Note: the message is NOT indexed — open must still resolve the URL from the
  // account adapter + id alone (the print contract: resolve, do not fetch).
  const result = await runOpen(CONFIG, repo, parseRef(`${ACCOUNT}:abc123`));
  assert.equal(result.ref.account, ACCOUNT);
  assert.equal(result.ref.id, 'abc123');
  assert.equal(result.url, 'https://mail.google.com/mail/u/0/#all/abc123');
});

test('runOpen prefers a stored gmail_url over the constructed deep link', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({
    account: ACCOUNT,
    gmailMessageId: 'stored1',
    bodyState: 'meta',
    gmailUrl: 'https://mail.google.com/mail/u/3/#inbox/stored1',
  });
  const result = await runOpen(CONFIG, repo, parseRef(`${ACCOUNT}:stored1`));
  assert.equal(result.url, 'https://mail.google.com/mail/u/3/#inbox/stored1');
});

test('runOpen falls back to the constructed URL when the stored url is null', async () => {
  const repo = await freshRepo();
  await repo.upsertMessage({ account: ACCOUNT, gmailMessageId: 'nourl', bodyState: 'meta' });
  const result = await runOpen(CONFIG, repo, parseRef(`${ACCOUNT}:nourl`));
  assert.equal(result.url, 'https://mail.google.com/mail/u/0/#all/nourl');
});

test('runOpen errors clearly for an unknown account', async () => {
  const repo = await freshRepo();
  await assert.rejects(
    async () => await runOpen(CONFIG, repo, parseRef('nope:abc')),
    (e: unknown) => e instanceof ConfigError && /unknown account/.test((e as Error).message),
  );
});

test('formatOpen prints the bare URL on its own line', async () => {
  assert.equal(
    formatOpen({ ref: { account: ACCOUNT, id: 'x' }, url: 'https://example.test/x' }),
    'https://example.test/x\n',
  );
});
