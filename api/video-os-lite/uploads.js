import crypto from 'node:crypto';
import { assertDatabaseConfigured } from '../../db/client.js';
import { addUploadMediaAsset, getOwnedMediaAsset } from '../../db/repositories.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';
import { validateIdentityUpload } from '../../lib/identity-upload.js';
import { deletePrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../../lib/video-os-private-blob.js';
import { accountHash, requestId } from '../../lib/video-os-security.js';

const MAX_UPLOAD_BYTES = 20_000_000;
const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(payload));
}

function safeName(value) {
  return String(value || 'avatar-source').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'avatar-source';
}

function routeError(message, statusCode, failureCategory, publicCode) {
  return Object.assign(new Error(message), { statusCode, failureCategory, publicCode, publicMessage: message });
}

function stableMediaAssetId(accountId, correlationId) {
  const bytes = crypto.createHash('sha256').update(`${accountId}\0${correlationId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assetMatchesUpload(asset, expected) {
  return Boolean(asset
    && asset.id === expected.id
    && asset.accountId === expected.accountId
    && asset.privatePathname === expected.privatePathname
    && asset.kind === expected.kind
    && asset.contentType === expected.contentType
    && Number(asset.bytes) === expected.bytes
    && asset.sha256 === expected.sha256);
}

function uploadSuccess(asset, expected, payload, correlationId, status, state) {
  return {
    status,
    body: {
      ok: true,
      url: null,
      providerUrl: null,
      downloadUrl: null,
      filename: expected.privatePathname.split('/').pop(),
      pathname: expected.privatePathname,
      assetId: asset.id,
      operationId: expected.id,
      previewUrl: `/api/video-os-lite/asset?assetId=${encodeURIComponent(asset.id)}`,
      mime: expected.contentType,
      accountId: expected.accountId,
      kind: payload.kind || 'avatar',
      size: expected.bytes,
      requiresPublicUrl: !['identity_photo', 'identity_voice'].includes(payload.kind),
      correlationId,
      idempotent: state === 'idempotent',
      recovered: state === 'recovered',
      message: ['identity_photo', 'identity_voice'].includes(payload.kind)
        ? 'Identity source stored privately.'
        : 'Upload stored privately. Provider submission remains disabled until short-lived private delivery is verified.',
    },
  };
}

function logUploadPersistenceError(entry) {
  console.error(JSON.stringify({ event: 'video_os_upload_persistence_failure', ...entry }));
}

export function detectedUploadMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return null;
}

export function createUploadHandler(overrides = {}) {
  const dependencies = {
    addUploadMediaAsset,
    assertDatabaseConfigured,
    blobToken: () => process.env.BLOB_READ_WRITE_TOKEN,
    deletePrivateBlob,
    getOwnedMediaAsset,
    logUploadPersistenceError,
    putPrivateBlob,
    requestId,
    sessionFromRequest,
    ...overrides,
  };

  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed' });
    const correlationId = dependencies.requestId(req);
    try {
      const session = dependencies.sessionFromRequest(req);
      const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const dataUrl = String(payload.dataUrl || '');
      const identityKind = payload.kind === 'identity_photo' ? 'photo' : payload.kind === 'identity_voice' ? 'voice' : null;
      let buffer;
      let mime;
      let ext;
      let identityMetadata = {};
      if (identityKind) {
        const validated = validateIdentityUpload({ dataUrl, kind: identityKind });
        buffer = validated.buffer;
        mime = validated.contentType;
        ext = validated.extension;
        identityMetadata = {
          widthPx: validated.width || null,
          heightPx: validated.height || null,
          durationMs: validated.durationSeconds ? Math.round(validated.durationSeconds * 1000) : null,
        };
      } else {
        if (!dataUrl.startsWith('data:') || !dataUrl.includes(',')) throw routeError('Choose an image or video file to upload first.', 400, 'VALIDATION', 'invalid_upload');
        const [header, encoded] = dataUrl.split(',', 2);
        mime = header.slice(5).split(';', 1)[0].toLowerCase();
        ext = ALLOWED[mime];
        if (!ext) throw routeError('Unsupported upload format. Use JPG, PNG, WebP, MP4, or MOV.', 400, 'VALIDATION', 'invalid_upload');
        buffer = Buffer.from(encoded, 'base64');
        if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw routeError('Uploads must be under 20 MB.', 400, 'VALIDATION', 'invalid_upload');
        const detectedMime = detectedUploadMime(buffer);
        if (!detectedMime || (mime === 'video/quicktime' ? detectedMime !== 'video/mp4' : detectedMime !== mime)) {
          throw routeError('Upload contents do not match the declared file type.', 400, 'VALIDATION', 'invalid_upload');
        }
      }

      try {
        dependencies.assertDatabaseConfigured();
      } catch {
        throw routeError('Upload service is temporarily unavailable.', 503, 'CONFIG_MISSING', 'database_unavailable');
      }
      const blobToken = dependencies.blobToken();
      if (!blobToken) throw routeError('Upload storage is unavailable.', 503, 'CONFIG_MISSING', 'upload_storage_unavailable');

      const mediaAssetId = stableMediaAssetId(session.accountId, correlationId);
      const pathname = `video-os/uploads/${accountHash(session.accountId)}/${safeName(payload.name)}-${mediaAssetId}${ext}`;
      const expected = {
        id: mediaAssetId,
        accountId: session.accountId,
        kind: identityKind === 'photo'
          ? 'identity-photo-source'
          : identityKind === 'voice'
            ? 'identity-voice-source'
            : payload.kind === 'digital_twin'
              ? 'avatar-video-source'
              : 'avatar-photo-source',
        privatePathname: pathname,
        contentType: mime,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        ...identityMetadata,
      };

      let priorAsset;
      try {
        priorAsset = await dependencies.getOwnedMediaAsset(session.accountId, mediaAssetId);
      } catch {
        throw routeError('Upload service is temporarily unavailable.', 503, 'PERSISTENCE', 'database_unavailable');
      }
      if (priorAsset) {
        if (!assetMatchesUpload(priorAsset, expected)) {
          throw routeError('This upload operation conflicts with an earlier request.', 409, 'IDEMPOTENCY_CONFLICT', 'upload_conflict');
        }
        const replay = uploadSuccess(priorAsset, expected, payload, correlationId, 200, 'idempotent');
        return send(res, replay.status, replay.body);
      }

      let blob;
      try {
        blob = await dependencies.putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, {
          contentType: mime,
          token: blobToken,
          addRandomSuffix: false,
          allowOverwrite: false,
        });
      } catch {
        throw routeError('Upload storage is unavailable.', 503, 'PERSISTENCE', 'upload_storage_unavailable');
      }
      const privatePathname = String(blob?.pathname || '');
      if (privatePathname !== pathname || !blob?.etag) {
        throw routeError('Upload storage did not return an object identity.', 503, 'PERSISTENCE', 'upload_storage_unavailable');
      }

      let asset;
      try {
        asset = await dependencies.addUploadMediaAsset(expected);
      } catch (error) {
        const failureCategory = error?.failureCategory || 'PERSISTENCE';
        let observedAsset = null;
        let readbackSucceeded = false;
        try {
          observedAsset = await dependencies.getOwnedMediaAsset(session.accountId, mediaAssetId);
          readbackSucceeded = true;
        } catch {
          readbackSucceeded = false;
        }

        if (assetMatchesUpload(observedAsset, expected)) {
          const recovered = uploadSuccess(observedAsset, expected, payload, correlationId, 201, 'recovered');
          return send(res, recovered.status, recovered.body);
        }

        const safeContext = {
          correlationId,
          mediaAssetId,
          objectPathHash: crypto.createHash('sha256').update(privatePathname).digest('hex'),
          accountRef: accountHash(session.accountId),
          failureCategory,
        };

        if (error?.commitOutcome === 'not_committed' && readbackSucceeded && !observedAsset) {
          const cleanup = { attempted: true, succeeded: false };
          try {
            const result = await dependencies.deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, privatePathname, {
              token: blobToken,
              ifMatch: blob.etag,
            });
            cleanup.succeeded = result?.deleted === true;
          } catch {
            cleanup.succeeded = false;
          }
          try {
            dependencies.logUploadPersistenceError({ ...safeContext, commitOutcome: 'not_committed', cleanup });
          } catch {}
          throw routeError('Upload service is temporarily unavailable.', 503, failureCategory, 'database_unavailable');
        }

        try {
          dependencies.logUploadPersistenceError({ ...safeContext, commitOutcome: 'unknown' });
        } catch {}
        throw routeError('Upload service is temporarily unavailable.', 503, failureCategory, 'database_unavailable');
      }

      if (!assetMatchesUpload(asset, expected)) {
        try {
          dependencies.logUploadPersistenceError({
            correlationId,
            mediaAssetId,
            objectPathHash: crypto.createHash('sha256').update(privatePathname).digest('hex'),
            accountRef: accountHash(session.accountId),
            failureCategory: 'PERSISTENCE',
            commitOutcome: 'unknown',
          });
        } catch {}
        throw routeError('Upload service is temporarily unavailable.', 503, 'PERSISTENCE', 'database_unavailable');
      }
      const created = uploadSuccess(asset, expected, payload, correlationId, 201, 'created');
      return send(res, created.status, created.body);
    } catch (error) {
      const status = Number(error?.statusCode || 400);
      const infrastructureFailure = status >= 500 || ['CONFIG_MISSING', 'PERSISTENCE'].includes(error?.failureCategory);
      const code = infrastructureFailure ? (error?.publicCode || 'upload_unavailable') : (error?.publicCode || (status === 401 ? 'authentication_required' : status === 403 ? 'account_forbidden' : 'invalid_upload'));
      const message = infrastructureFailure
        ? 'Upload service is temporarily unavailable.'
        : (error?.publicMessage || (status === 401 ? 'Sign in to upload media.' : status === 403 ? 'This account cannot upload media.' : 'Upload failed.'));
      return send(res, infrastructureFailure ? 503 : status, { ok: false, code, error: message, correlationId });
    }
  };
}

export default createUploadHandler();
