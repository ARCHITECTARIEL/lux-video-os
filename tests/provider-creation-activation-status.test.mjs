import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';

test('providerCreationActivationStatus defaults to disabled when the env var is unset', () => {
  const status = providerCreationActivationStatus({});
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'identity_allowlist_empty');
});

test('providerCreationActivationStatus stays disabled for values that are not "true" under trim+lowercase', () => {
  for (const value of ['1', 'yes', 'false', 'enabled', '']) {
    const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: value });
    assert.equal(status.enabled, false, `expected disabled for ${JSON.stringify(value)}`);
  }
});

test('providerCreationActivationStatus enables on "true" case-insensitively for an allowed account', () => {
  for (const value of ['true', 'True', 'TRUE', ' true', 'true ', ' TrUe ']) {
    const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: value, VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: 'owner-account' }, 'owner-account');
    assert.equal(status.enabled, true, `expected enabled for ${JSON.stringify(value)}`);
    assert.equal(status.reason, 'owner_authorized_contained_activation');
  }
});

test('providerCreationActivationStatus defaults to process.env when called with no argument', () => {
  const original = process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
  const originalCanary = process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
  const originalAllowed = process.env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS;
  const originalProvider = process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID;
  try {
    delete process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    delete process.env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS;
    delete process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID;
    assert.equal(providerCreationActivationStatus().enabled, false);
    process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED = 'true';
    // With no allowlist or legacy pin, the enabled switch no longer opens creation to everyone.
    assert.deepEqual(providerCreationActivationStatus(), { enabled: false, reason: 'identity_allowlist_empty' });
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
    else process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED = original;
    if (originalCanary === undefined) delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    else process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID = originalCanary;
    if (originalAllowed === undefined) delete process.env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS;
    else process.env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS = originalAllowed;
    if (originalProvider === undefined) delete process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID;
    else process.env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID = originalProvider;
  }
});

test('providerCreationActivationStatus returns a frozen object', () => {
  const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' });
  assert.ok(Object.isFrozen(status));
});

test('configured private enrollment canary permits only the exact requesting account with the creation switch on', () => {
  const env = {
    VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'owner-account',
    VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
  };
  assert.deepEqual(providerCreationActivationStatus(env, 'owner-account'), {
    enabled: true, reason: 'owner_authorized_contained_activation',
  });
  for (const accountId of ['other-account', undefined, null, '', ' ', 123]) {
    assert.deepEqual(providerCreationActivationStatus(env, accountId), {
      enabled: false, reason: 'private_enrollment_canary_active',
    });
  }
  assert.equal(providerCreationActivationStatus(env, ' owner-account ').enabled, false);
  assert.deepEqual(providerCreationActivationStatus({ ...env, VIDEO_OS_PROVIDER_CREATION_ENABLED: 'false' }, 'owner-account'), {
    enabled: false, reason: 'verified_provider_account_binding_not_wired',
  });
  assert.equal(providerCreationActivationStatus({ ...env, VERCEL_ENV: 'preview' }).enabled, false);
  // Preview and an empty pin are also fail closed unless another allowlist source exists.
  assert.equal(providerCreationActivationStatus({ VERCEL_ENV: 'preview', VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' }).enabled, false);
  assert.equal(providerCreationActivationStatus({ ...env, VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: ' ' }).enabled, false);
});

test('legacy pin IDs must meet exact lowercase ASCII validation', () => {
  const env = {
    VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'Owner-Account',
    VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
  };
  assert.deepEqual(providerCreationActivationStatus(env, 'Owner-Account'), {
    enabled: false, reason: 'identity_allowlist_invalid',
  });
  assert.deepEqual(providerCreationActivationStatus(env, 'owner-account'), {
    enabled: false, reason: 'identity_allowlist_invalid',
  });
});
