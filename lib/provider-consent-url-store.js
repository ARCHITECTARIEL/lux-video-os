import crypto from 'node:crypto';
import {
  PRIVATE_BLOB_CLASSIFICATIONS,
  putPrivateBlob,
  getPrivateBlob,
  deletePrivateBlob,
} from './video-os-private-blob.js';

const CLASSIFICATION = PRIVATE_BLOB_CLASSIFICATIONS.AUTHENTICATION_STATE;
const PREFIX = 'video-os/auth/provider-consent/';

function unavailable() {
  return Object.assign(new Error('Hosted consent link is unavailable.'), {
    statusCode: 404,
    failureCategory: 'CONSENT',
  });
}

function checkedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw unavailable();
    if (url.hostname !== 'heygen.com' && !url.hostname.endsWith('.heygen.com')) throw unavailable();
    return url.href;
  } catch {
    throw unavailable();
  }
}

function checkedExpiry(value, now) {
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw unavailable();
  return new Date(expiresAt).toISOString();
}

export async function saveProviderConsentUrl({ operationId, url, expiresAt }, { put = putPrivateBlob, now = Date.now() } = {}) {
  if (!operationId || typeof operationId !== 'string') throw unavailable();
  const providerUrl = checkedUrl(url);
  const expiry = checkedExpiry(expiresAt, now);
  const urlDigest = crypto.createHash('sha256').update(providerUrl).digest('hex');
  const pathname = `${PREFIX}${crypto.createHash('sha256').update(`${operationId}\0${providerUrl}`).digest('hex')}.json`;
  await put(CLASSIFICATION, pathname, JSON.stringify({ version: 1, operationId, url: providerUrl, expiresAt: expiry }), {
    contentType: 'application/json',
    allowOverwrite: false,
  });
  return { pathname, urlDigest, expiresAt: expiry };
}

export async function consumeProviderConsentUrl({ path, operationId }, { get = getPrivateBlob, del = deletePrivateBlob, now = Date.now() } = {}) {
  if (!new RegExp(`^${PREFIX}[a-f0-9]{64}\\.json$`).test(path || '') || !operationId) throw unavailable();
  try {
    const stored = await get(path);
    if (!stored?.stream || !stored?.blob?.etag) throw unavailable();
    const record = await new Response(stored.stream).json();
    if (record?.version !== 1 || record.operationId !== operationId) throw unavailable();
    checkedExpiry(record.expiresAt, now);
    const url = checkedUrl(record.url);
    await del(CLASSIFICATION, path, { ifMatch: stored.blob.etag });
    return url;
  } catch {
    throw unavailable();
  }
}
