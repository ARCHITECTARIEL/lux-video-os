import { handleUpload } from '@vercel/blob/client';
import { start } from 'workflow/api';

import { acceptEnrollmentUpload, authorizeEnrollmentUpload, claimEnrollmentWorkflowDispatch, expireEnrollmentInternal, getEnrollmentForUploadCallback, recordEnrollmentCleanup, recordEnrollmentWorkflowRun } from '../../db/enrollment-repository.js';
import {
  ENROLLMENT_ALLOWED_CONTENT_TYPES,
  ENROLLMENT_MEDIA_LIMITS,
  assertEnrollmentCapability,
  assertEnrollmentPrivateReadback,
  decodeEnrollmentUploadContext,
  enrollmentNeedsTerminalCleanup,
  validateEnrollmentTransport,
} from '../../lib/enrollment-policy.js';
import { readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../../lib/video-os-private-blob.js';
import { assertEnrollmentPrivateStoreReady } from '../../lib/enrollment-private-store.js';
import { identityEnrollmentCleanupWorkflowMetadata, identityEnrollmentExpiryWorkflowMetadata, identityEnrollmentHashWorkflowMetadata } from '../../workflows/identity-enrollment-metadata.js';

async function cleanupRejectedTerminalUpload(enrollment, blob, dependencies) {
  let current = await dependencies.getEnrollmentForUploadCallback(enrollment.id, enrollment.uploadOperationKey).catch(() => null);
  if (current?.status === 'AWAITING_UPLOAD' && new Date(current.uploadExpiresAt) <= new Date()) {
    current = await dependencies.expireEnrollmentInternal(current.id).catch(() => current);
  }
  if (!enrollmentNeedsTerminalCleanup(current)) return false;
  let deleted = false;
  try {
    await dependencies.deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, enrollment.uploadPathname, { ifMatch: blob.etag });
    deleted = true;
  } catch {}
  await dependencies.recordEnrollmentCleanup({ enrollmentId: enrollment.id, deleted }).catch(() => {});
  if (!deleted) await dependencies.start(identityEnrollmentCleanupWorkflowMetadata, [enrollment.id]).catch(() => {});
  return deleted;
}

export function createEnrollmentUploadHandler(overrides = {}) {
  const dependencies = {
    acceptEnrollmentUpload,
    assertEnrollmentPrivateStoreReady,
    authorizeEnrollmentUpload,
    claimEnrollmentWorkflowDispatch,
    getEnrollmentForUploadCallback,
    getPrivateBlob,
    deletePrivateBlob,
    expireEnrollmentInternal,
    handleUpload,
    sessionFromRequest,
    recordEnrollmentWorkflowRun,
    recordEnrollmentCleanup,
    start,
    ...overrides,
  };
  return async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST for enrollment uploads.' });
    try {
      const capability = assertEnrollmentCapability();
      const body = req.body && typeof req.body === 'object' ? req.body : await readJson(req);
      const tokenRequest = body?.type === 'blob.generate-client-token';
      let tokenAccountId;
      if (tokenRequest) {
        validateEnrollmentTransport(req);
        tokenAccountId = dependencies.sessionFromRequest(req).accountId;
        await dependencies.assertEnrollmentPrivateStoreReady();
      }
      const result = await dependencies.handleUpload({
        token: process.env.BLOB_READ_WRITE_TOKEN,
        request: req,
        body,
        onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
          if (!tokenAccountId || multipart !== true) throw Object.assign(new Error('Enrollment upload must use authenticated multipart upload.'), { statusCode: 400, failureCategory: 'VALIDATION' });
          const context = decodeEnrollmentUploadContext(clientPayload);
          const enrollment = await dependencies.authorizeEnrollmentUpload({
            accountId: tokenAccountId, enrollmentId: context.enrollmentId, operationKey: context.operationKey, pathname,
          });
          return {
            allowedContentTypes: [enrollment.declaredContentType],
            maximumSizeInBytes: Math.min(enrollment.declaredBytes, ENROLLMENT_MEDIA_LIMITS.maxSourceBytes),
            validUntil: new Date(enrollment.uploadExpiresAt).getTime(),
            addRandomSuffix: false,
            allowOverwrite: false,
            cacheControlMaxAge: 60,
            tokenPayload: clientPayload,
            callbackUrl: `${capability.publicOrigin}/api/video-os-lite/enrollment-upload`,
          };
        },
        onUploadCompleted: async ({ blob, tokenPayload }) => {
          const context = decodeEnrollmentUploadContext(tokenPayload);
          const enrollment = await dependencies.getEnrollmentForUploadCallback(context.enrollmentId, context.operationKey);
          if (!blob || blob.pathname !== enrollment.uploadPathname || blob.contentType !== enrollment.declaredContentType || !blob.etag
            || !ENROLLMENT_ALLOWED_CONTENT_TYPES.includes(blob.contentType)) {
            throw Object.assign(new Error('Enrollment upload callback does not match its operation.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
          }
          const readback = await dependencies.getPrivateBlob(enrollment.uploadPathname);
          try {
            assertEnrollmentPrivateReadback(readback, { ...enrollment, uploadEtag: blob.etag }, capability.storeId);
          } catch (error) {
            await dependencies.deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, enrollment.uploadPathname, { ifMatch: blob.etag }).catch(() => {});
            throw error;
          } finally {
            if (typeof readback?.stream?.destroy === 'function') readback.stream.destroy();
            else if (typeof readback?.stream?.cancel === 'function') await readback.stream.cancel().catch(() => {});
          }
          let accepted;
          try {
            accepted = await dependencies.acceptEnrollmentUpload({
              enrollmentId: enrollment.id, operationKey: context.operationKey, pathname: blob.pathname, etag: blob.etag, contentType: blob.contentType,
            });
          } catch (error) {
            await cleanupRejectedTerminalUpload(enrollment, blob, dependencies);
            throw error;
          }
          await dependencies.start(identityEnrollmentExpiryWorkflowMetadata, [accepted.enrollment.id]).catch(() => {});
          if (accepted.dispatch && accepted.enrollment.workflowOperationKey) {
            const claim = await dependencies.claimEnrollmentWorkflowDispatch(accepted.enrollment.id, accepted.enrollment.workflowOperationKey);
            if (claim.claimed) {
              try {
                const run = await dependencies.start(identityEnrollmentHashWorkflowMetadata, [accepted.enrollment.id, accepted.enrollment.workflowOperationKey]);
                await dependencies.recordEnrollmentWorkflowRun(accepted.enrollment.id, accepted.enrollment.workflowOperationKey, claim.dispatchClaim, run.runId);
              } catch {}
            }
          }
        },
      });
      return send(res, 200, result);
    } catch (error) {
      return send(res, error.statusCode || 500, { ok: false, code: String(error.code || error.failureCategory || 'ENROLLMENT_UPLOAD_ERROR').slice(0, 80), error: error.statusCode && error.statusCode < 500 ? error.message : 'Enrollment upload is unavailable.' });
    }
  };
}

export default createEnrollmentUploadHandler();
