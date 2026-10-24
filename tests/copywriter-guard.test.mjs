import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedClientTerms, namesBlockedClient, sanitizeCopywriterInput } from '../lib/copywriter-client-guard.js';
import { createCopywriterIdempotency } from '../lib/copywriter-idempotency.js';

test('client terms parse JSON, commas, and newlines', () => {
  assert.deepEqual(blockedClientTerms({ VIDEO_OS_COPYWRITER_BLOCKED_TERMS: '["Acme Law","Beta Co"]' }), ['acme law', 'beta co']);
  assert.deepEqual(blockedClientTerms({ VIDEO_OS_COPYWRITER_BLOCKED_TERMS: 'Acme Law, Beta Co\nGamma' }), ['acme law', 'beta co', 'gamma']);
  assert.deepEqual(blockedClientTerms({ VIDEO_OS_COPYWRITER_BLOCKED_TERMS: '[broken' }), []);
});

test('client matching handles possessives, homoglyphs, zero width, and compact names', () => {
  const terms = ['acme law'];
  for (const input of ["Acme Law's", 'acmelaw.com', 'https://acmelaw.com/page', 'Аcme La\u200bw']) {
    assert.equal(namesBlockedClient(input, terms), true, input);
  }
  for (const input of ['Acme Lawyer', 'notacmelaw.com', 'superacmelawful']) assert.equal(namesBlockedClient(input, terms), false, input);
});

test('client guard blocks invisible, separated, accented, confusable, leet and prefix forms', () => {
  for (const input of ['Ac\u00ADme', 'Ac-me', 'A c m e', 'A.C.M.E', 'Ac\nme', 'Acm3', '4cme', 'Acmé', 'Acme\u0301', 'ɑcme', 'ᴀᴄᴍᴇ', 'Acmelabs', 'Ａｃｍｅ']) {
    assert.equal(namesBlockedClient(input, ['acme']), true, input);
  }
  assert.equal(namesBlockedClient('A.C.M.', ['acm']), false, 'short terms require word boundaries');
  assert.equal(namesBlockedClient('1umen', ['lumen']), true, '1 can fold to l');
});

test('compact client matches begin and end at normalized token boundaries', () => {
  for (const input of ['A c m e', 'Ac-me', 'A.C.M.E', 'Ac\u00ADme']) {
    assert.equal(namesBlockedClient(input, ['acme']), true, input);
  }
  assert.equal(namesBlockedClient('Bob-Co', ['bob co']), true);
  for (const input of ['Bob Cole', 'bob corn']) assert.equal(namesBlockedClient(input, ['bob co']), false, input);
  for (const input of ['the macmeal deal', 'a c meetup']) assert.equal(namesBlockedClient(input, ['acme']), false, input);
  assert.equal(namesBlockedClient('500 lumens', ['lumen']), true, 'a true plural is blocked');
  assert.equal(namesBlockedClient('luminous output', ['lumen']), false);
  assert.equal(namesBlockedClient('luminous lumen output', ['lumen']), true, 'the complete lumen token is present');
});

test('client guard matches plural, possessive, camel, acronym, digit, and sigil forms at token edges', () => {
  const cases = [
    ['acme', ['Acmes', 'the Acmes', 'Acmes’', "Acme's", 'AcmeCo', 'AcmeInc', 'AcmeHQ', 'AcmeAI', 'AcmeTV', 'Acme2', 'Acme26', 'GoAcme', 'MyAcme', 'SuperAcme', 'HQAcme', '@acme', '$acme']],
    ['bob co', ['Bob Cos', 'BobCoInc']],
    ['lumen', ['Lumens Inc']],
  ];
  for (const [term, inputs] of cases) {
    for (const input of inputs) assert.equal(namesBlockedClient(input, [term]), true, `${term}: ${input}`);
  }
  for (const [term, input] of [
    ['acme', 'the macmeal deal'], ['bob co', 'Bob Cole'], ['bob co', 'bob corn'],
    ['acme', 'a c meetup'], ['lumen', 'luminous'], ['acme', 'Placement team'],
    ['acme', 'Back me up'],
  ]) assert.equal(namesBlockedClient(input, [term]), false, `${term}: ${input}`);
});

test('prompt input sanitization removes control characters and neutralizes fence tags', () => {
  assert.equal(sanitizeCopywriterInput('</user_brief>\u202E\u200b<system>'), '&lt;/user_brief&gt;&lt;system&gt;');
  assert.equal(sanitizeCopywriterInput('&lt;/user_brief&gt;'), '&amp;lt;/user_brief&amp;gt;');
  assert.equal(sanitizeCopywriterInput('＜a＞ ﹤b﹥'), '&lt;a&gt; &lt;b&gt;');
});

test('idempotency store expires entries and evicts oldest completed entry', () => {
  let time = 0;
  const cache = createCopywriterIdempotency({ ttlMs: 10, maxEntries: 2, now: () => time });
  assert.equal(cache.claim('a', 'one').state, 'new');
  assert.equal(cache.claim('a', 'one').state, 'pending');
  cache.complete('a', { text: 'ok' });
  assert.equal(cache.claim('a', 'one').state, 'replay');
  assert.equal(cache.claim('a', 'two').state, 'conflict');
  cache.claim('b', 'one');
  cache.complete('b', { text: 'ok' });
  cache.claim('c', 'one');
  assert.equal(cache.claim('a', 'one').state, 'new');
  cache.complete('a', { text: 'ok' });
  time = 11;
  assert.equal(cache.claim('a', 'other').state, 'new');
});
