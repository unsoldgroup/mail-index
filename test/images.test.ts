/**
 * Deterministic OCR-candidate image triage tests (agent-OCR design). Exercises
 * the pure selector in src/intelligence/images.ts against synthetic email HTML:
 * a content hero, a tracking pixel, a spacer, a divider, an icon/logo, a linked
 * CTA, dedup of a sliced/repeated src, and the candidate limit. No network — the
 * selector is pure string analysis. Tests import compiled output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseImages,
  classifyImages,
  selectOcrCandidates,
  meaningfulTextLength,
  isLikelyImageOnly,
} from '../dist/intelligence/images.js';

/** A representative marketing-email body: hero + chrome + a CTA. */
const HTML = `
<html><body>
  <img src="https://cdn.example.com/track/open.gif?id=abc" width="1" height="1" alt="">
  <img src="https://cdn.example.com/layout/spacer.gif" width="10" height="10">
  <img src="https://cdn.example.com/ui/divider.png" width="600" height="3">
  <img src="https://cdn.example.com/ui/facebook-icon.png" width="24" height="24" alt="Facebook">
  <img src="https://i.example.com/2026/em_b2b_promo_q3_hero.jpg" width="650" height="430" alt="Save up to 40%">
  <a href="https://www.example.com/offer/summer-sale">
    <img src="https://cdn.example.com/cta/view-offer.jpg" width="300" height="80" alt="View offer">
  </a>
  <img src="https://i.example.com/2026/em_b2b_promo_q3_hero.jpg" width="650" height="430">
  <img src="https://cdn.example.com/photo/landscape.jpg" width="640" height="360">
</body></html>`;

test('parseImages extracts src, dimensions, alt, and link wrapping', async () => {
  const imgs = parseImages(HTML);
  assert.equal(imgs.length, 8);
  const cta = imgs.find((i) => i.src.includes('view-offer'));
  assert.ok(cta);
  assert.equal(cta.width, 300);
  assert.equal(cta.alt, 'View offer');
  assert.equal(cta.linkedHref, 'https://www.example.com/offer/summer-sale');
  const pixel = imgs.find((i) => i.src.includes('open.gif'));
  assert.equal(pixel?.alt, null); // empty alt → null
});

test('classifyImages tags each image kind deterministically', async () => {
  const bySrc = new Map(classifyImages(HTML).map((v) => [v.src, v]));
  assert.equal(bySrc.get('https://cdn.example.com/track/open.gif?id=abc')?.kind, 'pixel');
  assert.equal(bySrc.get('https://cdn.example.com/layout/spacer.gif')?.kind, 'spacer');
  assert.equal(bySrc.get('https://cdn.example.com/ui/divider.png')?.kind, 'divider');
  assert.equal(bySrc.get('https://cdn.example.com/ui/facebook-icon.png')?.kind, 'icon');
  assert.equal(bySrc.get('https://i.example.com/2026/em_b2b_promo_q3_hero.jpg')?.kind, 'content');
  assert.equal(bySrc.get('https://cdn.example.com/cta/view-offer.jpg')?.kind, 'content');
  assert.equal(bySrc.get('https://cdn.example.com/photo/landscape.jpg')?.kind, 'content');
});

test('classification is deterministic (same input → same output)', async () => {
  assert.deepEqual(classifyImages(HTML), classifyImages(HTML));
});

test('selectOcrCandidates returns content images, deduped and ranked', async () => {
  const cands = selectOcrCandidates(HTML);
  // 3 distinct content images (hero appears twice → deduped).
  assert.equal(cands.length, 3);
  assert.ok(cands.every((c) => c.kind === 'content'));
  const srcs = cands.map((c) => c.src);
  assert.equal(new Set(srcs).size, srcs.length, 'no duplicate src');
  // The promo-named hero outscores a plain landscape photo of the same size.
  const heroIdx = srcs.findIndex((s) => s.includes('promo_q3_hero'));
  const photoIdx = srcs.findIndex((s) => s.includes('landscape'));
  assert.ok(heroIdx < photoIdx, 'content-named hero ranks above a plain photo');
  assert.ok(cands[0]?.reasons.length, 'candidates carry explanatory reasons');
});

test('selectOcrCandidates honours the limit', async () => {
  assert.equal(selectOcrCandidates(HTML, { limit: 1 }).length, 1);
});

test('a tracking pixel and a spacer never become candidates', async () => {
  const srcs = selectOcrCandidates(HTML).map((c) => c.src);
  assert.ok(!srcs.some((s) => s.includes('open.gif')));
  assert.ok(!srcs.some((s) => s.includes('spacer.gif')));
});

test('empty / text-only HTML yields no candidates', async () => {
  assert.deepEqual(selectOcrCandidates('<p>Just text, no images.</p>'), []);
  assert.deepEqual(selectOcrCandidates(''), []);
});

test('meaningfulTextLength ignores entity/zero-width preview padding', async () => {
  // A real-world "image-only" body: one short line then preview-text padding.
  const padded = 'Secure this offer by September 8, 2026' + ' &zwnj; &shy; ‌ ­'.repeat(200);
  assert.ok(meaningfulTextLength(padded) < 60, 'padding stripped to the real line');
  assert.equal(meaningfulTextLength(''), 0);
  assert.equal(meaningfulTextLength(null), 0);
});

test('isLikelyImageOnly fires only when text is thin AND images exist', async () => {
  const padded = '&zwnj; &shy; '.repeat(300); // ~3600 chars, ~0 meaningful
  assert.equal(isLikelyImageOnly(padded, 3), true, 'thin text + images → true');
  assert.equal(isLikelyImageOnly(padded, 0), false, 'no images → false');
  const realText = 'Book between June 10 and August 18 2026 and receive 50% off deposit. '.repeat(5);
  assert.equal(isLikelyImageOnly(realText, 3), false, 'real text present → false even with images');
});

test('a content image wins on link wrapping even when unsized', async () => {
  const html = `<a href="https://x.example/offer"><img src="https://x.example/banner.jpg" width="320" height="120"></a>`;
  const [c] = selectOcrCandidates(html);
  assert.ok(c);
  assert.ok(c.reasons.some((r) => /link/i.test(r)));
});
