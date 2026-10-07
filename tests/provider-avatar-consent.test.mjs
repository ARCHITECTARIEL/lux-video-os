import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFreshProviderAvatarConsentObservation,
  observeProviderAvatarConsent,
} from '../lib/provider-avatar-consent.js';
import { digestScriptedPhotoSourceBinding } from '../lib/scripted-photo-quote.js';

const now = Date.parse('2026-10-07T16:00:00.000Z');
const accountId = 'provider-consent-owner';
const identityId = '22222222-2222-4222-8222-222222222222';
const sourceBinding = {
  provider: 'heygen',
  providerAvatarGroupId: 'provider-avatar-group',
  providerRenderableAvatarId: 'provider-avatar-look',
  providerVoiceId: 'provider-voice',
};
const providerBinding = {
  applicationAccountId: accountId,
  bindingId: 'verified-binding',
  originScopeKey: 'a'.repeat(64),
  verifiedAccountScopeId: 'verified-account-scope',
};
const readClaim = {
  accountId,
  identityId,
  component: 'avatar',
  providerAvatarGroupId: sourceBinding.providerAvatarGroupId,
  providerRenderableAvatarId: sourceBinding.providerRenderableAvatarId,
};

function status(consentStatus = 'accepted', overrides = {}) {
  return {
    ready: consentStatus === 'accepted',
    avatarGroup: {
      providerGroupId: sourceBinding.providerAvatarGroupId,
      status: 'completed',
      consentStatus,
      ready: true,
    },
    avatarLook: {
      providerLookId: sourceBinding.providerRenderableAvatarId,
      providerGroupId: sourceBinding.providerAvatarGroupId,
      avatarType: 'photo_avatar',
      status: 'completed',
      ready: true,
    },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    resolveProviderBinding: async () => providerBinding,
    prepareProviderRead: async () => readClaim,
    readProviderAvatarStatus: async () => status(),
    now: () => now,
    ...overrides,
  };
}

test('accepted type-aware provider consent produces a fresh exact observation', async () => {
  const observation = await observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies());
  assert.equal(observation.providerAvatarType, 'photo_avatar');
  assert.equal(observation.providerConsentStatus, 'accepted');
  assert.equal(observation.observedAt, now);
  assert.equal(observation.sourceBindingSha256, digestScriptedPhotoSourceBinding(sourceBinding));
  assert.strictEqual(assertFreshProviderAvatarConsentObservation(observation, { accountId, identityId, sourceBinding, now }), observation);
});

test('typed photo avatar with not-applicable group consent remains eligible under local source authorization', async () => {
  const photo = status(null, { ready: true });
  const observation = await observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({ readProviderAvatarStatus: async () => photo }));
  assert.equal(observation.providerAvatarType, 'photo_avatar');
  assert.equal(observation.providerConsentStatus, null);
  assert.strictEqual(assertFreshProviderAvatarConsentObservation(observation, { accountId, identityId, sourceBinding, now }), observation);
  await assert.rejects(observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({
    readProviderAvatarStatus: async () => status(null, { ready: false, avatarLook: { ...photo.avatarLook, avatarType: 'digital_twin' } }),
  })), { failureCategory: 'CONSENT' });
  await assert.rejects(observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({
    readProviderAvatarStatus: async () => status(null, { ready: false, avatarLook: { ...photo.avatarLook, avatarType: 'prompt_avatar' } }),
  })), { failureCategory: 'CONSENT' });
});

test('pending consent, group drift, stale evidence, and readback outage fail closed', async () => {
  await assert.rejects(
    observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({ readProviderAvatarStatus: async () => status('pending') })),
    { statusCode: 409, failureCategory: 'CONSENT' },
  );
  await assert.rejects(
    observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({
      prepareProviderRead: async () => ({ ...readClaim, providerAvatarGroupId: 'different-group' }),
    })),
    { statusCode: 409, failureCategory: 'CONSENT' },
  );
  const observation = await observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies());
  assert.throws(
    () => assertFreshProviderAvatarConsentObservation(observation, { accountId, identityId, sourceBinding, now: now + 60_001 }),
    { statusCode: 409, failureCategory: 'CONSENT' },
  );
  assert.throws(
    () => assertFreshProviderAvatarConsentObservation(observation, {
      accountId, identityId, sourceBinding: { ...sourceBinding, providerAvatarGroupId: 'different-group' }, now,
    }),
    { statusCode: 409, failureCategory: 'CONSENT' },
  );
  await assert.rejects(
    observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({
      readProviderAvatarStatus: async () => { throw new TypeError('network unavailable'); },
    })),
    { statusCode: 503, failureCategory: 'PROVIDER_RESPONSE' },
  );
  const disabled = Object.assign(new Error('provider disabled'), { statusCode: 503, failureCategory: 'CONFIG_MISSING', code: 'PROVIDER_DISABLED' });
  await assert.rejects(
    observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, dependencies({ readProviderAvatarStatus: async () => { throw disabled; } })),
    error => error === disabled,
  );
});
