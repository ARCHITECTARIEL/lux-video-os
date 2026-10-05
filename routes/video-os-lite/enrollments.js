import { start } from 'workflow/api';
import crypto from 'node:crypto';
import {
  createEnrollment,
  acceptEnrollmentUpload,
  claimEnrollmentWorkflowDispatch,
  expireEnrollment,
  getOwnedEnrollment,
  grantProviderBridgeReconsent,
  grantEnrollmentConsent,
  listOwnedEnrollments,
  recordEnrollmentCleanup,
  recordEnrollmentWorkflowRun,
  retryEnrollment,
  revokeEnrollment,
} from '../../db/enrollment-repository.js';
import { consumeRateLimit, ensureAccount, getOwnedIdentity, getOwnedMediaAsset, requireAnyPersistedRenderAuthorization } from '../../db/repositories.js';
import { enrollmentCapabilitiesDto, enrollmentDto } from '../../lib/enrollment-dto.js';
import {
  ENROLLMENT_EXTRACTION_FLAG,
  ENROLLMENT_MEDIA_LIMITS,
  ENROLLMENT_STATUSES,
  assertEnrollmentAccountAllowed,
  assertEnrollmentCanaryRecord,
  assertEnrollmentCapability,
  assertEnrollmentExtractionCapability,
  assertEnrollmentPrivateReadback,
  enrollmentEnabled,
  enrollmentAccountAllowed,
  enrollmentCanaryStartedAt,
  enrollmentUploadInstructions,
  parseEnrollmentRequest,
  validateEnrollmentTransport,
} from '../../lib/enrollment-policy.js';
import { DEFAULT_TRIAL_CREDITS, handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../../lib/video-os-private-blob.js';
import { accountHash } from '../../lib/video-os-security.js';
import { identityEnrollmentCleanupWorkflowMetadata, identityEnrollmentExpiryWorkflowMetadata, identityEnrollmentExtractionWorkflowMetadata, identityEnrollmentHashWorkflowMetadata } from '../../workflows/identity-enrollment-metadata.js';

async function dtoFor(record, dependencies) {
  const identity = record?.identityId ? await dependencies.getOwnedIdentity(record.accountId, record.identityId) : null;
  const assetIds = [record?.photoAssetId, record?.sourceVideoAssetId, record?.derivedVoiceAssetId].filter(Boolean).sort();
  const assets = [];
  for (const assetId of assetIds) assets.push(await dependencies.getOwnedMediaAsset(record.accountId, assetId).catch(() => null));
  const byId = new Map(assets.filter(Boolean).map(asset => [asset.id, asset]));
  const photo = byId.get(record?.photoAssetId);
  const source = byId.get(record?.sourceVideoAssetId);
  const voice = byId.get(record?.derivedVoiceAssetId);
  const enrollmentPrefix = `video-os/enrollment-sources/${accountHash(record.accountId)}/${record.id}/`;
  const sourceMetadataVerified = Boolean(
    photo && !photo.quarantinedAt && photo.kind === 'identity-photo-source' && photo.sha256 === record.photoSha256
    && Number.isSafeInteger(photo.bytes) && photo.bytes > 0 && String(photo.privatePathname || '').startsWith('video-os/uploads/')
    && source && !source.quarantinedAt && source.kind === 'identity-phone-video-source' && source.sha256 === record.sourceSha256
    && source.bytes === record.sourceBytes && source.privatePathname === record.uploadPathname
    && voice && !voice.quarantinedAt && voice.kind === 'identity-voice-source' && voice.sha256 === record.derivedAudioSha256
    && voice.bytes === record.derivedAudioBytes && String(voice.privatePathname || '').startsWith(enrollmentPrefix)
  );
  return enrollmentDto(record, identity, { sourceMetadataVerified });
}

async function cancelStream(stream) {
  if (typeof stream?.destroy === 'function') stream.destroy();
  else if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
}

function responseLifecycle(res) {
  if (typeof res.once !== 'function' || typeof res.removeListener !== 'function') {
    return { waitForDrain: async () => {}, close: () => {} };
  }
  let terminalError;
  const drainWaiters = new Set();
  const stop = error => {
    if (terminalError) return;
    terminalError = error;
    for (const waiter of drainWaiters) {
      res.removeListener('drain', waiter.onDrain);
      waiter.reject(error);
    }
    drainWaiters.clear();
  };
  const onClose = () => stop(new Error('Enrollment preview response closed.'));
  const onError = error => stop(error);
  res.once('close', onClose);
  res.once('error', onError);
  return {
    waitForDrain: () => {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = {
          reject,
          onDrain: () => {
            drainWaiters.delete(waiter);
            resolve();
          },
        };
        drainWaiters.add(waiter);
        res.once('drain', waiter.onDrain);
      });
    },
    close: () => {
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      for (const waiter of drainWaiters) res.removeListener('drain', waiter.onDrain);
      drainWaiters.clear();
    },
  };
}

async function streamEnrollmentVideo(record, res, dependencies) {
  if (!record.uploadEtag || record.revokedAt || record.sourceDeletedAt || record.status === ENROLLMENT_STATUSES.AWAITING_UPLOAD) return send(res, 404, { ok: false, error: 'Enrollment video is unavailable.' });
  const stored = await dependencies.getPrivateBlob(record.uploadPathname);
  if (!stored?.stream || stored.blob?.pathname !== record.uploadPathname || stored.blob?.etag !== record.uploadEtag) {
    await cancelStream(stored?.stream);
    return send(res, 410, { ok: false, error: 'Enrollment video is unavailable.' });
  }
  const expectedBytes = Number(record.sourceBytes || record.declaredBytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > ENROLLMENT_MEDIA_LIMITS.maxSourceBytes) {
    await cancelStream(stored.stream);
    return send(res, 410, { ok: false, error: 'Enrollment video is unavailable.' });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', record.sourceMetadata?.mimeType || record.declaredContentType);
  res.setHeader('Content-Length', String(expectedBytes));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let bytes = 0;
  let completed = false;
  const lifecycle = responseLifecycle(res);
  try {
    for await (const value of stored.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > expectedBytes || bytes > ENROLLMENT_MEDIA_LIMITS.maxSourceBytes) {
        res.destroy?.();
        return;
      }
      if (res.write(chunk) === false) await lifecycle.waitForDrain();
    }
    if (bytes !== expectedBytes) { res.destroy?.(); return; }
    res.end();
    completed = true;
  } catch {
    res.destroy?.();
  } finally {
    lifecycle.close();
    if (!completed) await cancelStream(stored.stream);
  }
}

async function dispatch(record, dependencies) {
  const metadata = record.status === ENROLLMENT_STATUSES.SOURCE_HASHING
    ? identityEnrollmentHashWorkflowMetadata
    : record.status === ENROLLMENT_STATUSES.EXTRACTION_QUEUED
      ? identityEnrollmentExtractionWorkflowMetadata
      : null;
  if (!metadata || !record.workflowOperationKey) return { dispatched: false, pending: false };
  const claim = await dependencies.claimEnrollmentWorkflowDispatch(record.id, record.workflowOperationKey);
  if (!claim.claimed) return { dispatched: Boolean(claim.dispatched), pending: !claim.dispatched };
  try {
    const run = await dependencies.start(metadata, [record.id, record.workflowOperationKey]);
    await dependencies.recordEnrollmentWorkflowRun(record.id, record.workflowOperationKey, claim.dispatchClaim, run.runId);
    return { dispatched: true, pending: false, workflowRunId: run.runId };
  } catch {
    return { dispatched: false, pending: true };
  }
}

async function cleanupRevoked(record, dependencies) {
  const candidates = [{ classification: PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, pathname: record.uploadPathname }];
  if (record.derivedVoiceAssetId) {
    const asset = await dependencies.getOwnedMediaAsset(record.accountId, record.derivedVoiceAssetId).catch(() => null);
    if (asset?.privatePathname) candidates.push({ classification: PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, pathname: asset.privatePathname });
  }
  let deleted = true;
  for (const candidate of candidates) {
    try {
      const stored = await dependencies.getPrivateBlob(candidate.pathname);
      await cancelStream(stored?.stream);
      if (stored?.blob?.etag) await dependencies.deletePrivateBlob(candidate.classification, candidate.pathname, { ifMatch: stored.blob.etag });
    } catch { deleted = false; }
  }
  await dependencies.recordEnrollmentCleanup({ enrollmentId: record.id, deleted }).catch(() => {});
  return deleted;
}

export function createEnrollmentHandler(overrides = {}) {
  const dependencies = {
    createEnrollment,
    acceptEnrollmentUpload,
    claimEnrollmentWorkflowDispatch,
    consumeRateLimit,
    deletePrivateBlob,
    ensureAccount,
    expireEnrollment,
    getOwnedEnrollment,
    getOwnedIdentity,
    getOwnedMediaAsset,
    getPrivateBlob,
    grantProviderBridgeReconsent,
    grantEnrollmentConsent,
    listOwnedEnrollments,
    recordEnrollmentCleanup,
    recordEnrollmentWorkflowRun,
    requireAnyPersistedRenderAuthorization,
    retryEnrollment,
    revokeEnrollment,
    sessionFromRequest,
    start,
    ...overrides,
  };
  return async function handler(req, res) {
    if (handleOptions(req, res)) return;
    try {
      const session = dependencies.sessionFromRequest(req);
      if (req.method === 'GET') {
        const enabled = enrollmentEnabled() && enrollmentAccountAllowed(session.accountId);
        const capabilities = enrollmentCapabilitiesDto({ enabled, extractionEnabled: enabled && String(process.env[ENROLLMENT_EXTRACTION_FLAG] || '').toLowerCase() === 'true' });
        if (enabled) assertEnrollmentCapability();
        const url = new URL(req.url, 'https://video-os.invalid');
        const enrollmentId = url.searchParams.get('enrollmentId');
        try {
          if (enrollmentId) {
            const record = await dependencies.getOwnedEnrollment(session.accountId, enrollmentId);
            if (!record) return send(res, 404, { ok: false, error: 'Enrollment not found.' });
            if (url.searchParams.get('preview') === 'video') return streamEnrollmentVideo(record, res, dependencies);
            return send(res, 200, { ok: true, ...capabilities, enrollment: await dtoFor(record, dependencies) });
          }
          const records = await dependencies.listOwnedEnrollments(session.accountId);
          return send(res, 200, { ok: true, ...capabilities, enrollments: await Promise.all(records.map(record => dtoFor(record, dependencies))) });
        } catch (error) {
          if (!enabled && String(error?.code || '') === '42P01') return send(res, 200, { ok: true, ...capabilities, enrollments: [] });
          throw error;
        }
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use GET or POST for enrollments.' });
      validateEnrollmentTransport(req);
      const input = parseEnrollmentRequest(await readJson(req));
      if (input.action === 'revoke') {
        const result = await dependencies.revokeEnrollment({ accountId: session.accountId, input });
        const cleanupPending = !(await cleanupRevoked(result.enrollment, dependencies));
        if (cleanupPending) await dependencies.start(identityEnrollmentCleanupWorkflowMetadata, [result.enrollment.id]).catch(() => {});
        // A previously issued multipart token remains usable until uploadExpiresAt.
        // Recheck the exact private path after that capability expires even when
        // this immediate pass found no object and recorded cleanup as complete.
        await dependencies.start(identityEnrollmentExpiryWorkflowMetadata, [result.enrollment.id]).catch(() => {});
        return send(res, 200, { ok: true, enrollment: await dtoFor(result.enrollment, dependencies), cleanupPending });
      }
      assertEnrollmentAccountAllowed(session.accountId);
      if (input.action === 'create') assertEnrollmentExtractionCapability();
      else assertEnrollmentCapability();
      if (enrollmentCanaryStartedAt()) {
        if (input.action === 'provider-reconsent') {
          throw Object.assign(new Error('Provider reconsent is outside the private enrollment canary.'), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
        }
        if (input.action !== 'create') {
          const canaryRecord = await dependencies.getOwnedEnrollment(session.accountId, input.enrollmentId);
          if (!canaryRecord) return send(res, 404, { ok: false, error: 'Enrollment not found.' });
          assertEnrollmentCanaryRecord(canaryRecord);
        }
      }
      const allowed = await dependencies.consumeRateLimit({ accountId: session.accountId, key: `enrollment:hourly:${session.accountId}`, limit: 20, windowMs: 60 * 60 * 1000 });
      if (!allowed) throw Object.assign(new Error('Enrollment request limit reached.'), { statusCode: 429, failureCategory: 'VALIDATION' });
      await dependencies.ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: DEFAULT_TRIAL_CREDITS });
      await dependencies.requireAnyPersistedRenderAuthorization(session.accountId);
      if (input.action === 'create') {
        const result = await dependencies.createEnrollment({ accountId: session.accountId, correlationId: crypto.randomUUID(), input });
        await dependencies.start(identityEnrollmentExpiryWorkflowMetadata, [result.enrollment.id]).catch(() => {});
        return send(res, result.replayed ? 200 : 201, { ok: true, enrollment: await dtoFor(result.enrollment, dependencies), upload: enrollmentUploadInstructions(result.enrollment) });
      }
      if (input.action === 'consent') {
        const result = await dependencies.grantEnrollmentConsent({ accountId: session.accountId, input });
        const delivery = await dispatch(result.enrollment, dependencies);
        return send(res, 202, { ok: true, enrollment: await dtoFor(result.enrollment, dependencies), dispatchPending: delivery.pending });
      }
      if (input.action === 'provider-reconsent') {
        const result = await dependencies.grantProviderBridgeReconsent({ accountId: session.accountId, input });
        return send(res, result.replayed ? 200 : 201, { ok: true, enrollment: await dtoFor(result.enrollment, dependencies) });
      }
      if (input.action === 'retry') {
        const result = await dependencies.retryEnrollment({ accountId: session.accountId, input });
        const delivery = await dispatch(result.enrollment, dependencies);
        return send(res, 202, { ok: true, enrollment: await dtoFor(result.enrollment, dependencies), dispatchPending: delivery.pending });
      }
      let record = await dependencies.getOwnedEnrollment(session.accountId, input.enrollmentId);
      if (!record) return send(res, 404, { ok: false, error: 'Enrollment not found.' });
      if (record.stateVersion !== input.expectedStateVersion) throw Object.assign(new Error('Enrollment state changed.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      record = await dependencies.expireEnrollment({ accountId: session.accountId, enrollmentId: record.id });
      if (record?.status === ENROLLMENT_STATUSES.EXPIRED && record.cleanupStatus === 'PENDING') await dependencies.start(identityEnrollmentCleanupWorkflowMetadata, [record.id]).catch(() => {});
      if (input.action === 'upload-instructions') {
        return send(res, 200, { ok: true, enrollment: await dtoFor(record, dependencies), upload: enrollmentUploadInstructions(record) });
      }
      if (input.action === 'reconcile-upload') {
        if (record.status === ENROLLMENT_STATUSES.AWAITING_UPLOAD) {
          const capability = assertEnrollmentCapability();
          const stored = await dependencies.getPrivateBlob(record.uploadPathname);
          const etag = stored?.blob?.etag;
          try {
            assertEnrollmentPrivateReadback(stored, { ...record, uploadEtag: etag }, capability.storeId);
          } catch (error) {
            if (etag) await dependencies.deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, record.uploadPathname, { ifMatch: etag }).catch(() => {});
            throw error;
          } finally {
            await cancelStream(stored?.stream);
          }
          const accepted = await dependencies.acceptEnrollmentUpload({
            enrollmentId: record.id, operationKey: record.uploadOperationKey, pathname: record.uploadPathname,
            etag, contentType: stored.blob?.contentType || record.declaredContentType,
          });
          record = accepted.enrollment;
        }
        if (record.status !== ENROLLMENT_STATUSES.SOURCE_HASHING) throw Object.assign(new Error('Upload reconciliation requires an uploaded source.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
        const delivery = await dispatch(record, dependencies);
        return send(res, 202, { ok: true, enrollment: await dtoFor(record, dependencies), dispatchPending: delivery.pending });
      }
      throw Object.assign(new Error('Enrollment action is unsupported.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    } catch (error) {
      return send(res, error.statusCode || 500, { ok: false, code: String(error.code || error.failureCategory || 'ENROLLMENT_ERROR').slice(0, 80), error: error.statusCode && error.statusCode < 500 ? error.message : 'Enrollment could not complete this request.' });
    }
  };
}

export default createEnrollmentHandler();
