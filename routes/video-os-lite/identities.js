import crypto from 'node:crypto';
import { start } from 'workflow/api';
import { getPrivateBlob } from '../../lib/video-os-private-blob.js';
import {
  assertEnrollmentProviderAllowed,
  claimEnrollmentProviderOperation,
  completeEnrollmentProviderOperation,
  failEnrollmentProviderOperation,
  getLinkedEnrollmentForIdentity,
  recordEnrollmentProviderReceipt,
} from '../../db/enrollment-repository.js';
import { identityEnrollmentCleanupWorkflowMetadata } from '../../workflows/identity-enrollment-metadata.js';
import { providerCreationActivationStatus } from '../../db/provider-reconciliation-repository.js';
import {
  assertFreshHeygenSpaceBinding,
  resolveFreshHeygenSpaceBinding,
} from '../../db/heygen-space-binding-repository.js';
import {
  archiveOwnedIdentity,
  attachProviderMediaAsset,
  createIdentityDraft,
  ensureAccount,
  getOwnedIdentity,
  getOwnedMediaAsset,
  listOwnedIdentities,
  markIdentityComponentFailed,
  markIdentityComponentReady,
  prepareIdentityProviderRead,
  recordIdentityConsent,
  recordIdentityProviderSubmission,
  reserveIdentityComponentCreation,
} from '../../db/repositories.js';
import { handleOptions, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { observeProviderAvatarConsent } from '../../lib/provider-avatar-consent.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { assertPublicDns } from '../../lib/video-os-security.js';
import {
  assertHeygenConfigured,
  assertIdentityProviderAccountAuthorized,
  assertIdentityProviderMutationEnabled,
  cloneHeygenVoice,
  createHeygenPhotoAvatar,
  getHeygenPhotoAvatarStatus,
  getHeygenVoiceStatus,
  providerMediaHostname,
  uploadHeygenIdentityAsset,
} from '../../services/heygen.js';

const ACTIVE = new Set(['CREATING', 'PROCESSING']);
const SAFE_PROVIDER_HOSTS = ['heygen.ai', 'heygen.com'];
const ALLOW_TEST_DEPENDENCIES = String(process.env.NODE_TEST_CONTEXT || '').startsWith('child');
const PROVIDER_FAILURE_BINDINGS = new WeakMap();

function bindProviderFailure(error, providerBinding) {
  if (error && typeof error === 'object' && providerBinding) PROVIDER_FAILURE_BINDINGS.set(error, providerBinding);
  return error;
}

function providerEnabled(accountId) {
  try {
    assertIdentitySubmissionAllowed(accountId);
    return true;
  } catch {
    return false;
  }
}

export async function projectIdentitiesForClient(accountId, identities, {
  observeProviderConsent = observeProviderAvatarConsent,
  resolveProviderBinding = resolveFreshHeygenSpaceBinding,
  prepareProviderRead = prepareIdentityProviderRead,
  readProviderAvatarStatus = getHeygenPhotoAvatarStatus,
  providerObservationNow = Date.now,
} = {}) {
  let providerBindingPromise;
  const cachedBinding = input => {
    providerBindingPromise ||= Promise.resolve(resolveProviderBinding(input));
    return providerBindingPromise;
  };
  return Promise.all((identities || []).map(async (identity) => {
    if (identity?.overallStatus !== 'READY' || identity.archivedAt) return identityForClient(identity);
    if (identity.accountId !== accountId || identity.provider !== 'heygen'
      || !identity.providerAvatarGroupId || !identity.providerRenderableAvatarId) {
      return identityForClient({ ...identity, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING' });
    }
    try {
      await observeProviderConsent({
        accountId,
        identityId: identity.id,
        sourceBinding: {
          provider: identity.provider,
          providerAvatarGroupId: identity.providerAvatarGroupId,
          providerRenderableAvatarId: identity.providerRenderableAvatarId,
        },
      }, {
        resolveProviderBinding: cachedBinding,
        prepareProviderRead,
        readProviderAvatarStatus,
        now: providerObservationNow,
      });
      return identityForClient(identity);
    } catch {
      return identityForClient({ ...identity, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING' });
    }
  }));
}

function identityForClient(identity) {
  return {
    id: identity.id,
    displayName: identity.displayName,
    overallStatus: identity.overallStatus,
    avatarStatus: identity.avatarStatus,
    voiceStatus: identity.voiceStatus,
    portraitUrl: `/api/video-os-lite/asset?assetId=${encodeURIComponent(identity.sourcePhotoAssetId)}`,
    voicePreviewUrl: identity.voiceStatus === 'READY' ? `/api/video-os-lite/identities?voicePreview=${encodeURIComponent(identity.id)}` : null,
    avatarFailure: identity.avatarFailureCode ? { code: identity.avatarFailureCode, message: identity.avatarFailureMessage || 'Avatar creation failed.' } : null,
    voiceFailure: identity.voiceFailureCode ? { code: identity.voiceFailureCode, message: identity.voiceFailureMessage || 'Voice creation failed.' } : null,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    archivedAt: identity.archivedAt,
    ready: identity.overallStatus === 'READY' && !identity.archivedAt,
  };
}

function validateName(value) {
  const name = String(value || '').trim();
  if (name.length < 1 || name.length > 80) throw Object.assign(new Error('Identity name must be between 1 and 80 characters.'), { statusCode: 400 });
  return name;
}

function operationKey() {
  return crypto.randomUUID();
}

export function createIdentityProviderBindingBoundary(dependencies = {}) {
  const prototype = dependencies && typeof dependencies === 'object' ? Object.getPrototypeOf(dependencies) : null;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw Object.assign(new Error('Identity provider binding dependencies are invalid.'), { failureCategory: 'CONFIG_MISSING' });
  }
  if (Reflect.ownKeys(dependencies).length > 0 && !ALLOW_TEST_DEPENDENCIES) {
    throw Object.assign(new Error('Identity provider test dependencies are unavailable.'), { failureCategory: 'CONFIG_MISSING' });
  }
  const resolveBinding = dependencies.resolveFreshHeygenSpaceBinding || resolveFreshHeygenSpaceBinding;
  const claimOperation = dependencies.claimEnrollmentProviderOperation || claimEnrollmentProviderOperation;
  const assertBinding = dependencies.assertFreshHeygenSpaceBinding || assertFreshHeygenSpaceBinding;
  if (![resolveBinding, claimOperation, assertBinding].every(value => typeof value === 'function')) {
    throw Object.assign(new Error('Identity provider binding dependencies are invalid.'), { failureCategory: 'CONFIG_MISSING' });
  }
  return Object.freeze({
    async claim(input) {
      const providerBinding = await resolveBinding({ accountId: input.accountId });
      const claim = await claimOperation({ ...input, providerBinding });
      return Object.freeze({ claim, providerBinding });
    },
    mutate(providerBinding, operation) {
      if (typeof operation !== 'function') throw Object.assign(new Error('Identity provider mutation is invalid.'), { failureCategory: 'CONFIG_MISSING' });
      assertBinding(providerBinding);
      return operation();
    },
  });
}

const identityProviderBindingBoundary = createIdentityProviderBindingBoundary();

async function ownedAssetBytes(accountId, assetId, component) {
  const asset = await getOwnedMediaAsset(accountId, assetId);
  if (!asset) throw Object.assign(new Error('Identity source asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
  const expectedKind = component === 'avatar' ? 'identity-photo-source' : 'identity-voice-source';
  const allowedTypes = component === 'avatar' ? new Set(['image/jpeg', 'image/png']) : new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav']);
  const pathname = String(asset.privatePathname || '');
  const prefixAllowed = component === 'avatar'
    ? pathname.startsWith('video-os/uploads/')
    : pathname.startsWith('video-os/uploads/') || pathname.startsWith('video-os/enrollment-sources/');
  if (asset.quarantinedAt || asset.kind !== expectedKind || !allowedTypes.has(asset.contentType) || !prefixAllowed
    || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) {
    throw Object.assign(new Error('Identity source asset is unavailable.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  const result = await getPrivateBlob(asset.privatePathname);
  if (!result?.stream) throw Object.assign(new Error('Identity source asset is unavailable.'), { statusCode: 410, failureCategory: 'PERSISTENCE' });
  const chunks = [];
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of result.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > asset.bytes || bytes > 20 * 1024 * 1024) throw Object.assign(new Error('Identity source asset is unavailable.'), { statusCode: 409, failureCategory: 'CONSENT' });
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    if (typeof result.stream.destroy === 'function') result.stream.destroy();
    throw error;
  }
  if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw Object.assign(new Error('Identity source asset no longer matches its consented bytes.'), { statusCode: 409, failureCategory: 'CONSENT' });
  const buffer = Buffer.concat(chunks, bytes);
  return { asset, buffer };
}

function safeFailure(error) {
  const code = String(error.failureCategory || 'PROVIDER_REJECTED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80);
  const known = {
    PROVIDER_REJECTED: 'HeyGen rejected this component.',
    PROVIDER_RESPONSE: 'HeyGen returned an unusable response.',
    PLAN_REQUIRED: 'The connected HeyGen plan does not support this component.',
    RESOURCE_LIMIT: 'The connected HeyGen account reached its resource limit.',
  };
  return { code, message: known[code] || 'This component could not be created.' };
}

function ambiguousProviderFailure(error) {
  return ['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'PROVIDER_SUBMIT_UNKNOWN'].includes(error?.failureCategory);
}

function providerClaimFailure(message = 'Provider claim no longer matches its canonical source.') {
  return Object.assign(new Error(message), {
    statusCode: 409,
    failureCategory: 'RECONCILIATION',
    code: 'PROVIDER_CLAIM_SOURCE_MISMATCH',
  });
}

function assertEnrollmentProviderClaim(claim, { identityId, component, stage, operationKey, source }) {
  const proof = claim?.claimProof;
  const receipt = claim?.receipt;
  const canonical = proof?.source;
  if (!claim || !receipt || !proof || proof.version !== 'heygen-enrollment-provider-claim/v1'
    || typeof claim.replayed !== 'boolean'
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(receipt.ledgerOperationId || ''))
    || !['SUBMITTING', 'ACCEPTED', 'COMPLETE'].includes(receipt.status)
    || receipt.operationKey !== operationKey
    || proof.identityId !== identityId || proof.component !== component || proof.stage !== stage || proof.operationKey !== operationKey
    || proof.enrollmentId !== claim.enrollment?.id || !canonical
    || canonical.assetId !== source.assetId || canonical.sha256 !== source.sha256
    || canonical.bytes !== source.bytes || canonical.contentType !== source.contentType) {
    throw providerClaimFailure();
  }
  if ((!claim.replayed && receipt.status !== 'SUBMITTING')
    || (claim.replayed && !['ACCEPTED', 'COMPLETE'].includes(receipt.status))) {
    throw providerClaimFailure('Provider operation replay requires reconciliation.');
  }
  if (source.buffer) {
    if (!Buffer.isBuffer(source.buffer) || source.buffer.length !== canonical.bytes
      || crypto.createHash('sha256').update(source.buffer).digest('hex') !== canonical.sha256) {
      throw providerClaimFailure();
    }
  }
  const providerAssetId = canonical.providerAssetId;
  if (providerAssetId !== null && !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(providerAssetId))) throw providerClaimFailure();
  if (stage === 'create' && (!providerAssetId || providerAssetId !== source.providerAssetId)) throw providerClaimFailure();
  if (claim.replayed) {
    const ids = receipt.providerIds;
    const completeReplay = stage === 'asset'
      ? /^[A-Za-z0-9_.:-]{1,255}$/.test(String(ids?.providerAssetId || '')) && ids.providerAssetId === providerAssetId
      : component === 'avatar'
        ? /^[A-Za-z0-9_.:-]{1,255}$/.test(String(ids?.providerAvatarGroupId || ''))
          && /^[A-Za-z0-9_.:-]{1,255}$/.test(String(ids?.providerRenderableAvatarId || ''))
        : /^[A-Za-z0-9_.:-]{1,255}$/.test(String(ids?.providerVoiceId || ''));
    if (!completeReplay) throw providerClaimFailure('Provider operation replay requires reconciliation.');
  }
  return Object.freeze({
    assetId: canonical.assetId,
    sha256: canonical.sha256,
    bytes: canonical.bytes,
    contentType: canonical.contentType,
    providerAssetId,
  });
}

export function assertIdentityProviderReadClaim(readClaim, { accountId, identityId, component }) {
  const providerId = value => /^[A-Za-z0-9_.:-]{1,255}$/.test(String(value || ''));
  const avatar = component === 'avatar';
  const expectedResourceCount = avatar ? 2 : 1;
  if (!readClaim || !Object.isFrozen(readClaim) || readClaim.version !== 'heygen-identity-read-claim/v1'
    || readClaim.accountId !== accountId || readClaim.identityId !== identityId || readClaim.component !== component
    || !providerId(readClaim.operationKey) || !Array.isArray(readClaim.resourceIds)
    || !Object.isFrozen(readClaim.resourceIds) || readClaim.resourceIds.length !== expectedResourceCount
    || readClaim.resourceIds.some(resourceId => !providerId(resourceId))
    || (avatar && (!providerId(readClaim.providerAvatarGroupId) || !providerId(readClaim.providerRenderableAvatarId) || readClaim.providerVoiceId !== null))
    || (!avatar && (!providerId(readClaim.providerVoiceId) || readClaim.providerAvatarGroupId !== null || readClaim.providerRenderableAvatarId !== null))) {
    throw providerClaimFailure('Provider identity read claim is invalid.');
  }
  return readClaim;
}

async function providerAssetFor(accountId, identity, component, operationKey) {
  const assetId = component === 'avatar' ? identity.sourcePhotoAssetId : identity.sourceVoiceAssetId;
  const { asset, buffer } = await ownedAssetBytes(accountId, assetId, component);
  let providerBinding;
  try {
    const claimed = await identityProviderBindingBoundary.claim({ accountId, identityId: identity.id, component, stage: 'asset', operationKey });
    ({ providerBinding } = claimed);
    const { claim } = claimed;
  let canonicalSource;
  try {
    canonicalSource = assertEnrollmentProviderClaim(claim, {
      identityId: identity.id,
      component,
      stage: 'asset',
      operationKey,
      source: { assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes, contentType: asset.contentType, buffer },
    });
  } catch (error) {
    await failEnrollmentProviderOperation({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding, ambiguous: false }).catch(() => {});
    throw error;
  }
  const priorProviderAssetId = canonicalSource.providerAssetId;
  if (priorProviderAssetId) {
    const receipt = await recordEnrollmentProviderReceipt({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding, providerIds: { providerAssetId: priorProviderAssetId } });
    if (receipt.orphaned) throw Object.assign(new Error('Provider asset requires deletion after enrollment revocation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    if (asset.providerAssetId !== priorProviderAssetId) await attachProviderMediaAsset({ accountId, assetId: canonicalSource.assetId, provider: 'heygen', providerAssetId: priorProviderAssetId, consumerIdentityId: identity.id, providerBinding });
    await completeEnrollmentProviderOperation({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding });
    return Object.freeze({ ...canonicalSource, providerAssetId: priorProviderAssetId });
  }
  let uploaded;
  try {
    uploaded = await identityProviderBindingBoundary.mutate(providerBinding, () => uploadHeygenIdentityAsset({
      accountId,
      buffer,
      contentType: asset.contentType,
      filename: component === 'avatar' ? 'identity-photo' : 'identity-voice',
    }));
  } catch (error) {
    await failEnrollmentProviderOperation({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding, ambiguous: ambiguousProviderFailure(error) }).catch(() => {});
    throw error;
  }
  const receipt = await recordEnrollmentProviderReceipt({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding, providerIds: { providerAssetId: uploaded.providerAssetId } });
  if (receipt.orphaned) throw Object.assign(new Error('Provider asset requires deletion after enrollment revocation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  try {
    await attachProviderMediaAsset({ accountId, assetId: canonicalSource.assetId, provider: 'heygen', providerAssetId: uploaded.providerAssetId, consumerIdentityId: identity.id, providerBinding });
    await completeEnrollmentProviderOperation({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding });
    return Object.freeze({ ...canonicalSource, providerAssetId: uploaded.providerAssetId });
  } catch (error) {
    await failEnrollmentProviderOperation({ accountId, identityId: identity.id, component, stage: 'asset', operationKey, providerBinding, ambiguous: true }).catch(() => {});
    throw error;
  }
  } catch (error) {
    throw bindProviderFailure(error, providerBinding);
  }
}

export function assertIdentitySubmissionAllowed(accountId) {
  assertIdentityProviderMutationEnabled();
  assertIdentityProviderAccountAuthorized(accountId);
  assertHeygenConfigured();
  if (providerCreationActivationStatus().enabled !== true) {
    throw Object.assign(new Error('Identity provider creation is not activated.'), {
      statusCode: 503,
      failureCategory: 'IDENTITY_PROVIDER_DISABLED',
    });
  }
  return true;
}

async function submitComponent(accountId, identityId, component) {
  assertIdentitySubmissionAllowed(accountId);
  await assertEnrollmentProviderAllowed(accountId, identityId);
  const key = operationKey();
  const reservationBinding = await resolveFreshHeygenSpaceBinding({ accountId });
  const reservation = await reserveIdentityComponentCreation({ accountId, identityId, component, operationKey: key, providerBinding: reservationBinding });
  if (reservation.replayed) return reservation.identity;
  const identity = reservation.identity;
  let componentProviderBinding = reservationBinding;
  try {
    const providerAsset = await providerAssetFor(accountId, identity, component, key);
    if (component === 'avatar') {
      const claimed = await identityProviderBindingBoundary.claim({ accountId, identityId, component, stage: 'create', operationKey: key });
      const { claim, providerBinding } = claimed;
      componentProviderBinding = providerBinding;
      let canonicalSource;
      try {
        canonicalSource = assertEnrollmentProviderClaim(claim, {
          identityId,
          component,
          stage: 'create',
          operationKey: key,
          source: providerAsset,
        });
      } catch (error) {
        await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: false }).catch(() => {});
        throw error;
      }
      let providerIds = claim.receipt.providerIds;
      if (!providerIds?.providerAvatarGroupId || !providerIds?.providerRenderableAvatarId) {
        let created;
        try { created = await identityProviderBindingBoundary.mutate(providerBinding, () => createHeygenPhotoAvatar({ accountId, assetId: canonicalSource.providerAssetId, name: identity.displayName, idempotencyKey: key })); } catch (error) {
          await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: ambiguousProviderFailure(error) }).catch(() => {});
          throw error;
        }
        providerIds = {
          providerRequestId: created.avatarGroup.providerGroupId || created.avatarLook.providerLookId,
          providerAvatarGroupId: created.avatarGroup.providerGroupId,
          providerRenderableAvatarId: created.avatarLook.providerLookId,
        };
        const receipt = await recordEnrollmentProviderReceipt({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, providerIds });
        if (receipt.orphaned) throw Object.assign(new Error('Provider avatar requires deletion after enrollment revocation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      try {
        const updated = await recordIdentityProviderSubmission({ accountId, identityId, component, operationKey: key, providerBinding, ...providerIds });
        await completeEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding });
        return updated;
      } catch (error) {
        await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: true }).catch(() => {});
        throw error;
      }
    }
    const claimed = await identityProviderBindingBoundary.claim({ accountId, identityId, component, stage: 'create', operationKey: key });
    const { claim, providerBinding } = claimed;
    componentProviderBinding = providerBinding;
    let canonicalSource;
    try {
      canonicalSource = assertEnrollmentProviderClaim(claim, {
        identityId,
        component,
        stage: 'create',
        operationKey: key,
        source: providerAsset,
      });
    } catch (error) {
      await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: false }).catch(() => {});
      throw error;
    }
    let providerVoiceId = claim.receipt.providerIds?.providerVoiceId;
    if (!providerVoiceId) {
      let created;
      try { created = await identityProviderBindingBoundary.mutate(providerBinding, () => cloneHeygenVoice({ accountId, assetId: canonicalSource.providerAssetId, name: identity.displayName })); } catch (error) {
        await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: ambiguousProviderFailure(error) }).catch(() => {});
        throw error;
      }
      providerVoiceId = created.providerVoiceId;
      const receipt = await recordEnrollmentProviderReceipt({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, providerIds: { providerVoiceId } });
      if (receipt.orphaned) throw Object.assign(new Error('Provider voice requires deletion after enrollment revocation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
    }
    try {
      const updated = await recordIdentityProviderSubmission({ accountId, identityId, component, operationKey: key, providerVoiceId, providerBinding });
      await completeEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding });
      return updated;
    } catch (error) {
      await failEnrollmentProviderOperation({ accountId, identityId, component, stage: 'create', operationKey: key, providerBinding, ambiguous: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'PROVIDER_SUBMIT_UNKNOWN'].includes(error.failureCategory)) throw error;
    const failure = safeFailure(error);
    const providerBinding = PROVIDER_FAILURE_BINDINGS.get(error) || componentProviderBinding;
    if (providerBinding) {
      await markIdentityComponentFailed({ accountId, identityId, component, operationKey: key, failureCode: failure.code, failureMessage: failure.message, providerBinding });
    }
    throw Object.assign(new Error(failure.message), { statusCode: error.statusCode || 502, failureCategory: failure.code });
  }
}

async function refreshComponent(accountId, identity, component) {
  const status = component === 'avatar' ? identity.avatarStatus : identity.voiceStatus;
  if (!ACTIVE.has(status)) return identity;
  const key = component === 'avatar' ? identity.avatarOperationKey : identity.voiceOperationKey;
  let providerBinding;
  let readClaim;
  try {
    providerBinding = await resolveFreshHeygenSpaceBinding({ accountId });
    readClaim = assertIdentityProviderReadClaim(
      await prepareIdentityProviderRead({ accountId, identityId: identity.id, component, providerBinding }),
      { accountId, identityId: identity.id, component },
    );
    const provider = component === 'avatar'
      ? await identityProviderBindingBoundary.mutate(providerBinding, () => getHeygenPhotoAvatarStatus({ groupId: readClaim.providerAvatarGroupId, lookId: readClaim.providerRenderableAvatarId }))
      : await identityProviderBindingBoundary.mutate(providerBinding, () => getHeygenVoiceStatus(readClaim.providerVoiceId));
    const componentFailure = component === 'avatar'
      ? (provider.avatarLook.status === 'failed' ? provider.avatarLook : provider.avatarGroup)
      : provider;
    if (provider.failed || provider.status === 'failed') {
      return markIdentityComponentFailed({ accountId, identityId: identity.id, component, operationKey: readClaim.operationKey, failureCode: componentFailure.failureCode || 'PROVIDER_REJECTED', failureMessage: componentFailure.failureMessage || `HeyGen ${component} creation failed.`, providerBinding });
    }
    if (!provider.ready) return identity;
    return markIdentityComponentReady({
      accountId,
      identityId: identity.id,
      component,
      operationKey: readClaim.operationKey,
      providerAvatarGroupId: provider.avatarGroup?.providerGroupId,
      providerRenderableAvatarId: provider.avatarLook?.providerLookId,
      providerVoiceId: provider.providerVoiceId,
      providerBinding,
    });
  } catch (error) {
    if (providerBinding && error.providerHttpStatus && error.providerHttpStatus < 500) {
      const failure = safeFailure(error);
      return markIdentityComponentFailed({ accountId, identityId: identity.id, component, operationKey: readClaim.operationKey, failureCode: failure.code, failureMessage: failure.message, providerBinding });
    }
    throw error;
  }
}

async function refreshIdentity(accountId, identityId) {
  let identity = await getOwnedIdentity(accountId, identityId);
  if (!identity || identity.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404 });
  identity = await refreshComponent(accountId, identity, 'avatar');
  identity = await getOwnedIdentity(accountId, identityId);
  identity = await refreshComponent(accountId, identity, 'voice');
  return getOwnedIdentity(accountId, identityId);
}

async function proxyVoicePreview(res, accountId, identityId) {
  const identity = await getOwnedIdentity(accountId, identityId);
  if (!identity || identity.archivedAt || identity.voiceStatus !== 'READY' || !identity.providerVoiceId) return send(res, 404, { ok: false, error: 'Voice preview not found.' });
  const providerBinding = await resolveFreshHeygenSpaceBinding({ accountId });
  const readClaim = assertIdentityProviderReadClaim(
    await prepareIdentityProviderRead({ accountId, identityId, component: 'voice', providerBinding }),
    { accountId, identityId, component: 'voice' },
  );
  const voice = await identityProviderBindingBoundary.mutate(providerBinding, () => getHeygenVoiceStatus(readClaim.providerVoiceId));
  if (!voice.ready || !voice.previewAudioUrl) return send(res, 409, { ok: false, error: 'Voice preview is not ready.' });
  const previewUrl = new URL(voice.previewAudioUrl);
  const hostname = providerMediaHostname(previewUrl);
  if (!SAFE_PROVIDER_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return send(res, 502, { ok: false, error: 'Voice preview host was rejected.' });
  try {
    await assertPublicDns(previewUrl);
  } catch {
    return send(res, 502, { ok: false, error: 'Voice preview host was rejected.' });
  }
  const response = await fetch(previewUrl, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!response.ok || !response.body) return send(res, 502, { ok: false, error: 'Voice preview is unavailable.' });
  res.statusCode = 200;
  res.setHeader('Content-Type', String(response.headers.get('content-type') || 'audio/mpeg').split(';')[0]);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for await (const chunk of response.body) res.write(chunk);
  res.end();
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  try {
    const session = sessionFromRequest(req);
    if (req.method === 'GET') {
      const url = new URL(req.url, 'https://video-os.invalid');
      const voicePreview = url.searchParams.get('voicePreview');
      if (voicePreview) return proxyVoicePreview(res, session.accountId, voicePreview);
      const identities = await listOwnedIdentities(session.accountId);
      return send(res, 200, {
        ok: true,
        identities: await projectIdentitiesForClient(session.accountId, identities),
        consentPolicyVersion: IDENTITY_CONSENT_POLICY_VERSION,
        providerSubmissionEnabled: providerEnabled(session.accountId),
      });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email, initialCredits: 0 });
    let identity;
    if (body.action === 'create') {
      identity = await createIdentityDraft({ accountId: session.accountId, displayName: validateName(body.displayName), sourcePhotoAssetId: body.photoAssetId, sourceVoiceAssetId: body.voiceAssetId });
    } else if (body.action === 'consent') {
      const result = await recordIdentityConsent({
        accountId: session.accountId,
        identityId: body.identityId,
        policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
        faceAuthorization: body.faceAuthorization === true,
        voiceAuthorization: body.voiceAuthorization === true,
        providerProcessingAuthorization: body.providerProcessingAuthorization === true,
        archiveDeleteAcknowledgment: body.archiveDeleteAcknowledgment === true,
      });
      identity = await getOwnedIdentity(session.accountId, result.consent.identityId);
    } else if (body.action === 'submit') {
      const current = await getOwnedIdentity(session.accountId, body.identityId);
      if (!current || current.archivedAt) throw Object.assign(new Error('Identity not found.'), { statusCode: 404 });
      const draftComponents = ['avatar', 'voice'].filter((component) => current[`${component}Status`] === 'DRAFT');
      for (const component of draftComponents) {
        try {
          await submitComponent(session.accountId, body.identityId, component);
        } catch (error) {
          if (['IDENTITY_PROVIDER_DISABLED', 'IDENTITY_ASSET_PRIVACY_UNCONFIRMED', 'CONFIG_MISSING', 'ENTITLEMENT', 'CONSENT', 'OWNERSHIP', 'VALIDATION'].includes(error.failureCategory)) throw error;
          // A contained component-level provider failure must not prevent its
          // sibling from reaching its own durable terminal state.
        }
      }
      identity = await getOwnedIdentity(session.accountId, body.identityId);
    } else if (body.action === 'refresh') {
      identity = await refreshIdentity(session.accountId, body.identityId);
    } else if (body.action === 'retry') {
      if (!['avatar', 'voice'].includes(body.component)) throw Object.assign(new Error('Choose the failed component to retry.'), { statusCode: 400 });
      const current = await getOwnedIdentity(session.accountId, body.identityId);
      if (!current || current[`${body.component}Status`] !== 'FAILED') throw Object.assign(new Error('Only a failed identity component can be retried.'), { statusCode: 409 });
      identity = await submitComponent(session.accountId, body.identityId, body.component);
    } else if (body.action === 'archive') {
      identity = await archiveOwnedIdentity(session.accountId, body.identityId);
      const linked = await getLinkedEnrollmentForIdentity(session.accountId, body.identityId);
      if (linked?.cleanupStatus === 'PENDING') await start(identityEnrollmentCleanupWorkflowMetadata, [linked.id]).catch(() => {});
    } else {
      throw Object.assign(new Error('Unknown identity action.'), { statusCode: 400 });
    }
    return send(res, 200, { ok: true, identity: (await projectIdentitiesForClient(session.accountId, [identity]))[0] });
  } catch (error) {
    const status = error.statusCode || 500;
    const publicMessage = status < 500 || error.failureCategory === 'CAPABILITY_BLOCKED' ? error.message : 'Identity Studio could not complete this request.';
    return send(res, status, { ok: false, error: publicMessage, code: String(error.failureCategory || 'IDENTITY_ERROR').slice(0, 80) });
  }
}
