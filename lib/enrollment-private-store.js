import crypto from 'node:crypto';
import { assertEnrollmentCapability } from './enrollment-policy.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from './video-os-private-blob.js';

const successCache = new Map();
const pending = new Map();
const CACHE_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;

function failure(message) {
  return Object.assign(new Error(message), { statusCode: 503, failureCategory: 'CONFIG_MISSING', code: 'PRIVATE_STORE_UNVERIFIED' });
}

function cacheKey(env, storeId) {
  return crypto.createHash('sha256').update([
    String(env.BLOB_READ_WRITE_TOKEN || ''), String(storeId), String(env.VERCEL_PROJECT_ID || ''), String(env.VERCEL_ENV || ''),
  ].join('\0')).digest('hex');
}

async function cancelStream(stream) {
  if (typeof stream?.destroy === 'function') stream.destroy();
  else if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
}

async function readExact(result, expected) {
  if (!result?.stream) throw failure('Enrollment private-store readback is unavailable.');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of result.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > expected.bytes) throw failure('Enrollment private-store readback exceeded its byte contract.');
      hash.update(chunk);
    }
  } catch (error) {
    await cancelStream(result.stream);
    throw error;
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw failure('Enrollment private-store readback did not match its source.');
}

export async function assertEnrollmentPrivateStoreReady({
  env = process.env,
  put = putPrivateBlob,
  get = getPrivateBlob,
  del = deletePrivateBlob,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const capability = assertEnrollmentCapability(env);
  const key = cacheKey(env, capability.storeId);
  if ((successCache.get(key) || 0) > now) return capability;
  if (pending.has(key)) return pending.get(key);
  const proof = (async () => {
    const bytes = crypto.randomBytes(32);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const pathname = `video-os/enrollment-probes/${crypto.randomUUID()}/private-proof.bin`;
    let blob;
    let cleanupError;
    try {
      blob = await put(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_PROBE, pathname, bytes, {
        contentType: 'application/octet-stream', addRandomSuffix: false, allowOverwrite: false,
      });
      if (blob?.pathname !== pathname || !blob?.etag || !blob?.url) throw failure('Enrollment private-store write identity is incomplete.');
      const url = new URL(blob.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname.toLowerCase() !== `${capability.storeId.toLowerCase()}.private.blob.vercel-storage.com`) {
        throw failure('Enrollment private-store hostname is not private or does not match the pinned store.');
      }
      const readback = await get(pathname);
      let readbackUrl;
      try { readbackUrl = new URL(readback?.blob?.url).href; } catch {}
      if (readback?.blob?.pathname !== pathname || readback?.blob?.etag !== blob.etag || readbackUrl !== url.href) {
        await cancelStream(readback?.stream);
        throw failure('Enrollment private-store authenticated readback identity changed.');
      }
      await readExact(readback, { bytes: bytes.length, sha256 });
      const anonymous = await fetchImpl(blob.url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      try {
        if (![401, 403, 404].includes(anonymous.status)) throw failure('Enrollment private-store anonymous access was not denied.');
      } finally {
        await cancelStream(anonymous?.body);
      }
    } finally {
      if (blob?.etag) {
        try { await del(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_PROBE, pathname, { ifMatch: blob.etag }); } catch (error) { cleanupError = error; }
      }
    }
    if (cleanupError) throw failure('Enrollment private-store proof cleanup failed.');
    successCache.set(key, now + CACHE_MS);
    return capability;
  })().finally(() => pending.delete(key));
  pending.set(key, proof);
  return proof;
}

export function clearEnrollmentPrivateStoreProofForTests() {
  successCache.clear(); pending.clear();
}
