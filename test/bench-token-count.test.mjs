import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { countTokens, COUNT_MODE } from '../bench/token-count.mjs';

test('benchmark estimates stay local even when provider credentials exist', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-not-a-real-key';
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Token estimation must not transmit fixture text');
  });
  try {
    assert.equal(await countTokens(''), 0);
    assert.equal(await countTokens('abcde'), 2);
    assert.equal(await countTokens('😀abc'), 2);
    assert.match(COUNT_MODE, /approx/i);
    assert.match(COUNT_MODE, /local/i);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    network.mock.restore();
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  }
});
