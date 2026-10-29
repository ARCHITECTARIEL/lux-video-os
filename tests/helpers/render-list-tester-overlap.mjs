// Child-process helper for tests/render-list-regressions.test.mjs.
// Replaces the hard-coded tester identity with made-up values via a module
// mock so the tester-and-listed ordering can be asserted without real IDs.
// Run with: node --experimental-test-module-mocks <this file>
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const FAKE_TESTER_ID = 'acct-fake-tester-overlap';
const FAKE_TESTER_EMAIL = 'fake-tester-overlap@example.test';
const testersUrl = new URL('../../lib/video-os-testers.js', import.meta.url).href;
const real = await import(testersUrl);
mock.module(testersUrl, {
  namedExports: {
    ...real,
    isTesterAccountId: (id) => String(id || '').trim() === FAKE_TESTER_ID,
    isTesterEmailExact: (email) => String(email || '').trim().toLowerCase() === FAKE_TESTER_EMAIL,
  },
});
const { containedRenderingEntitlementKeys: keysFor } = await import('../../lib/video-os-security.js');
const { configuredPremiumIdentity } = await import('../../lib/video-os-render-authorization.js');

const TESTER = ['liveRendering', 'standardRendering', 'tester'];
const PREMIUM = ['liveRendering', 'standardRendering'];
const LISTED_ID = 'acct-fake-listed-staff';
const STAFF_EMAIL = 'fake-listed-staff@luxmarketingcompany.com';

function withList(value, fn) {
  const original = process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
  if (value === undefined) delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
  else process.env.VIDEO_OS_RENDER_ACCOUNT_ID = value;
  try { return fn(); } finally {
    if (original === undefined) delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
    else process.env.VIDEO_OS_RENDER_ACCOUNT_ID = original;
  }
}

// The mock is live: the tester rule fires for the made-up identity.
withList(undefined, () => {
  assert.deepEqual(keysFor(FAKE_TESTER_ID, 'someone@example.com'), TESTER, 'mocked tester id');
  assert.deepEqual(keysFor('', FAKE_TESTER_EMAIL.toUpperCase()), TESTER, 'mocked tester email, case-folded');
});

// A tester who is ALSO listed keeps exactly the tester key set (tester rule first).
withList(`${FAKE_TESTER_ID},${LISTED_ID}`, () => {
  assert.deepEqual(keysFor(FAKE_TESTER_ID, 'someone@example.com'), TESTER, 'tester id + listed');
  assert.deepEqual(keysFor(FAKE_TESTER_ID, STAFF_EMAIL), TESTER, 'tester id + staff email + listed');
  assert.deepEqual(keysFor(LISTED_ID, FAKE_TESTER_EMAIL), TESTER, 'tester email + listed id');
  assert.deepEqual(keysFor(LISTED_ID, STAFF_EMAIL), PREMIUM, 'listed non-tester never gets tester key');
  assert.equal(configuredPremiumIdentity(FAKE_TESTER_ID, STAFF_EMAIL), true, 'gate agrees for tester+listed');
});

console.log('render-list tester-overlap ok');
