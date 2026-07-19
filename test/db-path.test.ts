/**
 * Default DB-path resolution (db.ts). Locks the precedence that keeps dev
 * worktrees from bumping the production index: an explicit MAIL_INDEX_DB wins
 * over the XDG default, so a worktree can point at its own file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultDbPath } from '../dist/index/db.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('MAIL_INDEX_DB overrides the default index path (worktree isolation seam)', async () => {
  withEnv({ MAIL_INDEX_DB: '/tmp/some-worktree/.mail-index-dev.sqlite' }, async () => {
    assert.equal(defaultDbPath(), '/tmp/some-worktree/.mail-index-dev.sqlite');
  });
});

test('without MAIL_INDEX_DB the path is deterministic: production sqlite OR a worktree dev DB', async () => {
  // Context-robust: from the installed package / canonical checkout this resolves
  // the shared production index; from a LINKED worktree it auto-isolates to
  // `<worktree>/.mail-index-dev.sqlite`. Either is valid — assert the shape, not
  // the absolute path, so the suite passes in both. Blank MAIL_INDEX_DB == unset.
  for (const blank of [undefined, '   ']) {
    withEnv({ MAIL_INDEX_DB: blank, XDG_DATA_HOME: '/tmp/xdg' }, async () => {
      const p = defaultDbPath();
      const ok = p === '/tmp/xdg/mail-index/mail.sqlite' || p.endsWith('/.mail-index-dev.sqlite');
      assert.ok(ok, `unexpected default db path: ${p}`);
    });
  }
});
