import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';

test('providerCreationActivationStatus defaults to disabled when the env var is unset', () => {
  const status = providerCreationActivationStatus({});
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'verified_provider_account_binding_not_wired');
});

test('providerCreationActivationStatus stays disabled for values that are not "true" under trim+lowercase', () => {
  for (const value of ['1', 'yes', 'false', 'enabled', '']) {
    const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: value });
    assert.equal(status.enabled, false, `expected disabled for ${JSON.stringify(value)}`);
  }
});

test('providerCreationActivationStatus enables on "true" case-insensitively and trimmed, matching the rest of the codebase\'s flag convention (e.g. scriptedPhotoActivation)', () => {
  for (const value of ['true', 'True', 'TRUE', ' true', 'true ', ' TrUe ']) {
    const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: value });
    assert.equal(status.enabled, true, `expected enabled for ${JSON.stringify(value)}`);
    assert.equal(status.reason, 'owner_authorized_contained_activation');
  }
});

test('providerCreationActivationStatus defaults to process.env when called with no argument', () => {
  const original = process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
  const originalCanary = process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
  try {
    delete process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    assert.equal(providerCreationActivationStatus().enabled, false);
    process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED = 'true';
    assert.equal(providerCreationActivationStatus().enabled, true);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED;
    else process.env.VIDEO_OS_PROVIDER_CREATION_ENABLED = original;
    if (originalCanary === undefined) delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    else process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID = originalCanary;
  }
});

test('providerCreationActivationStatus returns a frozen object', () => {
  const status = providerCreationActivationStatus({ VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' });
  assert.ok(Object.isFrozen(status));
});

test('configured private enrollment canary prevents provider creation and rendering even if their switch is on', () => {
  const env = {
    VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'owner-account',
    VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
  };
  assert.deepEqual(providerCreationActivationStatus(env), {
    enabled: false, reason: 'private_enrollment_canary_active',
  });
  assert.equal(providerCreationActivationStatus({ ...env, VERCEL_ENV: 'preview' }).enabled, false);
  assert.equal(providerCreationActivationStatus({ VERCEL_ENV: 'preview', VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true' }).enabled, true);
});
