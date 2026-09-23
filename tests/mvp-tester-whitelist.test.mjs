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

test('isTesterEmailDomain: automatically identifies @luxmarketingcompany.com as tester domain', () => {
  assert.equal(isTesterEmailDomain('ariel@luxmarketingcompany.com'), true);
  assert.equal(isTesterEmailDomain('team.member@luxmarketingcompany.com'), true);
  assert.equal(isTesterEmailDomain('ARIEL@LUXMARKETINGCOMPANY.COM'), true);
  assert.equal(isTesterEmailDomain('someone@othercompany.com'), false);
  assert.equal(isTesterEmailDomain(''), false);
});

test('containedRenderingEntitlementKeys: grants full Standard, Premium, and Tester entitlements to @luxmarketingcompany.com', () => {
  const accountId = 'acct-lux-tester-1';
  const keys = containedRenderingEntitlementKeys(accountId, 'dev@luxmarketingcompany.com');
  assert.ok(keys.includes('liveRendering'));
  assert.ok(keys.includes('standardRendering'));
  assert.ok(keys.includes('tester'));
  assert.equal(isTesterAccountId(accountId), true);
  assert.equal(requireRenderAccountAuthorization(accountId), true);
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
