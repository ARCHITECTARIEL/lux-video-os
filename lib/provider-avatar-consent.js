import { createHash } from 'node:crypto';

import { stableJson } from './video-os-render-authorization.js';

export const PROVIDER_AVATAR_CONSENT_MAX_AGE_MS = 60_000;

const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ACCEPTED_AVATAR_TYPES = new Set(['photo_avatar', 'prompt_avatar', 'digital_twin']);
const trustedObservations = new WeakSet();

function eligibleGroupConsent(consentStatus, avatarType) {
  return consentStatus === 'accepted' || (consentStatus === null && avatarType === 'photo_avatar');
}

function consentError(message, statusCode = 409, failureCategory = 'CONSENT', code = 'PROVIDER_AVATAR_CONSENT_UNVERIFIED') {
  return Object.assign(new Error(message), { statusCode, failureCategory, code });
}

function readbackUnavailable(error) {
  if ([409, 410, 503].includes(error?.statusCode) && error?.failureCategory) throw error;
  throw consentError('Provider avatar consent readback is unavailable.', 503, 'PROVIDER_RESPONSE', 'PROVIDER_AVATAR_READBACK_UNAVAILABLE');
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sourceBindingDigest(sourceBinding) {
  if (!sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding)) {
    throw consentError('Provider avatar source binding is invalid.');
  }
  return createHash('sha256').update(JSON.stringify(stableJson(sourceBinding))).digest('hex');
}

function assertExactProviderConsent({ accountId, identityId, sourceBinding, providerBinding, readClaim, providerStatus }) {
  const groupId = sourceBinding?.providerAvatarGroupId;
  const lookId = sourceBinding?.providerRenderableAvatarId;
  const group = providerStatus?.avatarGroup;
  const look = providerStatus?.avatarLook;
  if (!accountId || !identityId || !PROVIDER_ID.test(String(groupId || '')) || !PROVIDER_ID.test(String(lookId || ''))
    || providerBinding?.applicationAccountId !== accountId || !providerBinding.bindingId || !providerBinding.originScopeKey || !providerBinding.verifiedAccountScopeId
    || readClaim?.accountId !== accountId || readClaim?.identityId !== identityId || readClaim?.component !== 'avatar'
    || readClaim.providerAvatarGroupId !== groupId || readClaim.providerRenderableAvatarId !== lookId
    || providerStatus?.ready !== true
    || group?.providerGroupId !== groupId || group.status !== 'completed' || !eligibleGroupConsent(group.consentStatus, look?.avatarType) || group.ready !== true
    || look?.providerGroupId !== groupId || look.providerLookId !== lookId || look.status !== 'completed' || look.ready !== true
    || !ACCEPTED_AVATAR_TYPES.has(look.avatarType)) {
    throw consentError('Provider avatar consent does not match the saved identity binding.');
  }
  return { groupId, lookId, group, look };
}

export async function observeProviderAvatarConsent({ accountId, identityId, sourceBinding }, {
  resolveProviderBinding,
  prepareProviderRead,
  readProviderAvatarStatus,
  now = Date.now,
} = {}) {
  if (![resolveProviderBinding, prepareProviderRead, readProviderAvatarStatus].every(fn => typeof fn === 'function')) {
    throw consentError('Provider avatar consent verification is not configured.', 503, 'CONFIG_MISSING', 'PROVIDER_AVATAR_CONSENT_CONFIG_MISSING');
  }
  let providerBinding;
  let readClaim;
  try {
    providerBinding = await resolveProviderBinding({ accountId });
    readClaim = await prepareProviderRead({ accountId, identityId, component: 'avatar', providerBinding });
  } catch (error) {
    readbackUnavailable(error);
  }
  let providerStatus;
  try {
    providerStatus = await readProviderAvatarStatus({
      groupId: readClaim?.providerAvatarGroupId,
      lookId: readClaim?.providerRenderableAvatarId,
    });
  } catch (error) {
    readbackUnavailable(error);
  }
  const exact = assertExactProviderConsent({ accountId, identityId, sourceBinding, providerBinding, readClaim, providerStatus });
  const observedAt = timestamp(typeof now === 'function' ? now() : now);
  if (observedAt === null) throw consentError('Provider avatar consent observation time is invalid.');
  const observation = Object.freeze({
    version: 'heygen-avatar-consent-observation/v1',
    accountId,
    identityId,
    bindingId: providerBinding.bindingId,
    originScopeKey: providerBinding.originScopeKey,
    verifiedAccountScopeId: providerBinding.verifiedAccountScopeId,
    providerAvatarGroupId: exact.groupId,
    providerRenderableAvatarId: exact.lookId,
    providerAvatarType: exact.look.avatarType,
    providerGroupStatus: exact.group.status,
    providerConsentStatus: exact.group.consentStatus,
    providerLookStatus: exact.look.status,
    sourceBindingSha256: sourceBindingDigest(sourceBinding),
    observedAt,
  });
  trustedObservations.add(observation);
  return observation;
}

export function assertFreshProviderAvatarConsentObservation(observation, {
  accountId,
  identityId,
  sourceBinding,
  now = Date.now(),
  maxAgeMs = PROVIDER_AVATAR_CONSENT_MAX_AGE_MS,
} = {}) {
  const currentTime = timestamp(typeof now === 'function' ? now() : now);
  const observedAt = timestamp(observation?.observedAt);
  const age = currentTime === null || observedAt === null ? NaN : currentTime - observedAt;
  if (!trustedObservations.has(observation)
    || observation.version !== 'heygen-avatar-consent-observation/v1'
    || observation.accountId !== accountId || observation.identityId !== identityId
    || observation.providerAvatarGroupId !== sourceBinding?.providerAvatarGroupId
    || observation.providerRenderableAvatarId !== sourceBinding?.providerRenderableAvatarId
    || observation.sourceBindingSha256 !== sourceBindingDigest(sourceBinding)
    || !eligibleGroupConsent(observation.providerConsentStatus, observation.providerAvatarType)
    || observation.providerGroupStatus !== 'completed' || observation.providerLookStatus !== 'completed'
    || !ACCEPTED_AVATAR_TYPES.has(observation.providerAvatarType)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    throw consentError('Provider avatar consent observation is stale or no longer matches the saved identity binding.');
  }
  return observation;
}
