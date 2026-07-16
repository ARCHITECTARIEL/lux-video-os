import crypto from 'node:crypto';
import { addMediaAsset } from '../../db/repositories.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../../lib/video-os-private-blob.js';
import { accountHash } from '../../lib/video-os-security.js';

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

export function detectedUploadMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const session = sessionFromRequest(req);
    const dataUrl = String(payload.dataUrl || '');
    if (!dataUrl.startsWith('data:') || !dataUrl.includes(',')) throw new Error('Choose an image or video file to upload first.');
    const [header, encoded] = dataUrl.split(',', 2);
    const mime = header.slice(5).split(';', 1)[0].toLowerCase();
    const ext = ALLOWED[mime];
    if (!ext) throw new Error('Unsupported upload format. Use JPG, PNG, WebP, MP4, or MOV.');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw new Error('Uploads must be under 20 MB.');
    const detectedMime = detectedUploadMime(buffer);
    if (!detectedMime || (mime === 'video/quicktime' ? detectedMime !== 'video/mp4' : detectedMime !== mime)) throw new Error('Upload contents do not match the declared file type.');
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not configured on Vercel.');
    const pathname = `video-os/uploads/${accountHash(session.accountId)}/${safeName(payload.name)}-${crypto.randomUUID()}${ext}`;
    const blob = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, {
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: true,
    });
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const asset = await addMediaAsset({ accountId: session.accountId, kind: payload.kind === 'digital_twin' ? 'avatar-video-source' : 'avatar-photo-source', privatePathname: blob.pathname || pathname, contentType: mime, bytes: buffer.length, sha256 });
    return send(res, 201, {
      ok: true,
      url: null,
      providerUrl: null,
      downloadUrl: null,
      filename: pathname.split('/').pop(),
      pathname: blob.pathname || pathname,
      assetId: asset.id,
      previewUrl: `/api/video-os-lite/asset?assetId=${encodeURIComponent(asset.id)}`,
      mime,
      accountId: session.accountId,
      kind: payload.kind || 'avatar',
      size: buffer.length,
      requiresPublicUrl: true,
      message: 'Upload stored privately. Provider submission remains disabled until short-lived private delivery is verified.',
    });
  } catch (error) {
    return send(res, 400, { ok: false, error: error.message || 'Upload failed.' });
  }
}
