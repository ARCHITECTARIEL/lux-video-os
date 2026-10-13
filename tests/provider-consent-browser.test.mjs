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

function assertNamedConsentMentions(source, file, consentLine, expectedCount) {
  const lines = source.split(/\r?\n/).filter(line => consentLine.test(line));
  const mentions = lines.flatMap(line => [...line.matchAll(/The Render/g)].map(match => ({ line, index: match.index })));
  assert.equal(mentions.length, expectedCount, `${file}: consent mention coverage changed`);
  for (const { line, index } of mentions) {
    const before = line.slice(0, index);
    const after = line.slice(index + 'The Render'.length);
    assert.ok(
      before.endsWith('HeyGen, the provider behind ') || after.startsWith(' (processed by HeyGen)'),
      `${file}: The Render mention lacks HeyGen attribution: ${line.trim()}`,
    );
  }
}

test('every named consent mention discloses HeyGen alongside The Render', () => {
  const files = [
    ['provider-consent.html', /The Render/],
    ['provider-consent.js', /The Render/],
    ['identity.js', /(?:consent|presenter returned).*The Render|The Render.*consent/i],
    ['privacy.html', /The Render/],
  ];
  const expectedCounts = [4, 3, 3, 2];
  files.forEach(([file, consentLine], index) => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assertNamedConsentMentions(source, file, consentLine, expectedCounts[index]);
  });
});

test('a second Render mention on the same consent line still needs HeyGen attribution', () => {
  const source = readFileSync(new URL('../public/provider-consent.html', import.meta.url), 'utf8');
  const changed = source.replace(
    'after The Render (processed by HeyGen) confirms consent',
    'after The Render confirms consent',
  );
  assert.notEqual(changed, source, 'consent fixture must contain the second mention');
  assert.throws(() => assertNamedConsentMentions(changed, 'provider-consent.html', /The Render/, 4),
    /The Render mention lacks HeyGen attribution/);
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
