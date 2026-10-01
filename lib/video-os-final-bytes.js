import { createHash } from 'node:crypto';
import { getPrivateBlob } from './video-os-private-blob.js';

export const MAX_FINAL_BYTES = 100 * 1024 * 1024;

// Buffer before returning anything: a replaced/corrupt object must never leak
// partial bytes to a download response or be treated as validated media.
export async function readVerifiedFinalBytes(artifact) {
  'use step';
  if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_FINAL_BYTES
    || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) {
    throw Object.assign(new Error('Final artifact identity is invalid.'), { statusCode: 409, failureCategory: 'FINAL_STORE' });
  }
  const controller = new AbortController();
  let stream;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); stream?.destroy?.();
      reject(Object.assign(new Error('Final artifact read timed out.'), { statusCode: 504, failureCategory: 'FINAL_STORE' }));
    }, 60_000);
  });
  try {
    const result = await Promise.race([getPrivateBlob(artifact.privatePathname, { abortSignal: controller.signal }), deadline]);
    stream = result?.stream;
    if (!result?.stream) throw Object.assign(new Error('Final video is unavailable.'), { statusCode: 410, failureCategory: 'FINAL_STORE' });
    const chunks = [];
    let bytes = 0;
    const hash = createHash('sha256');
    const iterator = result.stream[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next.done) break;
      const chunk = next.value;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > artifact.bytes || bytes > MAX_FINAL_BYTES) throw Object.assign(new Error('Final artifact integrity check failed.'), { statusCode: 409, failureCategory: 'FINAL_STORE' });
      hash.update(buffer); chunks.push(buffer);
    }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) {
      throw Object.assign(new Error('Final artifact integrity check failed.'), { statusCode: 409, failureCategory: 'FINAL_STORE' });
    }
    return { bytes: Buffer.concat(chunks, bytes), etag: result.blob?.etag };
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream?.destroy?.();
  }
}
