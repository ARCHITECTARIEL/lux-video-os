import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { isCreativeBasePathname } from '../lib/creative-finish-contract.js';
import {
  MAX_FINISHED_CUSTOMER_VIDEO_BYTES,
  PRIVATE_BLOB_CLASSIFICATIONS,
  deletePrivateBlob,
  getPrivateBlob,
  putPrivateBlob,
} from '../lib/video-os-private-blob.js';
import { inspectMedia } from './final-media-validation.js';

const SHA256 = /^[a-f0-9]{64}$/;
export const CREATIVE_BASE_RETENTION_DAYS = 30;
export const CREATIVE_BASE_STAGED_MAX_HOURS = 24;

function failure(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode, failureCategory: 'PERSISTENCE' });
}

export function creativeBaseRetentionExpiresAt(acceptedAt) {
  const date = new Date(acceptedAt);
  if (!acceptedAt || !Number.isFinite(date.getTime())) {
    throw failure('CREATIVE_BASE_ACCEPTANCE_REQUIRED', 'A valid final acceptance time is required.');
  }
  return new Date(date.getTime() + CREATIVE_BASE_RETENTION_DAYS * 86_400_000).toISOString();
}

async function digestReadback(pathname, get) {
  const result = await get(pathname);
  if (!result?.blob?.etag || !result?.stream || typeof result.stream[Symbol.asyncIterator] !== 'function') {
    return null;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of result.stream) {
    bytes += chunk.length;
    if (bytes > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) {
      result.stream.destroy?.();
      throw failure('CREATIVE_BASE_READBACK_INVALID', 'Creative base readback exceeds the size limit.');
    }
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes, etag: result.blob.etag };
}

/** Re-read an already staged private object before a locked promotion. */
export async function verifyCreativeBaseForPromotion(base, { getPrivateBlob: get = getPrivateBlob } = {}) {
  if (!base || !isCreativeBasePathname(base.privatePathname)
    || !SHA256.test(base.sha256) || !Number.isSafeInteger(base.bytes) || base.bytes < 1
    || base.bytes > MAX_FINISHED_CUSTOMER_VIDEO_BYTES
    || typeof base.blobVersion !== 'string' || !base.blobVersion) {
    throw failure('CREATIVE_BASE_PROMOTION_INVALID', 'Staged creative base evidence is invalid.');
  }
  const observed = await digestReadback(base.privatePathname, get);
  if (!observed || observed.sha256 !== base.sha256 || observed.bytes !== base.bytes
    || observed.etag !== base.blobVersion) {
    throw failure('CREATIVE_BASE_PROMOTION_READBACK_MISMATCH', 'Staged creative base bytes or version changed.', 409);
  }
  return Object.freeze({
    pathname: base.privatePathname, sha256: observed.sha256,
    bytes: observed.bytes, blobVersion: observed.etag,
  });
}

/**
 * Capture one locally validated provider source at an opaque, immutable private
 * path. The accepted customer final may have different bytes. The caller must
 * bind the capture to the source job and its consent before final acceptance,
 * then promote only after the job's distinct final artifact is accepted.
 * No route, catalogue mutation, or feature activation calls this service yet.
 */
export async function captureCreativeBase({ baseId, sourcePath, expectedSha256, expectedBytes }, storage = {}) {
  const pathname = `video-os/creative-base/${baseId}.mp4`;
  if (typeof baseId !== 'string' || !isCreativeBasePathname(pathname) || baseId !== baseId.toLowerCase()
    || !SHA256.test(expectedSha256)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1
    || expectedBytes > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) {
    throw failure('CREATIVE_BASE_INPUT_INVALID', 'Creative base capture evidence is invalid.');
  }
  const inspect = storage.inspectMedia || inspectMedia;
  const put = storage.putPrivateBlob || putPrivateBlob;
  const get = storage.getPrivateBlob || getPrivateBlob;
  const del = storage.deletePrivateBlob || deletePrivateBlob;
  const inspected = await inspect(sourcePath);
  if (!inspected.fullDecode || inspected.sha256 !== expectedSha256 || inspected.bytes !== expectedBytes) {
    throw failure('CREATIVE_BASE_SOURCE_MISMATCH', 'Creative base source does not match accepted final media.');
  }

  const sourceHash = createHash('sha256');
  let streamedBytes = 0;
  let streamComplete = false;
  async function* source() {
    for await (const chunk of createReadStream(sourcePath)) {
      streamedBytes += chunk.length;
      if (streamedBytes > expectedBytes) throw failure('CREATIVE_BASE_SOURCE_CHANGED', 'Creative base source changed during capture.');
      sourceHash.update(chunk);
      yield chunk;
    }
    streamComplete = true;
  }

  let blob;
  let writeError;
  try {
    blob = await put(PRIVATE_BLOB_CLASSIFICATIONS.CREATIVE_BASE, pathname, source(), {
      contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: false,
    });
  } catch (error) {
    writeError = error;
  }
  const sourceMatches = streamComplete && streamedBytes === expectedBytes
    && sourceHash.digest('hex') === expectedSha256;
  let readback;
  try {
    readback = await digestReadback(pathname, get);
  } catch (error) {
    if (!writeError) throw error;
  }
  const readbackMatches = readback?.bytes === expectedBytes && readback?.sha256 === expectedSha256;
  if (sourceMatches && readbackMatches) {
    // An acknowledgement may have been lost after publication. Exact-byte
    // readback is the only basis for idempotent reuse.
    return {
      pathname, sha256: expectedSha256, bytes: expectedBytes, etag: readback.etag,
      created: Boolean(blob), media: inspected,
    };
  }
  if (blob?.etag && readback?.etag === blob.etag && !readbackMatches) {
    // Only compensate the exact object version this call created. A conflict
    // with a pre-existing object must never delete that object's bytes.
    await del(PRIVATE_BLOB_CLASSIFICATIONS.CREATIVE_BASE, pathname, { ifMatch: blob.etag });
  }
  if (readback && !readbackMatches) {
    throw failure('CREATIVE_BASE_IMMUTABILITY_CONFLICT', 'Private creative base bytes conflict with accepted final media.', 409);
  }
  if (!sourceMatches) throw failure('CREATIVE_BASE_SOURCE_CHANGED', 'Creative base source changed during capture.');
  throw failure('CREATIVE_BASE_STORE_UNVERIFIED', 'Private creative base storage could not be verified.', 503);
}
