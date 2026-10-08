import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../public/provider-consent.js', import.meta.url), 'utf8');

for (const link of [
  'https://video.example/provider-consent#invite=private-token',
  'https://video.example/provider-consent?invite=private-token',
]) {
  test('consent page removes the invitation bearer from browser history before interaction', () => {
    const location = new URL(link);
    const historyCalls = [];
    const elements = new Map();
    for (const selector of ['#status', '#affirmative-notice', '#continue', '#notice-panel', '#signin-help', '#intro']) {
      elements.set(selector, { hidden: false, textContent: '', disabled: true, addEventListener() {} });
    }
    runInNewContext(script, {
      location,
      history: { replaceState: (...args) => historyCalls.push(args) },
      document: { querySelector: selector => elements.get(selector) },
      URL,
      URLSearchParams,
    });
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0][2], '/provider-consent');
    assert.equal(elements.get('#notice-panel').hidden, false);
  });
}
