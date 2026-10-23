import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccountIdList, identityAllowedAccountIds, isIdentityAccountAllowed, allowlistSource, allowlistInvalidEntryCount } from '../lib/identity-account-allowlist.js';
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

test('parsing accepts only exact ASCII IDs and rejects quotes, Unicode folding and duplicates', () => {
  const raw = ' "first",\n second  first,\'third\'  \uFF26our,Four,* ';
  const parsed = parseAccountIdList(raw);
  assert.deepEqual(parsed, ['second', 'first']);
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parseAccountIdList(null), []);
  const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: raw };
  assert.equal(allowlistInvalidEntryCount(env), 5);
  for (const id of ['"first"', 'third', 'Four', 'four', 'Ｆour', '*']) assert.equal(isIdentityAccountAllowed(id, env), false);
  assert.equal(isIdentityAccountAllowed(' second ', env), false);
  assert.equal(isIdentityAccountAllowed('second', env), true);
  assert.deepEqual(parseAccountIdList('a'.repeat(81)), []);
  assert.deepEqual(parseAccountIdList('a'.repeat(80)), ['a'.repeat(80)]);
});

test('whole-list quoting is misconfiguration and cannot fall back to a legacy pin', () => {
  for (const quote of ['"', "'"]) {
    const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: `${quote}first,second${quote}`,
      VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'first' };
    assert.equal(allowlistSource(env), 'allowlist_invalid');
    assert.equal(allowlistInvalidEntryCount(env), 1);
    assert.deepEqual(identityAllowedAccountIds(env), []);
    for (const id of ['first', 'second']) assert.equal(isIdentityAccountAllowed(id, env), false);
    assert.equal(providerCreationActivationStatus({ ...env, VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' }, 'first').reason, 'identity_allowlist_invalid');
  }
});

test('literal star is rejected, never a wildcard', () => {
  const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'first,*' };
  assert.deepEqual(identityAllowedAccountIds(env), ['first']);
  assert.equal(allowlistInvalidEntryCount(env), 1);
  assert.equal(isIdentityAccountAllowed('other', env), false);
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
  for (const id of ['first', 'second']) assert.deepEqual(providerCreationActivationStatus(mismatch, id),
    { enabled: false, reason: 'legacy_pin_mismatch' });
});

test('owner-approved legacy pins cover enrollment and provider creation gates', async () => {
  const { enrollmentAccountAllowed } = await import('../lib/enrollment-policy.js');
  const env = { VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'owner-id',
    VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'owner-id', VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' };
  assert.equal(enrollmentAccountAllowed('owner-id', env), true);
  assert.equal(providerCreationActivationStatus(env, 'owner-id').enabled, true);
  assert.equal(enrollmentAccountAllowed('other', env), false);
  assert.equal(providerCreationActivationStatus(env, 'other').enabled, false);
});

test('explicit list overrides legacy pins and non-string account IDs are denied', () => {
  const env = { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'third', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'first', VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'second' };
  assert.equal(allowlistSource(env), 'allowlist');
  assert.equal(isIdentityAccountAllowed('third', env), true);
  for (const id of ['first', 'second', 3, null, undefined, '', ' ']) assert.equal(isIdentityAccountAllowed(id, env), false);
});
