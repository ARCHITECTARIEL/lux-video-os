import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountAllowedForContainedRendering,
  containedRenderingEntitlementKeys,
  isTesterAccountId,
  isTesterEmailDomain,
  registerTesterAccountId,
  requireRenderAccountAuthorization,
  revokeTesterAccountId,
} from '../lib/video-os-security.js';

test('isTesterEmailDomain: automatically identifies @luxmarketingcompany.com and designated tester emails', () => {
  assert.equal(isTesterEmailDomain('ariel@luxmarketingcompany.com'), true);
  assert.equal(isTesterEmailDomain('team.member@luxmarketingcompany.com'), true);
  assert.equal(isTesterEmailDomain('ARIEL@LUXMARKETINGCOMPANY.COM'), true);
  assert.equal(isTesterEmailDomain('arielsmailbox@gmail.com'), true);
  assert.equal(isTesterEmailDomain('ARIELSMAILBOX@GMAIL.COM'), true);
  assert.equal(isTesterEmailDomain('someone@othercompany.com'), false);
  assert.equal(isTesterEmailDomain(''), false);
});

// This test previously asserted the opposite of what it now asserts --
// discovered as a real, live bug (not just a coverage gap) during Premium-
// tier edge-case testing: a pure @luxmarketingcompany.com domain match
// (any address on that domain, not a specific designated person) was
// granting full liveRendering (Premium) via containedRenderingEntitlementKeys,
// directly contradicting the already-established, deliberately-reasoned
// contract in tests/google-signin-route.test.mjs ("a domain match must
// never grant liveRendering -- Premium's backend gate only checks
// accountId, not email, so granting it here would recreate a real gate
// mismatch"). Confirmed the leak was real via direct reproduction before
// fixing lib/video-os-security.js + lib/video-os-testers.js. Updated here
// to match the corrected, intended behavior: a domain match grants
// standardRendering (its actual purpose -- testing Standard tier) and
// never liveRendering or backend containment authorization.
test('containedRenderingEntitlementKeys: a pure @luxmarketingcompany.com domain match grants Standard and Tester only, never liveRendering', () => {
  const accountId = 'acct-lux-tester-1';
  const keys = containedRenderingEntitlementKeys(accountId, 'dev@luxmarketingcompany.com');
  assert.ok(!keys.includes('liveRendering'), 'a domain match must never grant liveRendering -- see the reasoning above');
  assert.ok(keys.includes('standardRendering'));
  assert.ok(keys.includes('tester'));
  // A domain-only match does not register the account as a tester ID, and
  // (unlike the exact-match case) must not authorize Premium containment.
  assert.equal(isTesterAccountId(accountId), false);
  assert.throws(() => requireRenderAccountAuthorization(accountId), { statusCode: 503 });
});

test('tester account registry: in-memory whitelist grants rendering access without environment variables', () => {
  const externalId = 'acct-external-vip-tester';
  assert.equal(isTesterAccountId(externalId), false);

  registerTesterAccountId(externalId);
  assert.equal(isTesterAccountId(externalId), true);
  assert.equal(accountAllowedForContainedRendering(externalId), true);
  assert.equal(requireRenderAccountAuthorization(externalId), true);

  const keys = containedRenderingEntitlementKeys(externalId, 'partner@external.com');
  assert.ok(keys.includes('liveRendering'));
  assert.ok(keys.includes('standardRendering'));
  assert.ok(keys.includes('tester'));

  revokeTesterAccountId(externalId);
  assert.equal(isTesterAccountId(externalId), false);
});

test('requireRenderAccountAuthorization: an exact designated tester email authorizes even without in-memory registry or env var, but a mere domain match does not', () => {
  assert.equal(requireRenderAccountAuthorization('acct-fresh-lambda-1', 'arielsmailbox@gmail.com'), true);
  assert.throws(() => requireRenderAccountAuthorization('acct-fresh-lambda-2', 'ariel@luxmarketingcompany.com'), { statusCode: 503 });
});
