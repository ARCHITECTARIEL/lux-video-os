import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync(new URL('../public/provider-consent.js', import.meta.url), 'utf8');

test('returned consent status names the display provider and discloses HeyGen processing', () => {
  const location = new URL('https://video.example/provider-consent?returned=1');
  const elements = new Map();
  for (const selector of ['#status', '#notice-panel', '#signin-help', '#intro']) {
    elements.set(selector, { hidden: false, textContent: '' });
  }
  runInNewContext(script, {
    location,
    history: { replaceState() {} },
    document: { querySelector: selector => elements.get(selector) },
    URL,
    URLSearchParams,
  });
  assert.equal(
    elements.get('#status').textContent,
    'Consent through The Render (processed by HeyGen) is being checked. Returning here does not mean it has been accepted; the inviting account will see the verified status.',
  );
});

test('consent and privacy copy retain the named processor disclosure', () => {
  const consent = readFileSync(new URL('../public/provider-consent.html', import.meta.url), 'utf8');
  const privacy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
  const identity = readFileSync(new URL('../public/identity.js', import.meta.url), 'utf8');
  assert.match(consent, /authorizing LUX Video OS and HeyGen, the provider behind The Render, to process your likeness/);
  assert.match(consent, /HeyGen will ask you to record a separate consent clip and will check that you are the person shown/);
  assert.match(consent, /does not authorize a reusable voice clone/);
  assert.match(privacy, /<strong>HeyGen, the provider behind The Render<\/strong>/);
  assert.match(privacy, /separate consent recording on the hosted page of The Render \(processed by HeyGen\)/);
  assert.match(identity, /The Render \(processed by HeyGen\) has accepted this presenter’s consent/);
});

test('every named consent string discloses HeyGen alongside The Render', () => {
  const files = [
    ['provider-consent.html', /The Render/],
    ['provider-consent.js', /The Render/],
    ['identity.js', /(?:consent|presenter returned).*The Render|The Render.*consent/i],
    ['privacy.html', /The Render/],
  ];
  const expectedCounts = [3, 3, 3, 2];
  files.forEach(([file, consentLine], index) => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const lines = source.split(/\r?\n/).filter(line => consentLine.test(line));
    assert.equal(lines.length, expectedCounts[index], `${file}: consent string coverage changed`);
    for (const line of lines) {
      assert.match(line, /HeyGen/, `${file}: ${line.trim()}`);
    }
  });
});

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
