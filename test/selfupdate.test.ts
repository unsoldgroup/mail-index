/**
 * Self-updater semver tests (bin/semver.mjs). The pure version-comparison that
 * gates whether the launch shim updates — unit-tested directly (the updater's
 * network/spawn paths are exercised manually + audited by the egress guard).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain .mjs shim outside the TS build graph.
import { compareVersions, isNewer } from '../bin/semver.mjs';

test('compareVersions orders the release triple', async () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0); // leading v tolerated
});

test('a release outranks its own prerelease; bad input sorts low', async () => {
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.1'), 1);
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), -1);
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.1'), 1);
  // unparseable "latest" must never trigger an update
  assert.equal(compareVersions('garbage', '1.0.0'), -1);
  assert.equal(compareVersions('', '1.0.0'), -1);
});

test('isNewer is a strict upgrade predicate', async () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('1.2.3-rc.1', '1.2.3'), false); // never "upgrade" onto a prerelease
  assert.equal(isNewer('not-a-version', '1.0.0'), false);
});
