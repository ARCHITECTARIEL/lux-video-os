import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAuthorization, assertJobAuthorizationBinding } from '../lib/video-os-render-authorization.js';
import { reconcileAuthenticatedEntitlements } from '../db/repositories.js';

const grant = { accountId: 'owner', entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant' };
test('persisted tier grants exclude disabled, expired, malformed-expiry and wrong-account grants', () => {
  assert.equal(renderAuthorization('owner', 'premium', [grant]).tier, 'premium');
  for (const invalid of [{ enabled: false }, { accountId: 'other' }, { expiresAt: '2000-01-01' }, { expiresAt: 'invalid' }, { entitlementKey: 'tester' }, { entitlementKey: 'standardRendering' }]) {
    assert.throws(() => renderAuthorization('owner', 'premium', [{ ...grant, ...invalid }]), { statusCode: 403 });
  }
  assert.equal(renderAuthorization('owner', 'standard', [{ ...grant, entitlementKey: 'standardRendering' }]).tier, 'standard');
  assert.throws(() => renderAuthorization('owner', 'unknown', [grant]));
});

test('reserved authority is bound to account, tier, job and version', () => {
  const decision = { ...renderAuthorization('owner', 'premium', [grant]), jobId: 'job-1' };
  const job = { id: 'job-1', accountId: 'owner', input: { renderAuthorization: decision } };
  assert.doesNotThrow(() => assertJobAuthorizationBinding(job, 'premium'));
  for (const invalid of [{ accountId: 'other' }, { tier: 'standard' }, { jobId: 'job-2' }, { version: 99 }, { entitlementKey: 'standardRendering' }]) {
    assert.throws(() => assertJobAuthorizationBinding({ ...job, input: { renderAuthorization: { ...decision, ...invalid } } }, 'premium'), { statusCode: 403 });
  }
  assert.throws(() => assertJobAuthorizationBinding({ ...job, input: { renderAuthorization: null } }, 'premium'));
  assert.doesNotThrow(() => assertJobAuthorizationBinding({ ...job, input: {} }, 'premium'), 'legacy jobs require a separate current-permission check');
});

test('sign-in preserves independent admin grants and does not resurrect revoked grants', () => {
  for (const enabled of [true, false]) {
    const result = reconcileAuthenticatedEntitlements([{ ...grant, enabled }], ['liveRendering', 'googleAccess']);
    assert.deepEqual(result.desiredKeys, ['googleAccess']);
    assert.deepEqual(result.preservedKeys, enabled ? ['liveRendering'] : []);
  }
});

test('workspace sign-in cannot restore tiers explicitly revoked by an administrator', () => {
  const revoked = ['liveRendering', 'standardRendering', 'tester'].map(entitlementKey => ({ ...grant, entitlementKey, enabled: false }));
  const result = reconcileAuthenticatedEntitlements(revoked, ['passwordAccess', 'liveRendering', 'standardRendering']);
  assert.deepEqual(result.desiredKeys, ['passwordAccess']);
  assert.deepEqual(result.preservedKeys, []);
  for (const tier of ['standard', 'premium']) assert.throws(() => renderAuthorization('owner', tier, revoked), { statusCode: 403 });
});
