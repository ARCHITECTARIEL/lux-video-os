import crypto from 'node:crypto';
import { get } from '@vercel/blob';
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
  recordIdentityConsent,
  recordIdentityProviderSubmission,
  reserveIdentityComponentCreation,
} from '../../db/repositories.js';
import { handleOptions, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
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

function providerEnabled(accountId) {
  try {
    assertIdentitySubmissionAllowed(accountId);
    return true;
  } catch {
    return false;
  }
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

async function ownedAssetBytes(accountId, assetId) {
  const asset = await getOwnedMediaAsset(accountId, assetId);
  if (!asset) throw Object.assign(new Error('Identity source asset not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
  const result = await get(asset.privatePathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN, useCache: false });
  if (!result?.stream) throw Object.assign(new Error('Identity source asset is unavailable.'), { statusCode: 410, failureCategory: 'PERSISTENCE' });
  const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
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

async function providerAssetFor(accountId, identity, component) {
  const assetId = component === 'avatar' ? identity.sourcePhotoAssetId : identity.sourceVoiceAssetId;
  const { asset, buffer } = await ownedAssetBytes(accountId, assetId);
  if (asset.provider === 'heygen' && asset.providerAssetId) return asset.providerAssetId;
  const uploaded = await uploadHeygenIdentityAsset({
    accountId,
    buffer,
    contentType: asset.contentType,
    filename: component === 'avatar' ? 'identity-photo' : 'identity-voice',
  });
  await attachProviderMediaAsset({ accountId, assetId: asset.id, provider: 'heygen', providerAssetId: uploaded.providerAssetId });
  return uploaded.providerAssetId;
}

export function assertIdentitySubmissionAllowed(accountId) {
  assertIdentityProviderMutationEnabled();
  assertIdentityProviderAccountAuthorized(accountId);
  return assertHeygenConfigured();
}

async function submitComponent(accountId, identityId, component) {
  assertIdentitySubmissionAllowed(accountId);
  const key = operationKey();
  const reservation = await reserveIdentityComponentCreation({ accountId, identityId, component, operationKey: key });
  if (reservation.replayed) return reservation.identity;
  const identity = reservation.identity;
  try {
    const assetId = await providerAssetFor(accountId, identity, component);
    if (component === 'avatar') {
      const created = await createHeygenPhotoAvatar({ accountId, assetId, name: identity.displayName, idempotencyKey: key });
      return recordIdentityProviderSubmission({
        accountId,
        identityId,
        component,
        operationKey: key,
        providerRequestId: created.avatarGroup.providerGroupId || created.avatarLook.providerLookId,
        providerAvatarGroupId: created.avatarGroup.providerGroupId,
        providerRenderableAvatarId: created.avatarLook.providerLookId,
      });
    }
    const created = await cloneHeygenVoice({ accountId, assetId, name: identity.displayName });
    return recordIdentityProviderSubmission({ accountId, identityId, component, operationKey: key, providerVoiceId: created.providerVoiceId });
  } catch (error) {
    if (['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'PROVIDER_SUBMIT_UNKNOWN'].includes(error.failureCategory)) throw error;
    const failure = safeFailure(error);
    await markIdentityComponentFailed({ accountId, identityId, component, operationKey: key, failureCode: failure.code, failureMessage: failure.message });
    throw Object.assign(new Error(failure.message), { statusCode: error.statusCode || 502, failureCategory: failure.code });
  }
}

async function refreshComponent(accountId, identity, component) {
  const status = component === 'avatar' ? identity.avatarStatus : identity.voiceStatus;
  if (!ACTIVE.has(status)) return identity;
  const key = component === 'avatar' ? identity.avatarOperationKey : identity.voiceOperationKey;
  try {
    const provider = component === 'avatar'
      ? await getHeygenPhotoAvatarStatus({ groupId: identity.providerAvatarGroupId, lookId: identity.providerRenderableAvatarId })
      : await getHeygenVoiceStatus(identity.providerVoiceId);
    const componentFailure = component === 'avatar'
      ? (provider.avatarLook.status === 'failed' ? provider.avatarLook : provider.avatarGroup)
      : provider;
    if (provider.failed || provider.status === 'failed') {
      return markIdentityComponentFailed({ accountId, identityId: identity.id, component, operationKey: key, failureCode: componentFailure.failureCode || 'PROVIDER_REJECTED', failureMessage: componentFailure.failureMessage || `HeyGen ${component} creation failed.` });
    }
    if (!provider.ready) return identity;
    return markIdentityComponentReady({
      accountId,
      identityId: identity.id,
      component,
      operationKey: key,
      providerAvatarGroupId: provider.avatarGroup?.providerGroupId,
      providerRenderableAvatarId: provider.avatarLook?.providerLookId,
      providerVoiceId: provider.providerVoiceId,
    });
  } catch (error) {
    if (error.providerHttpStatus && error.providerHttpStatus < 500) {
      const failure = safeFailure(error);
      return markIdentityComponentFailed({ accountId, identityId: identity.id, component, operationKey: key, failureCode: failure.code, failureMessage: failure.message });
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
  const voice = await getHeygenVoiceStatus(identity.providerVoiceId);
  if (!voice.ready || !voice.previewAudioUrl) return send(res, 409, { ok: false, error: 'Voice preview is not ready.' });
  const hostname = providerMediaHostname(voice.previewAudioUrl);
  if (!SAFE_PROVIDER_HOSTS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return send(res, 502, { ok: false, error: 'Voice preview host was rejected.' });
  const response = await fetch(voice.previewAudioUrl, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
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
        identities: identities.map(identityForClient),
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
    } else {
      throw Object.assign(new Error('Unknown identity action.'), { statusCode: 400 });
    }
    return send(res, 200, { ok: true, identity: identityForClient(identity) });
  } catch (error) {
    const status = error.statusCode || 500;
    const publicMessage = status < 500 || error.failureCategory === 'CAPABILITY_BLOCKED' ? error.message : 'Identity Studio could not complete this request.';
    return send(res, status, { ok: false, error: publicMessage, code: String(error.failureCategory || 'IDENTITY_ERROR').slice(0, 80) });
  }
}
