// Routed through the consolidated workspace function to stay within the Vercel function limit.
import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import { database } from '../../db/client.js';
import { getPrivateBlob } from '../../lib/video-os-private-blob.js';
import { getOwnedMediaAsset } from '../../db/repositories.js';
import { identityVideoEnrollments, userIdentities } from '../../db/schema.js';
import { identityPhotoPreviewVerified } from '../../lib/enrollment-dto.js';
import { ENROLLMENT_STATUSES } from '../../lib/enrollment-policy.js';
import { IDENTITY_UPLOAD_LIMITS } from '../../lib/identity-upload.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';

async function getCurrentIdentityPhotoBinding(accountId, assetId) {
  const [row] = await database().select({
    enrollmentId: identityVideoEnrollments.id,
    enrollmentAccountId: identityVideoEnrollments.accountId,
    enrollmentStatus: identityVideoEnrollments.status,
    enrollmentIdentityId: identityVideoEnrollments.identityId,
    enrollmentPhotoAssetId: identityVideoEnrollments.photoAssetId,
    enrollmentPhotoSha256: identityVideoEnrollments.photoSha256,
    enrollmentRevokedAt: identityVideoEnrollments.revokedAt,
    identityId: userIdentities.id,
    identityAccountId: userIdentities.accountId,
    identityPhotoAssetId: userIdentities.sourcePhotoAssetId,
    identityArchivedAt: userIdentities.archivedAt,
  }).from(identityVideoEnrollments).innerJoin(userIdentities, and(
    eq(userIdentities.id, identityVideoEnrollments.identityId),
    eq(userIdentities.accountId, identityVideoEnrollments.accountId),
  )).where(and(
    eq(identityVideoEnrollments.accountId, accountId),
    eq(identityVideoEnrollments.photoAssetId, assetId),
    eq(identityVideoEnrollments.status, ENROLLMENT_STATUSES.IDENTITY_READY),
    isNull(identityVideoEnrollments.revokedAt),
    eq(userIdentities.sourcePhotoAssetId, assetId),
    isNull(userIdentities.archivedAt),
  )).limit(1);
  if (!row) return null;
  return {
    enrollment: {
      id: row.enrollmentId,
      accountId: row.enrollmentAccountId,
      status: row.enrollmentStatus,
      identityId: row.enrollmentIdentityId,
      photoAssetId: row.enrollmentPhotoAssetId,
      photoSha256: row.enrollmentPhotoSha256,
      revokedAt: row.enrollmentRevokedAt,
    },
    identity: {
      id: row.identityId,
      accountId: row.identityAccountId,
      sourcePhotoAssetId: row.identityPhotoAssetId,
      archivedAt: row.identityArchivedAt,
    },
  };
}

function fail(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error }));
}

async function cancelStream(stream) {
  if (typeof stream?.destroy === 'function') stream.destroy();
  else if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
}

async function readVerifiedIdentityAsset(result, asset, maximumBytes) {
  const expectedBytes = Number(asset.bytes);
  const blob = result?.blob || result;
  if (!result?.stream || blob?.pathname !== asset.privatePathname
    || (blob?.size !== undefined && Number(blob.size) !== expectedBytes)
    || (blob?.contentType && blob.contentType !== asset.contentType)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes
    || !/^[a-f0-9]{64}$/.test(String(asset.sha256 || ''))) {
    await cancelStream(result?.stream);
    return null;
  }
  const chunks = [];
  let bytes = 0;
  let verified = false;
  try {
    for await (const value of result.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > expectedBytes || bytes > maximumBytes) return null;
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks, bytes);
    if (bytes !== expectedBytes || crypto.createHash('sha256').update(buffer).digest('hex') !== asset.sha256) return null;
    verified = true;
    return buffer;
  } catch {
    return null;
  } finally {
    if (!verified) await cancelStream(result.stream);
  }
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
  const onClose = () => stop(new Error('Asset response closed.'));
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

export function createAssetHandler(overrides = {}) {
  const dependencies = { getCurrentIdentityPhotoBinding, getPrivateBlob, getOwnedMediaAsset, sessionFromRequest, ...overrides };
  return async function handler(req, res) {
    if (req.method !== 'GET') return fail(res, 405, 'Use GET to retrieve an asset.');
    try {
      const session = dependencies.sessionFromRequest(req);
      const assetId = new URL(req.url, 'https://video-os.invalid').searchParams.get('assetId');
      const asset = await dependencies.getOwnedMediaAsset(session.accountId, assetId);
      if (!asset || asset.quarantinedAt) return fail(res, 404, 'Asset not found.');
      if (asset.kind === 'identity-photo-source') {
        const binding = await dependencies.getCurrentIdentityPhotoBinding(session.accountId, asset.id);
        if (!binding || !identityPhotoPreviewVerified(binding.enrollment, binding.identity, asset)) {
          return fail(res, 404, 'Asset not found.');
        }
      }
      const result = await dependencies.getPrivateBlob(asset.privatePathname);
      if (!result?.stream) return fail(res, 410, 'Asset is unavailable.');
      const expectedBytes = Number(asset.bytes);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
        await cancelStream(result.stream);
        return fail(res, 410, 'Asset is unavailable.');
      }
      if (asset.kind === 'identity-photo-source') {
        if (!['image/jpeg', 'image/png'].includes(asset.contentType)) {
          await cancelStream(result.stream);
          return fail(res, 410, 'Asset is unavailable.');
        }
        const buffer = await readVerifiedIdentityAsset(result, asset, IDENTITY_UPLOAD_LIMITS.photoBytes);
        if (!buffer) return fail(res, 410, 'Asset is unavailable.');
        res.statusCode = 200;
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', String(expectedBytes));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(buffer);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Content-Length', String(asset.bytes));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      let bytes = 0;
      let completed = false;
      const lifecycle = responseLifecycle(res);
      try {
        for await (const value of result.stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          bytes += chunk.length;
          if (bytes > expectedBytes) { res.destroy?.(); return; }
          if (res.write(chunk) === false) await lifecycle.waitForDrain();
        }
        if (bytes !== expectedBytes) { res.destroy?.(); return; }
        res.end();
        completed = true;
      } finally {
        lifecycle.close();
        if (!completed) await cancelStream(result.stream);
      }
    } catch (error) {
      if (res.headersSent) { res.destroy?.(); return; }
      return fail(res, error.statusCode || 500, error.statusCode === 401 ? error.message : 'Asset retrieval failed.');
    }
  };
}

export default createAssetHandler();
