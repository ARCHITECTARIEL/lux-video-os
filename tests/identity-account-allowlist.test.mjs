import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccountIdList, identityAllowedAccountIds, isIdentityAccountAllowed, allowlistSource } from '../lib/identity-account-allowlist.js';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';

test('one or many explicit IDs allow only their accounts', () => {
  const single = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'first' };
  assert.equal(isIdentityAccountAllowed('first', single), true);
  assert.equal(isIdentityAccountAllowed('other', single), false);
  const many = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'first,second third' };
  assert.deepEqual(identityAllowedAccountIds(many), ['first', 'second', 'third']);
  for (const id of ['first', 'second', 'third']) assert.equal(isIdentityAccountAllowed(id, many), true);
  assert.equal(isIdentityAccountAllowed('other', many), false);
  assert.equal(allowlistSource(many), 'allowlist');
});

test('empty and unset configuration deny every account despite the creation flag', () => {
  for (const value of [undefined, '', ' , \n  ']) {
    const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: value, VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' };
    assert.equal(allowlistSource(env), 'none');
    assert.deepEqual(identityAllowedAccountIds(env), []);
    for (const accountId of ['first', 'other', undefined]) {
      assert.equal(isIdentityAccountAllowed(accountId, env), false);
      assert.deepEqual(providerCreationActivationStatus(env, accountId), { enabled: false, reason: 'identity_allowlist_empty' });
    }
  }
});

test('parsing normalizes quotes, whitespace, Unicode and duplicates without case folding', () => {
  const parsed = parseAccountIdList(' "first",\n second  first,\'third\'  Ｆour,Four ');
  assert.deepEqual(parsed, ['first', 'second', 'third', 'Four']);
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parseAccountIdList(null), []);
  assert.equal(isIdentityAccountAllowed('four', { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'Four' }), false);
});

test('legacy pins require agreement, and one legacy pin remains honored', () => {
  for (const pin of ['VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID', 'VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID']) {
    const env = { [pin]: 'first', VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' };
    assert.equal(allowlistSource(env), 'legacy_pin');
    assert.equal(isIdentityAccountAllowed('first', env), true);
    assert.equal(providerCreationActivationStatus(env, 'first').enabled, true);
    assert.equal(isIdentityAccountAllowed('other', env), false);
  }
  const mismatch = { VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'first', VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'second', VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' };
  assert.equal(allowlistSource(mismatch), 'legacy_pin_mismatch');
  assert.deepEqual(identityAllowedAccountIds(mismatch), []);
  for (const id of ['first', 'second']) assert.equal(providerCreationActivationStatus(mismatch, id).enabled, false);
});

test('explicit list overrides legacy pins and non-string account IDs are denied', () => {
  const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'third', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'first', VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'second' };
  assert.equal(allowlistSource(env), 'allowlist');
  assert.equal(isIdentityAccountAllowed('third', env), true);
  for (const id of ['first', 'second', 3, null, undefined, '', ' ']) assert.equal(isIdentityAccountAllowed(id, env), false);
});
