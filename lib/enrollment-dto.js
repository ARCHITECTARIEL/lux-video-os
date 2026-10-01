import { ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_MEDIA_CONSENT_PURPOSE, ENROLLMENT_MEDIA_LIMITS, ENROLLMENT_STATUSES } from './enrollment-policy.js';

function safeFailure(record) {
  if (!record?.failureCode) return null;
  return {
    code: String(record.failureCode).replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80),
    message: String(record.failureMessage || 'Enrollment processing failed.').slice(0, 240),
    retryable: record.attemptCount < 3 && record.status === ENROLLMENT_STATUSES.FAILED,
  };
}

function retryFor(record) {
  if (record.status === ENROLLMENT_STATUSES.AWAITING_UPLOAD) return { allowed: true, action: 'upload-instructions' };
  if (record.status === ENROLLMENT_STATUSES.FAILED && record.attemptCount < 3) return { allowed: true, action: 'retry' };
  return null;
}

function providerBridgeConsent(record, identity, { sourceMetadataVerified = false } = {}) {
  const authorizations = record.consentAuthorizations || {};
  const sourceAvailable = Boolean(sourceMetadataVerified && record.photoSha256 && record.sourceSha256 && record.derivedAudioSha256 && !record.sourceDeletedAt);
  const active = Boolean(record.consentedAt) && !record.revokedAt
    && record.consentPolicyVersion === ENROLLMENT_CONSENT_POLICY_VERSION
    && record.consentPurpose === ENROLLMENT_MEDIA_CONSENT_PURPOSE
    && record.consentedSourceSha256 === record.sourceSha256
    && authorizations.temporaryPublicProviderExposureAuthorization === true
    && authorizations.audioExtractionAuthorization === true
    && authorizations.faceAuthorization === true
    && authorizations.voiceAuthorization === true
    && authorizations.providerProcessingAuthorization === true
    && authorizations.archiveDeleteAcknowledgment === true;
  const status = record.revokedAt ? 'revoked' : !sourceAvailable && record.status === ENROLLMENT_STATUSES.IDENTITY_READY
    ? 'source_unavailable' : active ? 'active' : 'missing';
  return {
    required: true,
    status,
    policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
    temporaryPublicProviderExposureAuthorized: active,
    reconsentAvailable: status === 'missing' && sourceAvailable && record.status === ENROLLMENT_STATUSES.IDENTITY_READY
      && identity?.id === record.identityId && !identity.archivedAt,
  };
}

function providerLifecycle(record, identity) {
  const receipts = Object.values(record.providerReceipts || {});
  let state = 'not_started';
  if (record.revokedAt) state = 'removal_requested';
  else if (record.providerReconciliationStatus === 'PENDING' || record.providerReconciliationStatus === 'FAILED'
    || receipts.some(receipt => ['PENDING', 'FAILED'].includes(receipt?.status))) state = 'needs_attention';
  else if (receipts.some(receipt => ['SUBMITTING', 'ACCEPTED'].includes(receipt?.status))) state = 'preparing';
  else if (receipts.length && identity?.overallStatus === 'READY') state = 'temporary_sources_pending_removal';
  return { state, blockers: state === 'needs_attention' ? ['PROVIDER_RECONCILIATION_REQUIRED'] : [] };
}

export function enrollmentDto(record, identity = null, context = {}) {
  const source = record.sourceMetadata || {};
  return {
    id: record.id,
    status: record.status,
    stateVersion: record.stateVersion,
    displayName: record.displayName,
    photo: {
      assetId: record.photoAssetId,
      sha256: record.photoSha256,
      previewUrl: `/api/video-os-lite/asset?assetId=${encodeURIComponent(record.photoAssetId)}`,
    },
    sourceVideo: {
      state: record.sourceSha256 ? (source.fullDecode ? 'VALIDATED' : 'HASHED') : record.status === ENROLLMENT_STATUSES.AWAITING_UPLOAD ? 'PENDING' : 'PROCESSING',
      ...(record.sourceSha256 ? { sha256: record.sourceSha256 } : {}),
      ...(record.sourceBytes ? { bytes: record.sourceBytes } : {}),
      ...(source.mimeType || record.declaredContentType ? { contentType: source.mimeType || record.declaredContentType } : {}),
      ...(record.uploadEtag && !record.revokedAt && !record.sourceDeletedAt ? { previewUrl: `/api/video-os-lite/enrollments?enrollmentId=${encodeURIComponent(record.id)}&preview=video` } : {}),
      ...(['durationMs', 'width', 'height', 'videoCodec', 'audioCodec'].reduce((result, key) => source[key] === undefined ? result : { ...result, [key]: source[key] }, {})),
    },
    derivedAudio: {
      state: record.derivedAudioSha256 ? 'READY' : ['EXTRACTION_QUEUED', 'EXTRACTING'].includes(record.status) ? 'PROCESSING' : 'PENDING',
      ...(record.derivedAudioSha256 ? { sha256: record.derivedAudioSha256, bytes: record.derivedAudioBytes, contentType: 'audio/wav', durationMs: record.derivedAudioDurationMs, derivationVersion: record.derivationVersion } : {}),
    },
    consent: {
      required: true,
      status: record.revokedAt ? 'revoked' : record.consentedAt ? 'active' : 'missing',
      policyVersion: record.consentPolicyVersion || ENROLLMENT_CONSENT_POLICY_VERSION,
      purpose: record.consentPurpose || ENROLLMENT_MEDIA_CONSENT_PURPOSE,
    },
    providerBridgeConsent: providerBridgeConsent(record, identity, context),
    providerLifecycle: providerLifecycle(record, identity),
    identity: identity ? { id: identity.id, overallStatus: identity.overallStatus, avatarStatus: identity.avatarStatus, voiceStatus: identity.voiceStatus, ready: identity.overallStatus === 'READY' && !identity.archivedAt } : null,
    failure: safeFailure(record),
    providerReconciliationRequired: record.providerReconciliationStatus === 'PENDING',
    retry: retryFor(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function enrollmentCapabilitiesDto({ enabled, extractionEnabled }) {
  return {
    enabled,
    extractionEnabled,
    limits: {
      maximumSizeInBytes: ENROLLMENT_MEDIA_LIMITS.maxSourceBytes,
      minimumDurationMs: ENROLLMENT_MEDIA_LIMITS.minDurationMs,
      maximumDurationMs: ENROLLMENT_MEDIA_LIMITS.maxDurationMs,
      maximumDimension: ENROLLMENT_MEDIA_LIMITS.maxDimension,
      maximumDerivedAudioBytes: ENROLLMENT_MEDIA_LIMITS.maxAudioBytes,
    },
  };
}
