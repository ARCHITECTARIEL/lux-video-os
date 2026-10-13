import assert from 'node:assert/strict';
import test from 'node:test';

import { projectIdentitiesForClient } from '../routes/video-os-lite/identities.js';

const accountId = 'identity-list-owner';
const identity = {
  id: '22222222-2222-4222-8222-222222222222',
  accountId,
  provider: 'heygen',
  displayName: 'Persisted ready identity',
  overallStatus: 'READY',
  avatarStatus: 'READY',
  voiceStatus: 'READY',
  providerAvatarGroupId: 'provider-avatar-group',
  providerRenderableAvatarId: 'provider-avatar-look',
  providerVoiceId: 'provider-voice',
  sourcePhotoAssetId: '33333333-3333-4333-8333-333333333333',
  archivedAt: null,
};

function dependencies(overrides = {}) {
  return {
    resolveProviderBinding: async () => ({ applicationAccountId: accountId, bindingId: 'verified-binding', originScopeKey: 'a'.repeat(64), verifiedAccountScopeId: 'verified-account-scope' }),
    prepareProviderRead: async () => ({
      accountId,
      identityId: identity.id,
      component: 'avatar',
      providerAvatarGroupId: identity.providerAvatarGroupId,
      providerRenderableAvatarId: identity.providerRenderableAvatarId,
    }),
    readProviderAvatarStatus: async () => ({
      ready: true,
      avatarGroup: { providerGroupId: identity.providerAvatarGroupId, status: 'completed', consentStatus: 'accepted', ready: true },
      avatarLook: { providerLookId: identity.providerRenderableAvatarId, providerGroupId: identity.providerAvatarGroupId, avatarType: 'photo_avatar', status: 'completed', ready: true },
    }),
    ...overrides,
  };
}

test('persisted READY projects ready only after exact accepted provider consent readback', async () => {
  const [projection] = await projectIdentitiesForClient(accountId, [identity], dependencies());
  assert.equal(projection.ready, true);
  assert.equal(projection.overallStatus, 'READY');
  assert.equal(projection.avatarStatus, 'READY');
  assert.equal(JSON.stringify(projection).includes(identity.providerAvatarGroupId), false);
  assert.equal(JSON.stringify(projection).includes(identity.providerRenderableAvatarId), false);
});

test('pending consent, group drift, and readback outage downgrade persisted READY in the projection only', async () => {
  const cases = [
    {
      readProviderAvatarStatus: async () => ({
        ready: false,
        avatarGroup: { providerGroupId: identity.providerAvatarGroupId, status: 'completed', consentStatus: 'pending', ready: true },
        avatarLook: { providerLookId: identity.providerRenderableAvatarId, providerGroupId: identity.providerAvatarGroupId, avatarType: 'photo_avatar', status: 'completed', ready: true },
      }),
    },
    {
      prepareProviderRead: async () => ({
        accountId, identityId: identity.id, component: 'avatar', providerAvatarGroupId: 'different-group', providerRenderableAvatarId: identity.providerRenderableAvatarId,
      }),
    },
    {
      readProviderAvatarStatus: async () => { throw new TypeError('provider unavailable'); },
    },
  ];
  for (const overrides of cases) {
    const [projection] = await projectIdentitiesForClient(accountId, [identity], dependencies(overrides));
    assert.equal(projection.ready, false);
    assert.equal(projection.overallStatus, 'PROCESSING');
    assert.equal(projection.avatarStatus, 'PROCESSING');
    assert.equal(identity.overallStatus, 'READY', 'read projection must not rewrite persisted state');
  }
});

test('non-ready identities do not trigger provider readback', async () => {
  let calls = 0;
  const [projection] = await projectIdentitiesForClient(accountId, [{ ...identity, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING' }], dependencies({
    resolveProviderBinding: async () => { calls++; throw new Error('must not run'); },
  }));
  assert.equal(calls, 0);
  assert.equal(projection.ready, false);
  assert.equal(projection.overallStatus, 'PROCESSING');
});
