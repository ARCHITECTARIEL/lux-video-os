import crypto from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { database } from './client.js';
import { identityConsents, identityEnrollmentEvents, identityVideoEnrollments, mediaAssets, userIdentities } from './schema.js';
import {
  ENROLLMENT_CONSENT_POLICY_VERSION,
  ENROLLMENT_CONTRACT_VERSION,
  ENROLLMENT_MAX_ATTEMPTS,
  ENROLLMENT_MEDIA_CONSENT_PURPOSE,
  ENROLLMENT_STATUSES,
  ENROLLMENT_UPLOAD_VALIDITY_MS,
  LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION,
  assertEnrollmentTransition,
  assertEnrollmentCanaryRecord,
  assertEnrollmentCanaryPhoto,
  enrollmentFailureIsRetryable,
  enrollmentNeedsTerminalCleanup,
  safeEnrollmentFilename,
} from '../lib/enrollment-policy.js';
import { accountHash } from '../lib/video-os-security.js';
import { acquireProviderLifecycleLock } from './provider-lifecycle-lock.js';
import { assertFreshHeygenProviderClaimTx, assertHeygenProviderReceiptTx, withFreshHeygenSpaceBindingTransaction, withHeygenSpaceBindingReceiptTransaction } from './heygen-space-binding-repository.js';
import { assertProviderReceiptOperationTx, attachProviderConsumerReferenceTx, getExactProviderResourceTx, providerOperationRequestDigest, recordProviderOperationFailureTx, recordProviderOperationResourcesTx, reserveProviderOperationTx } from './provider-reconciliation-repository.js';

function failure(message, statusCode = 409, failureCategory = 'RECONCILIATION', code = failureCategory) {
  return Object.assign(new Error(message), { statusCode, failureCategory, code });
}

function stableUuid(namespace, label) {
  const bytes = crypto.createHash('sha256').update(`${namespace}\0${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedFailure(value, fallback) {
  return String(value || fallback).replace(/[^A-Za-z0-9 _.,:;!?()'"+\-_/]/g, '').slice(0, 240) || fallback;
}

function assertPhotoAsset(photo, accountId, assetId) {
  if (!photo || photo.id !== assetId || photo.accountId !== accountId) throw failure('Identity photo was not found.', 404, 'OWNERSHIP', 'PHOTO_NOT_FOUND');
  if (photo.quarantinedAt || photo.kind !== 'identity-photo-source' || !['image/jpeg', 'image/png'].includes(photo.contentType)
    || !String(photo.privatePathname || '').startsWith('video-os/uploads/')) {
    throw failure('Identity photo is unavailable.', 409, 'CONSENT', 'PHOTO_UNAVAILABLE');
  }
  return photo;
}

export function assertEnrollmentConsentRecord(enrollment, { requireProviderExposure = false } = {}) {
  const authorizations = enrollment?.consentAuthorizations || {};
  const supportedPolicy = [LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_CONSENT_POLICY_VERSION].includes(enrollment?.consentPolicyVersion);
  const providerExposure = enrollment?.consentPolicyVersion === ENROLLMENT_CONSENT_POLICY_VERSION
    && authorizations.temporaryPublicProviderExposureAuthorization === true;
  if (!enrollment?.consentedAt || enrollment.revokedAt
    || !supportedPolicy || (requireProviderExposure && !providerExposure)
    || enrollment.consentPurpose !== ENROLLMENT_MEDIA_CONSENT_PURPOSE
    || enrollment.consentedSourceSha256 !== enrollment.sourceSha256
    || ![authorizations.audioExtractionAuthorization, authorizations.faceAuthorization, authorizations.voiceAuthorization,
      authorizations.providerProcessingAuthorization, authorizations.archiveDeleteAcknowledgment].every(value => value === true)) {
    throw failure('Enrollment consent is incomplete or no longer active.', 409, 'CONSENT', 'ENROLLMENT_CONSENT_INACTIVE');
  }
  return true;
}

async function event(tx, enrollment, eventType, stateFrom, stateTo, details = {}, failureCode = null) {
  await tx.insert(identityEnrollmentEvents).values({
    enrollmentId: enrollment.id,
    correlationId: enrollment.correlationId,
    eventType,
    stateFrom,
    stateTo,
    failureCode,
    details,
  });
}

function sameCreate(existing, input) {
  return existing.contractVersion === ENROLLMENT_CONTRACT_VERSION && existing.displayName === input.displayName
    && existing.photoAssetId === input.photoAssetId && existing.declaredFilename === input.filename
    && existing.declaredContentType === input.contentType && existing.declaredBytes === input.bytes;
}

export async function createEnrollment({ accountId, correlationId, input, now = new Date() }) {
  return database().transaction(async tx => {
    const existing = (await tx.select().from(identityVideoEnrollments).where(and(
      eq(identityVideoEnrollments.accountId, accountId),
      eq(identityVideoEnrollments.idempotencyKey, input.idempotencyKey),
    )).for('update').limit(1))[0];
    if (existing) {
      assertEnrollmentCanaryRecord(existing);
      if (!sameCreate(existing, input)) throw failure('Enrollment idempotency key belongs to a different request.', 409, 'RECONCILIATION', 'IDEMPOTENCY_CONFLICT');
      const replayPhoto = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, input.photoAssetId))).for('share').limit(1))[0];
      assertPhotoAsset(replayPhoto, accountId, input.photoAssetId);
      assertEnrollmentCanaryPhoto(replayPhoto);
      if (replayPhoto.sha256 !== existing.photoSha256) throw failure('Enrollment photo no longer matches its frozen source.', 409, 'CONSENT', 'PHOTO_SOURCE_MISMATCH');
      return { enrollment: existing, replayed: true };
    }
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.accountId, accountId), eq(mediaAssets.id, input.photoAssetId))).for('share').limit(1))[0];
    assertPhotoAsset(photo, accountId, input.photoAssetId);
    assertEnrollmentCanaryPhoto(photo);
    const id = crypto.randomUUID();
    const operationKey = crypto.randomUUID();
    const filename = safeEnrollmentFilename(input.filename, input.contentType);
    const uploadPathname = `video-os/enrollment-sources/${accountHash(accountId)}/${id}/${filename}`;
    const [enrollment] = await tx.insert(identityVideoEnrollments).values({
      id,
      accountId,
      idempotencyKey: input.idempotencyKey,
      correlationId,
      contractVersion: ENROLLMENT_CONTRACT_VERSION,
      status: ENROLLMENT_STATUSES.AWAITING_UPLOAD,
      stateVersion: 1,
      displayName: input.displayName,
      photoAssetId: input.photoAssetId,
      photoSha256: photo.sha256,
      declaredFilename: filename,
      declaredContentType: input.contentType,
      declaredBytes: input.bytes,
      uploadPathname,
      uploadOperationKey: operationKey,
      uploadExpiresAt: new Date(now.getTime() + ENROLLMENT_UPLOAD_VALIDITY_MS),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    }).returning();
    await event(tx, enrollment, 'enrollment.created', null, enrollment.status, { declaredBytes: input.bytes, contentType: input.contentType });
    return { enrollment, replayed: false };
  });
}

export async function getOwnedEnrollment(accountId, enrollmentId) {
  return (await database().select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).limit(1))[0] || null;
}

export async function listOwnedEnrollments(accountId, limit = 20) {
  return database().select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.accountId, accountId)).orderBy(desc(identityVideoEnrollments.updatedAt)).limit(Math.min(50, Math.max(1, limit)));
}

export async function authorizeEnrollmentUpload({ accountId, enrollmentId, operationKey, pathname, now = new Date() }) {
  return database().transaction(async tx => {
    const enrollment = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).for('update').limit(1))[0];
    if (!enrollment) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    if (enrollment.status !== ENROLLMENT_STATUSES.AWAITING_UPLOAD || enrollment.revokedAt || enrollment.uploadOperationKey !== operationKey
      || enrollment.uploadPathname !== pathname || new Date(enrollment.uploadExpiresAt) <= now) {
      throw failure('Enrollment upload instructions are no longer valid.', 409, 'RECONCILIATION', 'UPLOAD_INSTRUCTIONS_INVALID');
    }
    return enrollment;
  });
}

export async function getEnrollmentForUploadCallback(enrollmentId, operationKey) {
  const enrollment = (await database().select().from(identityVideoEnrollments).where(and(
    eq(identityVideoEnrollments.id, enrollmentId), eq(identityVideoEnrollments.uploadOperationKey, operationKey),
  )).limit(1))[0];
  if (!enrollment) throw failure('Enrollment upload callback is invalid.', 404, 'OWNERSHIP', 'UPLOAD_CALLBACK_INVALID');
  return enrollment;
}

export async function claimEnrollmentWorkflowDispatch(enrollmentId, operationKey, now = new Date()) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.workflowOperationKey !== operationKey || current.revokedAt) throw failure('Enrollment workflow dispatch is stale.', 409, 'RECONCILIATION', 'DISPATCH_REJECTED');
    if (current.workflowRunId && !String(current.workflowRunId).startsWith('dispatching:')) return { enrollment: current, claimed: false, dispatched: true };
    if (String(current.workflowRunId || '').startsWith('dispatching:') && current.leaseExpiresAt && new Date(current.leaseExpiresAt) > now) return { enrollment: current, claimed: false, dispatched: false };
    const claim = `dispatching:${crypto.randomUUID()}`;
    const [updated] = await tx.update(identityVideoEnrollments).set({ workflowRunId: claim, updatedAt: now }).where(eq(identityVideoEnrollments.id, current.id)).returning();
    await event(tx, current, 'enrollment.workflow_dispatch_claimed', current.status, current.status, {});
    return { enrollment: updated, claimed: true, dispatchClaim: claim };
  });
}

export async function recordEnrollmentWorkflowRun(enrollmentId, operationKey, dispatchClaim, workflowRunId, now = new Date()) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.workflowOperationKey !== operationKey || current.workflowRunId !== dispatchClaim || !String(workflowRunId || '').trim()) throw failure('Enrollment workflow run does not match its dispatch claim.', 409, 'RECONCILIATION', 'DISPATCH_RUN_CONFLICT');
    const [updated] = await tx.update(identityVideoEnrollments).set({ workflowRunId: String(workflowRunId).slice(0, 255), updatedAt: now }).where(eq(identityVideoEnrollments.id, current.id)).returning();
    await event(tx, current, 'enrollment.workflow_dispatched', current.status, current.status, {});
    return updated;
  });
}

export async function acceptEnrollmentUpload({ enrollmentId, operationKey, pathname, etag, contentType, now = new Date() }) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    if (current.status === ENROLLMENT_STATUSES.SOURCE_HASHING && current.uploadEtag === etag) return { enrollment: current, dispatch: false, replayed: true };
    if (current.status !== ENROLLMENT_STATUSES.AWAITING_UPLOAD || current.revokedAt || current.uploadOperationKey !== operationKey
      || current.uploadPathname !== pathname || current.declaredContentType !== contentType || !etag || new Date(current.uploadExpiresAt) <= now) {
      throw failure('Completed upload does not match its enrollment.', 409, 'RECONCILIATION', 'UPLOAD_COMPLETION_MISMATCH');
    }
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.SOURCE_HASHING);
    const workflowOperationKey = crypto.randomUUID();
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.SOURCE_HASHING,
      stateVersion: current.stateVersion + 1,
      uploadEtag: etag,
      workflowOperationKey,
      workflowRunId: null,
      leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      attemptCount: current.attemptCount + 1,
      cleanupStatus: 'PENDING',
      updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment upload completion lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.upload_completed', current.status, updated.status, { contentType }, null);
    return { enrollment: updated, dispatch: true, replayed: false };
  });
}

export async function claimEnrollmentHash(enrollmentId, operationKey) {
  return database().transaction(async tx => {
    const row = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!row || row.status !== ENROLLMENT_STATUSES.SOURCE_HASHING || row.workflowOperationKey !== operationKey || row.revokedAt) throw failure('Enrollment hash operation is not claimable.', 409, 'RECONCILIATION', 'HASH_CLAIM_REJECTED');
    return row;
  });
}

export async function completeEnrollmentHash({ enrollmentId, operationKey, sha256, bytes, now = new Date() }) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.status !== ENROLLMENT_STATUSES.SOURCE_HASHING || current.workflowOperationKey !== operationKey || current.revokedAt) throw failure('Enrollment hash completion is stale.', 409, 'RECONCILIATION', 'HASH_COMPLETION_REJECTED');
    if (!/^[a-f0-9]{64}$/.test(sha256) || bytes !== current.declaredBytes) throw failure('Enrollment upload bytes do not match the declared source.', 422, 'VALIDATION', 'SOURCE_IDENTITY_MISMATCH');
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.AWAITING_CONSENT);
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.AWAITING_CONSENT, stateVersion: current.stateVersion + 1,
      sourceSha256: sha256, sourceBytes: bytes, workflowOperationKey: null, leaseExpiresAt: null,
      failureCode: null, failureMessage: null, updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment hash completion lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.source_hashed', current.status, updated.status, { bytes, sha256 });
    return updated;
  });
}

export async function grantEnrollmentConsent({ accountId, input, now = new Date() }) {
  return database().transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    const current = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, input.enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).for('update').limit(1))[0];
    if (!current) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    if (current.consentedAt && current.consentIdempotencyKey === input.idempotencyKey) {
      if (current.consentedSourceSha256 !== input.sourceVideoSha256) throw failure('Enrollment consent replay conflicts with its source.', 409, 'RECONCILIATION', 'CONSENT_REPLAY_CONFLICT');
      return { enrollment: current, dispatch: false, replayed: true };
    }
    if (current.status !== ENROLLMENT_STATUSES.AWAITING_CONSENT || current.stateVersion !== input.expectedStateVersion || current.revokedAt
      || current.sourceSha256 !== input.sourceVideoSha256) throw failure('Enrollment consent does not match the verified source.', 409, 'CONSENT', 'CONSENT_SOURCE_MISMATCH');
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, current.photoAssetId), eq(mediaAssets.accountId, accountId))).for('share').limit(1))[0];
    assertPhotoAsset(photo, accountId, current.photoAssetId);
    if (photo.sha256 !== current.photoSha256) throw failure('Enrollment photo changed before consent.', 409, 'CONSENT', 'PHOTO_SOURCE_MISMATCH');
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.EXTRACTION_QUEUED);
    const workflowOperationKey = crypto.randomUUID();
    const authorizations = {
      audioExtractionAuthorization: input.audioExtractionAuthorization,
      faceAuthorization: input.faceAuthorization,
      voiceAuthorization: input.voiceAuthorization,
      providerProcessingAuthorization: input.providerProcessingAuthorization,
      archiveDeleteAcknowledgment: input.archiveDeleteAcknowledgment,
      temporaryPublicProviderExposureAuthorization: input.temporaryPublicProviderExposureAuthorization,
    };
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.EXTRACTION_QUEUED, stateVersion: current.stateVersion + 1,
      consentPolicyVersion: input.policyVersion, consentPurpose: input.purpose,
      consentedSourceSha256: input.sourceVideoSha256, consentIdempotencyKey: input.idempotencyKey,
      consentAuthorizations: authorizations, consentedAt: now,
      workflowOperationKey, leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000), updatedAt: now,
      workflowRunId: null,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment consent lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.extraction_consented', current.status, updated.status, { policyVersion: input.policyVersion, sourceSha256: input.sourceVideoSha256 });
    return { enrollment: updated, dispatch: true, replayed: false };
  });
}

export async function grantProviderBridgeReconsent({ accountId, input, now = new Date() }) {
  return database().transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    const current = (await tx.select().from(identityVideoEnrollments).where(and(
      eq(identityVideoEnrollments.id, input.enrollmentId),
      eq(identityVideoEnrollments.accountId, accountId),
    )).for('update').limit(1))[0];
    if (!current || current.identityId !== input.identityId) throw failure('Enrollment identity was not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    const identity = (await tx.select().from(userIdentities).where(and(
      eq(userIdentities.id, input.identityId), eq(userIdentities.accountId, accountId), isNull(userIdentities.archivedAt),
    )).for('update').limit(1))[0];
    if (!identity || identity.sourcePhotoAssetId !== current.photoAssetId || identity.sourceVoiceAssetId !== current.derivedVoiceAssetId) {
      throw failure('Provider re-consent identity source binding changed.', 409, 'CONSENT', 'IDENTITY_SOURCE_MISMATCH');
    }
    const replay = (await tx.select().from(identityConsents).where(and(
      eq(identityConsents.accountId, accountId),
      eq(identityConsents.idempotencyKey, input.idempotencyKey),
    )).for('update').limit(1))[0];
    if (replay) {
      if (replay.identityId !== input.identityId || replay.policyVersion !== ENROLLMENT_CONSENT_POLICY_VERSION
        || replay.photoSha256 !== input.sourcePhotoSha256 || replay.sourceVideoSha256 !== input.sourceVideoSha256
        || replay.voiceSha256 !== input.derivedVoiceSha256 || replay.temporaryPublicProviderExposureAuthorization !== true) {
        throw failure('Provider re-consent idempotency key belongs to different source consent.', 409, 'RECONCILIATION', 'CONSENT_REPLAY_CONFLICT');
      }
      return { enrollment: current, consent: replay, replayed: true };
    }
    if (current.status !== ENROLLMENT_STATUSES.IDENTITY_READY || current.revokedAt || current.stateVersion !== input.expectedStateVersion
      || current.photoSha256 !== input.sourcePhotoSha256 || current.sourceSha256 !== input.sourceVideoSha256
      || current.derivedAudioSha256 !== input.derivedVoiceSha256 || current.sourceDeletedAt) {
      throw failure('Provider re-consent does not match the ready enrollment sources.', 409, 'CONSENT', 'CONSENT_SOURCE_MISMATCH');
    }
    const activeV2 = (await tx.select().from(identityConsents).where(and(
      eq(identityConsents.accountId, accountId), eq(identityConsents.identityId, identity.id),
      eq(identityConsents.policyVersion, ENROLLMENT_CONSENT_POLICY_VERSION), isNull(identityConsents.revokedAt),
    )).for('share').limit(1))[0];
    if (activeV2) throw failure('Provider bridge consent is already active.', 409, 'CONSENT', 'CONSENT_ALREADY_ACTIVE');
    const assetIds = [current.photoAssetId, current.sourceVideoAssetId, current.derivedVoiceAssetId].filter(Boolean).sort();
    const assets = [];
    for (const assetId of assetIds) {
      const [asset] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.accountId, accountId))).for('share').limit(1);
      assets.push(asset);
    }
    const byId = new Map(assets.filter(Boolean).map(asset => [asset.id, asset]));
    const photo = byId.get(current.photoAssetId);
    const source = byId.get(current.sourceVideoAssetId);
    const voice = byId.get(current.derivedVoiceAssetId);
    assertPhotoAsset(photo, accountId, current.photoAssetId);
    const enrollmentPrefix = `video-os/enrollment-sources/${accountHash(accountId)}/${current.id}/`;
    if (photo.sha256 !== input.sourcePhotoSha256 || !Number.isSafeInteger(photo.bytes) || photo.bytes <= 0
      || !source || source.quarantinedAt || source.kind !== 'identity-phone-video-source' || source.sha256 !== input.sourceVideoSha256
      || source.bytes !== current.sourceBytes || source.privatePathname !== current.uploadPathname || !Number.isSafeInteger(source.bytes) || source.bytes <= 0
      || !voice || voice.quarantinedAt || voice.kind !== 'identity-voice-source' || voice.sha256 !== input.derivedVoiceSha256
      || voice.bytes !== current.derivedAudioBytes || !String(voice.privatePathname || '').startsWith(enrollmentPrefix)
      || !Number.isSafeInteger(voice.bytes) || voice.bytes <= 0) {
      throw failure('Provider re-consent source media is unavailable.', 409, 'CONSENT', 'CONSENT_SOURCE_UNAVAILABLE');
    }
    const [consent] = await tx.insert(identityConsents).values({
      accountId,
      identityId: identity.id,
      idempotencyKey: input.idempotencyKey,
      audioExtractionAuthorization: true,
      faceAuthorization: true,
      voiceAuthorization: true,
      providerProcessingAuthorization: true,
      archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: true,
      policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
      consentPurpose: input.purpose,
      photoSha256: photo.sha256,
      sourceVideoSha256: source.sha256,
      voiceSha256: voice.sha256,
      acceptedAt: now,
    }).returning();
    const authorizations = {
      audioExtractionAuthorization: true,
      faceAuthorization: true,
      voiceAuthorization: true,
      providerProcessingAuthorization: true,
      archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: true,
    };
    const [updated] = await tx.update(identityVideoEnrollments).set({
      stateVersion: current.stateVersion + 1,
      consentPolicyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
      consentPurpose: input.purpose,
      consentedSourceSha256: source.sha256,
      consentAuthorizations: authorizations,
      consentedAt: now,
      updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Provider re-consent lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.provider_bridge_reconsented', current.status, updated.status, {
      policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
      photoSha256: photo.sha256,
      sourceVideoSha256: source.sha256,
      voiceSha256: voice.sha256,
    });
    return { enrollment: updated, consent, replayed: false };
  });
}

export async function claimEnrollmentExtraction(enrollmentId, operationKey, now = new Date()) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.status !== ENROLLMENT_STATUSES.EXTRACTION_QUEUED || current.workflowOperationKey !== operationKey || current.attemptCount >= ENROLLMENT_MAX_ATTEMPTS) {
      throw failure('Enrollment extraction is not claimable.', 409, 'RECONCILIATION', 'EXTRACTION_CLAIM_REJECTED');
    }
    assertEnrollmentConsentRecord(current);
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.EXTRACTING);
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.EXTRACTING, stateVersion: current.stateVersion + 1,
      attemptCount: current.attemptCount + 1, leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000), updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment extraction lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.extraction_started', current.status, updated.status, { attempt: updated.attemptCount });
    return updated;
  });
}

function assertFinalMediaResult(current, result) {
  if (!result || result.source?.sha256 !== current.sourceSha256 || result.source?.bytes !== current.sourceBytes
    || !/^[a-f0-9]{64}$/.test(result.audioSha256 || '') || !Number.isSafeInteger(result.audioBytes) || result.audioBytes <= 0
    || result.audioMimeType !== 'audio/wav' || !result.derivationVersion) {
    throw failure('Enrollment media result does not match its source.', 422, 'ENROLLMENT_MEDIA', 'DERIVATION_MISMATCH');
  }
}

export async function finalizeEnrollmentIdentity({ enrollmentId, operationKey, result, derivedPathname, derivedEtag, now = new Date() }) {
  const owner = (await database().select({ accountId: identityVideoEnrollments.accountId }).from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).limit(1))[0];
  return database().transaction(async tx => {
    if (!owner) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    await acquireProviderLifecycleLock(tx, owner.accountId);
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.status !== ENROLLMENT_STATUSES.EXTRACTING || current.workflowOperationKey !== operationKey || current.revokedAt) throw failure('Enrollment finalization is stale.', 409, 'RECONCILIATION', 'FINALIZATION_REJECTED');
    assertEnrollmentConsentRecord(current);
    assertFinalMediaResult(current, result);
    const expectedDerivedPathname = `video-os/enrollment-sources/${accountHash(current.accountId)}/${current.id}/derived-${result.audioSha256}.wav`;
    if (derivedPathname !== expectedDerivedPathname || typeof derivedEtag !== 'string' || !derivedEtag.trim() || derivedEtag.length > 512) {
      throw failure('Derived enrollment audio storage identity is invalid.', 409, 'RECONCILIATION', 'DERIVED_STORAGE_IDENTITY_INVALID');
    }
    const photo = (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, current.photoAssetId), eq(mediaAssets.accountId, current.accountId))).for('share').limit(1))[0];
    assertPhotoAsset(photo, current.accountId, current.photoAssetId);
    if (photo.sha256 !== current.photoSha256) throw failure('Enrollment photo changed before identity creation.', 409, 'CONSENT', 'PHOTO_SOURCE_MISMATCH');
    const sourceAssetId = stableUuid(current.id, 'source-video');
    const voiceAssetId = stableUuid(current.id, 'derived-voice');
    const identityId = stableUuid(current.id, 'identity');
    const consentId = stableUuid(current.id, 'identity-consent');
    await tx.insert(mediaAssets).values({
      id: sourceAssetId, accountId: current.accountId, kind: 'identity-phone-video-source', privatePathname: current.uploadPathname,
      contentType: result.source.mimeType, bytes: result.source.bytes, sha256: result.source.sha256,
      widthPx: result.source.width, heightPx: result.source.height, durationMs: result.source.durationMs,
    }).onConflictDoNothing();
    await tx.insert(mediaAssets).values({
      id: voiceAssetId, accountId: current.accountId, kind: 'identity-voice-source', privatePathname: derivedPathname,
      contentType: 'audio/wav', bytes: result.audioBytes, sha256: result.audioSha256, durationMs: result.durationMs,
    }).onConflictDoNothing();
    const [sourceAsset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, sourceAssetId)).for('share').limit(1);
    const [voiceAsset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, voiceAssetId)).for('share').limit(1);
    if (sourceAsset?.privatePathname !== current.uploadPathname || sourceAsset?.sha256 !== result.source.sha256 || sourceAsset?.bytes !== result.source.bytes
      || voiceAsset?.privatePathname !== derivedPathname || voiceAsset?.sha256 !== result.audioSha256 || voiceAsset?.bytes !== result.audioBytes) {
      throw failure('Enrollment media asset identity conflicts with an existing record.', 409, 'RECONCILIATION', 'MEDIA_IDENTITY_CONFLICT');
    }
    await tx.insert(userIdentities).values({
      id: identityId, accountId: current.accountId, displayName: current.displayName,
      provider: 'heygen', sourcePhotoAssetId: current.photoAssetId, sourceVoiceAssetId: voiceAssetId,
    }).onConflictDoNothing();
    await tx.insert(identityConsents).values({
      id: consentId, accountId: current.accountId, identityId,
      idempotencyKey: current.consentIdempotencyKey,
      audioExtractionAuthorization: current.consentAuthorizations?.audioExtractionAuthorization === true,
      faceAuthorization: true, voiceAuthorization: true, providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: current.consentAuthorizations?.temporaryPublicProviderExposureAuthorization === true,
      policyVersion: current.consentPolicyVersion, consentPurpose: current.consentPurpose,
      photoSha256: photo.sha256, sourceVideoSha256: current.sourceSha256, voiceSha256: result.audioSha256,
    }).onConflictDoNothing();
    const [identity] = await tx.select().from(userIdentities).where(and(eq(userIdentities.id, identityId), eq(userIdentities.accountId, current.accountId))).for('share').limit(1);
    const [consent] = await tx.select().from(identityConsents).where(and(eq(identityConsents.id, consentId), isNull(identityConsents.revokedAt))).for('share').limit(1);
    if (!identity || identity.sourcePhotoAssetId !== current.photoAssetId || identity.sourceVoiceAssetId !== voiceAssetId
      || !consent || consent.photoSha256 !== photo.sha256 || consent.voiceSha256 !== result.audioSha256) {
      throw failure('Enrollment identity finalization conflicts with existing state.', 409, 'RECONCILIATION', 'IDENTITY_CONFLICT');
    }
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.IDENTITY_READY);
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.IDENTITY_READY, stateVersion: current.stateVersion + 1,
      sourceMetadata: result.source, sourceVideoAssetId: sourceAssetId, derivedVoiceAssetId: voiceAssetId,
      derivedAudioSha256: result.audioSha256, derivedAudioBytes: result.audioBytes, derivedAudioDurationMs: result.durationMs,
      derivationVersion: result.derivationVersion, identityId, workflowOperationKey: null, leaseExpiresAt: null,
      cleanupStatus: 'NOT_REQUIRED', failureCode: null, failureMessage: null, completedAt: now, updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment identity finalization lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.identity_ready', current.status, updated.status, { sourceSha256: result.source.sha256, audioSha256: result.audioSha256, derivationVersion: result.derivationVersion, derivedEtag: Boolean(derivedEtag) });
    return { enrollment: updated, identity };
  });
}

export async function failEnrollmentOperation({ enrollmentId, operationKey, code, message, now = new Date() }) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current || current.workflowOperationKey !== operationKey || [ENROLLMENT_STATUSES.IDENTITY_READY, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED].includes(current.status)) return current || null;
    const safeCode = boundedFailure(code, 'ENROLLMENT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80);
    const cleanupStatus = current.attemptCount >= ENROLLMENT_MAX_ATTEMPTS || !enrollmentFailureIsRetryable(safeCode) ? 'PENDING' : 'NOT_REQUIRED';
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.FAILED, stateVersion: current.stateVersion + 1,
      failureCode: safeCode,
      failureMessage: boundedFailure(message, 'Enrollment processing failed.'), workflowOperationKey: null, leaseExpiresAt: null,
      cleanupStatus, updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) return null;
    await event(tx, current, 'enrollment.failed', current.status, updated.status, {}, updated.failureCode);
    return updated;
  });
}

export async function retryEnrollment({ accountId, input, now = new Date() }) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, input.enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).for('update').limit(1))[0];
    if (!current) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    if (current.status !== ENROLLMENT_STATUSES.FAILED || current.stateVersion !== input.expectedStateVersion || current.revokedAt
      || current.attemptCount >= ENROLLMENT_MAX_ATTEMPTS || !enrollmentFailureIsRetryable(current.failureCode)) throw failure('Enrollment cannot be retried.', 409, 'RECONCILIATION', 'RETRY_REJECTED');
    const target = current.sourceSha256 && current.consentedAt ? ENROLLMENT_STATUSES.EXTRACTION_QUEUED : current.uploadEtag ? ENROLLMENT_STATUSES.SOURCE_HASHING : null;
    if (!target) throw failure('Enrollment retry has no durable source.', 409, 'RECONCILIATION', 'RETRY_SOURCE_MISSING');
    assertEnrollmentTransition(current.status, target);
    const workflowOperationKey = crypto.randomUUID();
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: target, stateVersion: current.stateVersion + 1, workflowOperationKey,
      workflowRunId: null, leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      attemptCount: target === ENROLLMENT_STATUSES.SOURCE_HASHING ? current.attemptCount + 1 : current.attemptCount,
      failureCode: null, failureMessage: null, updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment retry lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.retry_queued', current.status, updated.status, { attempt: current.attemptCount });
    return { enrollment: updated, dispatch: true };
  });
}

export async function revokeEnrollment({ accountId, input, now = new Date() }) {
  return database().transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    const current = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, input.enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).for('update').limit(1))[0];
    if (!current) throw failure('Enrollment not found.', 404, 'OWNERSHIP', 'ENROLLMENT_NOT_FOUND');
    if (current.status === ENROLLMENT_STATUSES.REVOKED) return { enrollment: current, replayed: true };
    if (current.stateVersion !== input.expectedStateVersion) throw failure('Enrollment revocation state changed.', 409, 'RECONCILIATION', 'STATE_RACE');
    if (current.identityId) {
      const [identity] = await tx.select().from(userIdentities).where(and(eq(userIdentities.id, current.identityId), eq(userIdentities.accountId, accountId))).for('update').limit(1);
      await tx.update(identityConsents).set({ revokedAt: now }).where(and(eq(identityConsents.identityId, current.identityId), eq(identityConsents.accountId, accountId), isNull(identityConsents.revokedAt)));
      if (identity && !identity.archivedAt) await tx.update(userIdentities).set({ overallStatus: 'ARCHIVED', archivedAt: now, updatedAt: now }).where(eq(userIdentities.id, identity.id));
    }
    const assetIds = [current.sourceVideoAssetId, current.derivedVoiceAssetId].filter(Boolean);
    for (const assetId of assetIds) await tx.update(mediaAssets).set({ quarantinedAt: now }).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.accountId, accountId)));
    const providerPending = Object.values(current.providerReceipts || {}).some(receipt => ['SUBMITTING', 'ACCEPTED', 'COMPLETE', 'PENDING'].includes(receipt?.status));
    const [updated] = await tx.update(identityVideoEnrollments).set({
      status: ENROLLMENT_STATUSES.REVOKED, stateVersion: current.stateVersion + 1, revokedAt: now,
      workflowOperationKey: null, leaseExpiresAt: null, cleanupStatus: 'PENDING',
      providerReconciliationStatus: providerPending ? 'PENDING' : current.providerReconciliationStatus,
      updatedAt: now,
    }).where(and(eq(identityVideoEnrollments.id, current.id), eq(identityVideoEnrollments.stateVersion, current.stateVersion))).returning();
    if (!updated) throw failure('Enrollment revocation lost its state claim.', 409, 'RECONCILIATION', 'STATE_RACE');
    await event(tx, current, 'enrollment.revoked', current.status, updated.status, { linkedIdentity: Boolean(current.identityId) });
    return { enrollment: updated, replayed: false };
  });
}

export async function revokeLinkedEnrollmentByIdentity(accountId, identityId, idempotencyKey = crypto.randomUUID()) {
  const enrollment = await getLinkedEnrollmentForIdentity(accountId, identityId);
  if (!enrollment || enrollment.status === ENROLLMENT_STATUSES.REVOKED) return enrollment;
  return (await revokeEnrollment({
    accountId,
    input: { enrollmentId: enrollment.id, expectedStateVersion: enrollment.stateVersion, idempotencyKey },
  })).enrollment;
}

export async function expireEnrollment({ accountId, enrollmentId, now = new Date() }) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.id, enrollmentId), eq(identityVideoEnrollments.accountId, accountId))).for('update').limit(1))[0];
    if (!current) return null;
    const expiresAt = current.status === ENROLLMENT_STATUSES.AWAITING_UPLOAD ? current.uploadExpiresAt : current.expiresAt;
    if ([ENROLLMENT_STATUSES.IDENTITY_READY, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED].includes(current.status) || new Date(expiresAt) > now) return current;
    assertEnrollmentTransition(current.status, ENROLLMENT_STATUSES.EXPIRED);
    const [updated] = await tx.update(identityVideoEnrollments).set({ status: ENROLLMENT_STATUSES.EXPIRED, stateVersion: current.stateVersion + 1, cleanupStatus: 'PENDING', updatedAt: now }).where(eq(identityVideoEnrollments.id, current.id)).returning();
    await event(tx, current, 'enrollment.expired', current.status, updated.status);
    return updated;
  });
}

export async function recordEnrollmentCleanup({ enrollmentId, deleted, now = new Date() }) {
  const [updated] = await database().update(identityVideoEnrollments).set({
    cleanupStatus: deleted ? 'DELETED' : 'FAILED',
    ...(deleted ? { sourceDeletedAt: now } : {}),
    updatedAt: now,
  }).where(eq(identityVideoEnrollments.id, enrollmentId)).returning();
  return updated || null;
}

export async function claimEnrollmentCleanup(enrollmentId, now = new Date(), { afterUploadExpiry = false } = {}) {
  return database().transaction(async tx => {
    const current = (await tx.select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).for('update').limit(1))[0];
    if (!current) return null;
    const normalAttempt = ['PENDING', 'FAILED'].includes(current.cleanupStatus) && current.cleanupAttempts < 3;
    const postUploadRecheck = afterUploadExpiry === true && new Date(current.uploadExpiresAt) <= now && current.cleanupAttempts < 4;
    if (!enrollmentNeedsTerminalCleanup(current) || (!normalAttempt && !postUploadRecheck)) return null;
    const [updated] = await tx.update(identityVideoEnrollments).set({ cleanupStatus: 'PENDING', cleanupAttempts: sql`${identityVideoEnrollments.cleanupAttempts} + 1`, updatedAt: now })
      .where(eq(identityVideoEnrollments.id, current.id)).returning();
    return updated;
  });
}

export async function expireEnrollmentInternal(enrollmentId, now = new Date()) {
  const current = (await database().select().from(identityVideoEnrollments).where(eq(identityVideoEnrollments.id, enrollmentId)).limit(1))[0];
  if (!current) return null;
  return expireEnrollment({ accountId: current.accountId, enrollmentId, now });
}

export async function getLinkedEnrollmentForIdentity(accountId, identityId, { lock = false, executor = database() } = {}) {
  let query = executor.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId)));
  if (lock) query = query.for('share');
  return (await query.limit(1))[0] || null;
}

export async function assertEnrollmentProviderAllowed(accountId, identityId) {
  return database().transaction(async tx => {
    await acquireProviderLifecycleLock(tx, accountId);
    const enrollment = await getLinkedEnrollmentForIdentity(accountId, identityId, { lock: true, executor: tx });
    if (!enrollment) return true;
    if (enrollment.status !== ENROLLMENT_STATUSES.IDENTITY_READY) {
      throw failure('Enrollment consent is not active for provider submission.', 409, 'CONSENT', 'ENROLLMENT_CONSENT_INACTIVE');
    }
    assertEnrollmentConsentRecord(enrollment, { requireProviderExposure: true });
    const assetIds = [enrollment.sourceVideoAssetId, enrollment.derivedVoiceAssetId].filter(Boolean).sort();
    const assets = [];
    for (const assetId of assetIds) {
      const [asset] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.accountId, accountId))).for('share').limit(1);
      assets.push(asset);
    }
    const byId = new Map(assets.filter(Boolean).map(asset => [asset.id, asset]));
    const source = byId.get(enrollment.sourceVideoAssetId);
    const voice = byId.get(enrollment.derivedVoiceAssetId);
    if (!source || source.quarantinedAt || source.kind !== 'identity-phone-video-source' || source.sha256 !== enrollment.sourceSha256
      || source.bytes !== enrollment.sourceBytes || source.privatePathname !== enrollment.uploadPathname
      || !voice || voice.quarantinedAt || voice.kind !== 'identity-voice-source' || voice.sha256 !== enrollment.derivedAudioSha256
      || voice.bytes !== enrollment.derivedAudioBytes || !String(voice.privatePathname || '').startsWith(`video-os/enrollment-sources/${accountHash(accountId)}/${enrollment.id}/`)) {
      throw failure('Enrollment media is unavailable for provider submission.', 409, 'CONSENT', 'ENROLLMENT_MEDIA_UNAVAILABLE');
    }
    return true;
  });
}

function providerReceiptKey(component, stage) {
  if (!['avatar', 'voice'].includes(component) || !['asset', 'create'].includes(stage)) throw failure('Enrollment provider receipt type is invalid.', 400, 'VALIDATION', 'PROVIDER_RECEIPT_INVALID');
  return `${component}:${stage}`;
}

function reconciliationStatusForReceipts(receipts, currentStatus = 'NONE') {
  const values = Object.values(receipts || {});
  if (currentStatus === 'PENDING' || values.some(receipt => receipt?.status === 'PENDING')) return 'PENDING';
  if (values.some(receipt => ['SUBMITTING', 'ACCEPTED'].includes(receipt?.status))) return 'SUBMITTING';
  if (values.some(receipt => receipt?.status === 'FAILED')) return 'FAILED';
  return values.length ? 'COMPLETE' : 'NONE';
}

function providerOperationKind(component, stage) {
  if (stage === 'asset') return 'asset_upload';
  return component === 'avatar' ? 'avatar_create' : 'voice_clone';
}

function expectedProviderIds(component, stage, providerIds) {
  const fields = stage === 'asset'
    ? ['providerAssetId']
    : component === 'avatar'
      ? ['providerAvatarGroupId', 'providerRenderableAvatarId']
      : ['providerVoiceId'];
  const ids = {};
  const missing = [];
  for (const field of fields) {
    const value = String(providerIds?.[field] || '');
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(value)) missing.push(field);
    else ids[field] = value;
  }
  if (component === 'avatar' && stage === 'create' && providerIds?.providerRequestId) {
    const requestId = String(providerIds.providerRequestId);
    if (/^[A-Za-z0-9_.:-]{1,255}$/.test(requestId)) ids.providerRequestId = requestId;
  }
  return { ids, missing };
}

function providerResourcesForReceipt(component, stage, ids, source) {
  if (stage === 'asset') return ids.providerAssetId ? [{
    kind: 'asset', providerResourceId: ids.providerAssetId, state: 'present',
    sourceSha256: source.sha256, sourceBytes: source.bytes,
  }] : [];
  if (component === 'avatar') return [
    ...(ids.providerAvatarGroupId ? [{ kind: 'avatar_group', providerResourceId: ids.providerAvatarGroupId, state: 'processing', sourceSha256: source.sha256, sourceBytes: source.bytes }] : []),
    ...(ids.providerRenderableAvatarId
      ? [{ kind: 'avatar_look', providerResourceId: ids.providerRenderableAvatarId, parentProviderResourceId: ids.providerAvatarGroupId || null, state: 'processing', sourceSha256: source.sha256, sourceBytes: source.bytes }]
      : []),
  ];
  return ids.providerVoiceId ? [{ kind: 'voice', providerResourceId: ids.providerVoiceId, voiceNamespace: 'instant', state: 'processing', sourceSha256: source.sha256, sourceBytes: source.bytes }] : [];
}

function assertClaimResourceBinding(resource, binding) {
  if (!resource || resource.bindingId !== binding.bindingId
    || resource.originScopeKey !== binding.originScopeKey
    || resource.verifiedAccountScopeId !== binding.verifiedAccountScopeId
    || ['delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation'].includes(resource.state)
    || resource.tombstonedAt) {
    throw failure('Provider source resource belongs to a different or unavailable provider space.', 409, 'RECONCILIATION', 'PROVIDER_RESOURCE_SCOPE_CONFLICT');
  }
  return resource;
}

function enrollmentProviderClaimProof({ enrollment, identity, identityId, component, stage, operationKey, source, providerAssetId }) {
  return Object.freeze({
    version: 'heygen-enrollment-provider-claim/v1',
    enrollmentId: enrollment.id,
    identityId,
    component,
    stage,
    operationKey,
    componentStatus: component === 'avatar' ? identity.avatarStatus : identity.voiceStatus,
    identityDisplayName: identity.displayName,
    source: Object.freeze({
      assetId: source.id,
      sha256: source.sha256,
      bytes: source.bytes,
      contentType: source.contentType,
      providerAssetId: providerAssetId || null,
    }),
  });
}

function identityOverallStatusForClaim(identity, component) {
  const avatarStatus = component === 'avatar' ? 'CREATING' : identity.avatarStatus;
  const voiceStatus = component === 'voice' ? 'CREATING' : identity.voiceStatus;
  if (avatarStatus === 'READY' && voiceStatus === 'READY') return 'READY';
  if (avatarStatus === 'FAILED' || voiceStatus === 'FAILED') return 'PARTIAL_FAILURE';
  if (avatarStatus === 'CREATING' && voiceStatus === 'DRAFT') return 'CREATING_AVATAR';
  if (voiceStatus === 'CREATING' && avatarStatus === 'DRAFT') return 'CLONING_VOICE';
  return 'PROCESSING';
}

export async function claimEnrollmentProviderOperation({ accountId, identityId, component, stage, operationKey, providerBinding, now = new Date() }) {
  if (!providerBinding) throw failure('Verified provider-space binding is required.', 503, 'MISSING_PROVIDER_ACCOUNT_BINDING', 'MISSING_PROVIDER_ACCOUNT_BINDING');
  return withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
    const bindingAuthority = assertFreshHeygenProviderClaimTx(tx, { accountId, providerBinding });
    const enrollment = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId))).for('update').limit(1))[0];
    if (!enrollment) throw failure('Legacy provider identity is not registered in the lifecycle ledger.', 409, 'RECONCILIATION', 'LEGACY_PROVIDER_RECEIPT_UNREGISTERED');
    if (enrollment.status !== ENROLLMENT_STATUSES.IDENTITY_READY || enrollment.providerReconciliationStatus === 'PENDING') throw failure('Enrollment provider work requires reconciliation.', 409, 'RECONCILIATION', 'PROVIDER_RECONCILIATION_REQUIRED');
    assertEnrollmentConsentRecord(enrollment, { requireProviderExposure: true });
    const key = providerReceiptKey(component, stage);
    const receipts = { ...(enrollment.providerReceipts || {}) };
    if (Object.values(receipts).some(receipt => receipt?.status === 'PENDING')) throw failure('Enrollment provider work requires reconciliation.', 409, 'RECONCILIATION', 'PROVIDER_RECONCILIATION_REQUIRED');
    const existing = receipts[key];
    const replayed = existing?.operationKey === operationKey && ['SUBMITTING', 'ACCEPTED', 'COMPLETE'].includes(existing.status);
    if (existing && existing.operationKey !== operationKey && existing.status !== 'FAILED') throw failure('Enrollment provider operation is already claimed.', 409, 'RECONCILIATION', 'PROVIDER_OPERATION_CLAIMED');
    let identity = (await tx.select().from(userIdentities).where(and(
      eq(userIdentities.id, identityId), eq(userIdentities.accountId, accountId), isNull(userIdentities.archivedAt),
    )).for('update').limit(1))[0];
    if (!identity) throw failure('Provider identity is unavailable.', 409, 'CONSENT', 'IDENTITY_UNAVAILABLE');
    const componentStatus = component === 'avatar' ? identity.avatarStatus : identity.voiceStatus;
    const componentOperationKey = component === 'avatar' ? identity.avatarOperationKey : identity.voiceOperationKey;
    const operationMatches = ['CREATING', 'PROCESSING'].includes(componentStatus)
      && String(componentOperationKey || '') === String(operationKey || '');
    const reserveComponent = !operationMatches && stage === 'asset' && ['DRAFT', 'FAILED'].includes(componentStatus);
    if (!operationMatches && !reserveComponent) {
      throw failure('Identity provider operation does not match the canonical component claim.', 409, 'RECONCILIATION', 'PROVIDER_OPERATION_CLAIMED');
    }
    const consent = (await tx.select().from(identityConsents).where(and(
      eq(identityConsents.accountId, accountId), eq(identityConsents.identityId, identityId),
      eq(identityConsents.policyVersion, ENROLLMENT_CONSENT_POLICY_VERSION), isNull(identityConsents.revokedAt),
    )).for('share').limit(1))[0];
    if (!consent || consent.temporaryPublicProviderExposureAuthorization !== true || consent.audioExtractionAuthorization !== true
      || consent.photoSha256 !== enrollment.photoSha256 || consent.sourceVideoSha256 !== enrollment.sourceSha256
      || consent.voiceSha256 !== enrollment.derivedAudioSha256) {
      throw failure('Provider bridge identity consent is unavailable.', 409, 'CONSENT', 'ENROLLMENT_CONSENT_INACTIVE');
    }
    const sourceAssetId = component === 'avatar' ? identity.sourcePhotoAssetId : identity.sourceVoiceAssetId;
    const source = (await tx.select().from(mediaAssets).where(and(
      eq(mediaAssets.id, sourceAssetId), eq(mediaAssets.accountId, accountId), isNull(mediaAssets.quarantinedAt),
    )).for('share').limit(1))[0];
    const expectedPhoto = component === 'avatar';
    const expectedPrivatePath = expectedPhoto
      ? String(source?.privatePathname || '').startsWith('video-os/uploads/')
      : String(source?.privatePathname || '').startsWith(`video-os/enrollment-sources/${accountHash(accountId)}/${enrollment.id}/`);
    const expectedHash = expectedPhoto ? consent.photoSha256 : consent.voiceSha256;
    const expectedBytes = expectedPhoto ? source?.bytes : enrollment.derivedAudioBytes;
    if (!source || source.id !== (expectedPhoto ? enrollment.photoAssetId : enrollment.derivedVoiceAssetId)
      || source.quarantinedAt || source.kind !== (expectedPhoto ? 'identity-photo-source' : 'identity-voice-source')
      || source.sha256 !== expectedHash || source.bytes !== expectedBytes || !expectedPrivatePath
      || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) {
      throw failure('Provider source asset is unavailable.', 409, 'CONSENT', 'ENROLLMENT_MEDIA_UNAVAILABLE');
    }
    const assetReceipt = receipts[`${component}:asset`];
    const receiptProviderAssetId = assetReceipt?.providerIds?.providerAssetId || null;
    const sourceProviderAssetId = source.provider === 'heygen' ? source.providerAssetId || null : null;
    if (receiptProviderAssetId && sourceProviderAssetId && receiptProviderAssetId !== sourceProviderAssetId) {
      throw failure('Provider source asset identity conflicts with its receipt.', 409, 'RECONCILIATION', 'PROVIDER_RESOURCE_SCOPE_CONFLICT');
    }
    const providerAssetId = receiptProviderAssetId || sourceProviderAssetId;
    if (providerAssetId) {
      const providerResource = await getExactProviderResourceTx(tx, {
        accountId, kind: 'asset', providerResourceId: providerAssetId, lock: true,
      });
      assertClaimResourceBinding(providerResource, bindingAuthority);
    }
    if (stage === 'create' && (!providerAssetId || assetReceipt?.operationKey !== operationKey
      || !['ACCEPTED', 'COMPLETE'].includes(assetReceipt?.status))) {
      throw failure('Provider source asset receipt is missing from the current provider space.', 409, 'RECONCILIATION', 'PROVIDER_RESOURCE_UNVERIFIED');
    }
    if (reserveComponent) {
      const fields = component === 'avatar'
        ? { status: 'avatarStatus', operation: 'avatarOperationKey', code: 'avatarFailureCode', message: 'avatarFailureMessage' }
        : { status: 'voiceStatus', operation: 'voiceOperationKey', code: 'voiceFailureCode', message: 'voiceFailureMessage' };
      const retryReset = componentStatus !== 'FAILED'
        ? {}
        : component === 'avatar'
          ? { providerAvatarRequestId: null, providerAvatarGroupId: null, providerRenderableAvatarId: null }
          : { providerVoiceId: null };
      [identity] = await tx.update(userIdentities).set({
        [fields.status]: 'CREATING',
        [fields.operation]: operationKey,
        [fields.code]: null,
        [fields.message]: null,
        ...retryReset,
        overallStatus: identityOverallStatusForClaim(identity, component),
        updatedAt: now,
      }).where(and(eq(userIdentities.accountId, accountId), eq(userIdentities.id, identityId))).returning();
    }
    const claimProof = enrollmentProviderClaimProof({
      enrollment, identity, identityId, component, stage, operationKey, source, providerAssetId,
    });
    const requestDigest = providerOperationRequestDigest({
      version: 'provider-operation-request/v1', accountId, enrollmentId: enrollment.id, identityId,
      component, stage, operationKey, sourceAssetId: source.id, sourceSha256: source.sha256, sourceBytes: source.bytes,
    });
    const ledger = await reserveProviderOperationTx(tx, {
      accountId,
      providerBinding,
      kind: providerOperationKind(component, stage),
      originOperationKey: operationKey,
      correlationId: enrollment.correlationId,
      enrollmentId: enrollment.id,
      identityId,
      requestDigest,
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
    });
    if (replayed) {
      if (!existing.ledgerOperationId || existing.ledgerOperationId !== ledger.operation.id) {
        throw failure('Provider receipt replay does not match its immutable lifecycle operation.', 409, 'RECONCILIATION', 'PROVIDER_OPERATION_CONFLICT');
      }
      const replayIds = expectedProviderIds(component, stage, existing.providerIds || {});
      if (existing.status === 'SUBMITTING' || replayIds.missing.length > 0) {
        throw failure('Provider submission outcome requires reconciliation before retry.', 409, 'RECONCILIATION', 'PROVIDER_RECONCILIATION_REQUIRED');
      }
      return { enrollment, receipt: existing, replayed: true, claimProof };
    }
    receipts[key] = { operationKey, ledgerOperationId: ledger.operation.id, status: 'SUBMITTING', claimedAt: now.toISOString() };
    const [updated] = await tx.update(identityVideoEnrollments).set({ providerReceipts: receipts, providerReconciliationStatus: 'SUBMITTING', updatedAt: now })
      .where(eq(identityVideoEnrollments.id, enrollment.id)).returning();
    await event(tx, enrollment, 'enrollment.provider_claimed', enrollment.status, enrollment.status, { component, stage });
    return { enrollment: updated, receipt: receipts[key], replayed: false, claimProof };
  });
}

export async function recordEnrollmentProviderReceipt({ accountId, identityId, component, stage, operationKey, providerBinding, providerIds = {}, now = new Date() }) {
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const enrollment = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId))).for('update').limit(1))[0];
    if (!enrollment) return null;
    const key = providerReceiptKey(component, stage);
    const receipts = { ...(enrollment.providerReceipts || {}) };
    if (receipts[key]?.operationKey !== operationKey || !receipts[key]?.ledgerOperationId) throw failure('Enrollment provider receipt does not match its ledger claim.', 409, 'RECONCILIATION', 'PROVIDER_RECEIPT_CONFLICT');
    await assertProviderReceiptOperationTx(tx, {
      accountId, providerBinding, operationId: receipts[key].ledgerOperationId,
    });
    const observed = expectedProviderIds(component, stage, providerIds);
    const safeIds = observed.ids;
    let ledgerResult;
    if (observed.missing.length) {
      await recordProviderOperationFailureTx(tx, { accountId, operationId: receipts[key].ledgerOperationId, ambiguous: true, code: 'PROVIDER_ID_MISSING', now });
      const source = component === 'avatar'
        ? { sha256: enrollment.photoSha256, bytes: (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, enrollment.photoAssetId), eq(mediaAssets.accountId, accountId))).limit(1))[0]?.bytes }
        : { sha256: enrollment.derivedAudioSha256, bytes: enrollment.derivedAudioBytes };
      const partialResources = providerResourcesForReceipt(component, stage, safeIds, source);
      const recorded = partialResources.length ? await recordProviderOperationResourcesTx(tx, {
        accountId, operationId: receipts[key].ledgerOperationId, resources: partialResources, now,
      }) : { conflicts: [] };
      receipts[key] = { ...receipts[key], status: 'PENDING', acceptedAt: now.toISOString(), providerIds: safeIds };
      ledgerResult = { conflicts: [...recorded.conflicts, ...observed.missing.map(field => ({ reason: 'PROVIDER_ID_MISSING', field }))] };
    } else {
      const source = component === 'avatar'
        ? { sha256: enrollment.photoSha256, bytes: (await tx.select().from(mediaAssets).where(and(eq(mediaAssets.id, enrollment.photoAssetId), eq(mediaAssets.accountId, accountId))).limit(1))[0]?.bytes }
        : { sha256: enrollment.derivedAudioSha256, bytes: enrollment.derivedAudioBytes };
      ledgerResult = await recordProviderOperationResourcesTx(tx, {
        accountId,
        operationId: receipts[key].ledgerOperationId,
        resources: providerResourcesForReceipt(component, stage, safeIds, source),
        now,
      });
      receipts[key] = { ...receipts[key], status: ledgerResult.conflicts.length ? 'PENDING' : 'ACCEPTED', acceptedAt: now.toISOString(), providerIds: safeIds };
    }
    const reconciliation = enrollment.revokedAt || enrollment.status === ENROLLMENT_STATUSES.REVOKED
      ? 'PENDING' : reconciliationStatusForReceipts(receipts, enrollment.providerReconciliationStatus);
    const [updated] = await tx.update(identityVideoEnrollments).set({ providerReceipts: receipts, providerReconciliationStatus: reconciliation, updatedAt: now })
      .where(eq(identityVideoEnrollments.id, enrollment.id)).returning();
    await event(tx, enrollment, 'enrollment.provider_receipt', enrollment.status, enrollment.status, { component, stage, orphaned: reconciliation === 'PENDING' });
    return { enrollment: updated, orphaned: reconciliation === 'PENDING', ledgerConflicts: ledgerResult.conflicts };
  });
}

export async function completeEnrollmentProviderOperation({ accountId, identityId, component, stage, operationKey, providerBinding, now = new Date() }) {
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    const bindingAuthority = assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const enrollment = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId))).for('update').limit(1))[0];
    if (!enrollment) return null;
    const key = providerReceiptKey(component, stage);
    const receipts = { ...(enrollment.providerReceipts || {}) };
    if (receipts[key]?.operationKey !== operationKey || receipts[key]?.status !== 'ACCEPTED') throw failure('Enrollment provider completion does not match its receipt.', 409, 'RECONCILIATION', 'PROVIDER_RECEIPT_CONFLICT');
    await assertProviderReceiptOperationTx(tx, {
      accountId, providerBinding, operationId: receipts[key].ledgerOperationId,
    });
    if (stage === 'create') {
      const rawProviderAssetId = receipts[`${component}:asset`]?.providerIds?.providerAssetId;
      if (!rawProviderAssetId) throw failure('Provider source asset receipt is missing.', 409, 'RECONCILIATION', 'PROVIDER_RESOURCE_UNVERIFIED');
      const rawResource = await getExactProviderResourceTx(tx, { accountId, kind: 'asset', providerResourceId: rawProviderAssetId });
      assertClaimResourceBinding(rawResource, bindingAuthority);
      const derivedIds = component === 'avatar'
        ? [
          ['avatar_group', receipts[key].providerIds?.providerAvatarGroupId],
          ['avatar_look', receipts[key].providerIds?.providerRenderableAvatarId],
        ]
        : [['voice', receipts[key].providerIds?.providerVoiceId]];
      for (const [kind, providerResourceId] of derivedIds) {
        const derived = await getExactProviderResourceTx(tx, { accountId, kind, providerResourceId });
        assertClaimResourceBinding(derived, bindingAuthority);
        await attachProviderConsumerReferenceTx(tx, {
          accountId, resourceId: rawResource.id, consumerKind: 'provider_resource', consumerId: derived.id,
          originOperationId: receipts[key].ledgerOperationId, now,
        });
      }
    }
    receipts[key] = { ...receipts[key], status: 'COMPLETE', completedAt: now.toISOString() };
    const reconciliation = reconciliationStatusForReceipts(receipts, enrollment.providerReconciliationStatus);
    const [updated] = await tx.update(identityVideoEnrollments).set({ providerReceipts: receipts, providerReconciliationStatus: reconciliation, updatedAt: now })
      .where(eq(identityVideoEnrollments.id, enrollment.id)).returning();
    return updated;
  });
}

export async function failEnrollmentProviderOperation({ accountId, identityId, component, stage, operationKey, providerBinding, ambiguous = false, now = new Date() }) {
  return withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, async tx => {
    assertHeygenProviderReceiptTx(tx, { accountId, providerBinding });
    const enrollment = (await tx.select().from(identityVideoEnrollments).where(and(eq(identityVideoEnrollments.accountId, accountId), eq(identityVideoEnrollments.identityId, identityId))).for('update').limit(1))[0];
    if (!enrollment) return null;
    const key = providerReceiptKey(component, stage);
    const receipts = { ...(enrollment.providerReceipts || {}) };
    if (receipts[key]?.operationKey !== operationKey) return enrollment;
    if (receipts[key]?.ledgerOperationId) {
      await assertProviderReceiptOperationTx(tx, {
        accountId, providerBinding, operationId: receipts[key].ledgerOperationId,
      });
      await recordProviderOperationFailureTx(tx, {
        accountId, operationId: receipts[key].ledgerOperationId, ambiguous,
        code: ambiguous ? 'PROVIDER_RESULT_UNKNOWN' : 'PROVIDER_OPERATION_FAILED', now,
      });
    }
    receipts[key] = { ...receipts[key], status: ambiguous ? 'PENDING' : 'FAILED', failedAt: now.toISOString() };
    const reconciliation = reconciliationStatusForReceipts(receipts, enrollment.providerReconciliationStatus);
    const [updated] = await tx.update(identityVideoEnrollments).set({ providerReceipts: receipts, providerReconciliationStatus: reconciliation, updatedAt: now })
      .where(eq(identityVideoEnrollments.id, enrollment.id)).returning();
    return updated;
  });
}
