import { put } from '@vercel/blob';
import { sessionFromRequest } from '../../lib/video-os-account.js';

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
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not configured on Vercel.');
    const pathname = `video-os/uploads/${safeName(payload.name)}-${Date.now()}${ext}`;
    const blob = await put(pathname, buffer, {
      access: 'private',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: true,
    });
    return send(res, 201, {
      ok: true,
      url: null,
      providerUrl: null,
      downloadUrl: null,
      filename: pathname.split('/').pop(),
      pathname: blob.pathname || pathname,
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
