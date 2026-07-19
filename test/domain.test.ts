/**
 * registrableDomain / hostOf unit tests (intelligence/domain.ts). Pure,
 * deterministic, no DB — the eTLD+1 reduction that gives cadence + categorization
 * a stable brand key. Tests import the compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registrableDomain, hostOf } from '../dist/intelligence/domain.js';

test('registrableDomain collapses bulk subdomains to the brand (eTLD+1)', async () => {
  assert.equal(registrableDomain('email.silversea.com'), 'silversea.com');
  assert.equal(registrableDomain('mail.travelhx.com'), 'travelhx.com');
  assert.equal(registrableDomain('news.hl-cruises.com'), 'hl-cruises.com');
  assert.equal(registrableDomain('cruises.ponant.com'), 'ponant.com');
  assert.equal(registrableDomain('silversea.com'), 'silversea.com');
});

test('registrableDomain keeps three labels under multi-part public suffixes', async () => {
  assert.equal(registrableDomain('bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('luxurylodges.com.au'), 'luxurylodges.com.au');
  assert.equal(registrableDomain('shop.luxurylodges.com.au'), 'luxurylodges.com.au');
});

test('registrableDomain normalizes case, trailing dot, and port; handles edges', async () => {
  assert.equal(registrableDomain('EMAIL.Silversea.COM'), 'silversea.com');
  assert.equal(registrableDomain('silversea.com.'), 'silversea.com');
  assert.equal(registrableDomain('mail.silversea.com:587'), 'silversea.com');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain(null), null);
  assert.equal(registrableDomain(undefined), null);
});

test('hostOf extracts the lower-cased host of a bare address', async () => {
  assert.equal(hostOf('Person@Example.COM'), 'example.com');
  assert.equal(hostOf('a@email.silversea.com'), 'email.silversea.com');
  assert.equal(hostOf('no-at-sign'), null);
  assert.equal(hostOf('trailing@'), null);
  assert.equal(hostOf(null), null);
});
