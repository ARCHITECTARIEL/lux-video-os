import crypto from 'node:crypto';
import { assertDatabaseConfigured } from '../../db/client.js';
import { addMediaAsset } from '../../db/repositories.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';
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

function logUploadPersistenceError({ correlationId, failureCategory, cleanup }) {
  console.error(JSON.stringify({
    event: 'video_os_upload_persistence_failure',
    correlationId,
    failureCategory,
    cleanup: {
      attempted: cleanup.attempted,
      succeeded: cleanup.succeeded,
    },
  }));
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
    addMediaAsset,
    assertDatabaseConfigured,
    blobToken: () => process.env.BLOB_READ_WRITE_TOKEN,
    deletePrivateBlob,
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
      if (!dataUrl.startsWith('data:') || !dataUrl.includes(',')) throw routeError('Choose an image or video file to upload first.', 400, 'VALIDATION', 'invalid_upload');
      const [header, encoded] = dataUrl.split(',', 2);
      const mime = header.slice(5).split(';', 1)[0].toLowerCase();
      const ext = ALLOWED[mime];
      if (!ext) throw routeError('Unsupported upload format. Use JPG, PNG, WebP, MP4, or MOV.', 400, 'VALIDATION', 'invalid_upload');
      const buffer = Buffer.from(encoded, 'base64');
      if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw routeError('Uploads must be under 20 MB.', 400, 'VALIDATION', 'invalid_upload');
      const detectedMime = detectedUploadMime(buffer);
      if (!detectedMime || (mime === 'video/quicktime' ? detectedMime !== 'video/mp4' : detectedMime !== mime)) {
        throw routeError('Upload contents do not match the declared file type.', 400, 'VALIDATION', 'invalid_upload');
      }

      try {
        dependencies.assertDatabaseConfigured();
      } catch {
        throw routeError('Upload service is temporarily unavailable.', 503, 'CONFIG_MISSING', 'database_unavailable');
      }
      const blobToken = dependencies.blobToken();
      if (!blobToken) throw routeError('Upload storage is unavailable.', 503, 'CONFIG_MISSING', 'upload_storage_unavailable');

      const pathname = `video-os/uploads/${accountHash(session.accountId)}/${safeName(payload.name)}-${crypto.randomUUID()}${ext}`;
      const blob = await dependencies.putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, {
        contentType: mime,
        token: blobToken,
        addRandomSuffix: true,
      });
      const privatePathname = String(blob?.pathname || '');
      if (!privatePathname || !blob?.etag) {
        throw routeError('Upload storage did not return an object identity.', 503, 'PERSISTENCE', 'upload_storage_unavailable');
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      let asset;
      try {
        asset = await dependencies.addMediaAsset({ accountId: session.accountId, kind: payload.kind === 'digital_twin' ? 'avatar-video-source' : 'avatar-photo-source', privatePathname, contentType: mime, bytes: buffer.length, sha256 });
      } catch (error) {
        const failureCategory = error?.failureCategory || 'PERSISTENCE';
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
          dependencies.logUploadPersistenceError({ correlationId, failureCategory, cleanup });
        } catch {}
        throw routeError('Upload service is temporarily unavailable.', 503, failureCategory, 'database_unavailable');
      }

      return send(res, 201, {
        ok: true,
        url: null,
        providerUrl: null,
        downloadUrl: null,
        filename: pathname.split('/').pop(),
        pathname: privatePathname,
        assetId: asset.id,
        previewUrl: `/api/video-os-lite/asset?assetId=${encodeURIComponent(asset.id)}`,
        mime,
        accountId: session.accountId,
        kind: payload.kind || 'avatar',
        size: buffer.length,
        requiresPublicUrl: true,
        correlationId,
        message: 'Upload stored privately. Provider submission remains disabled until short-lived private delivery is verified.',
      });
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
