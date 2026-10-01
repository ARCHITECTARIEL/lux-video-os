import crypto from 'node:crypto';

// STORAGE_DRIVER selects where private objects actually live:
//  - 'blob' (default): @vercel/blob -- the Vercel-hosted path.
//  - 'fs': local filesystem under STORAGE_FS_ROOT -- the VPS-hosted path.
// Every caller in this codebase goes through putPrivateBlob/getPrivateBlob/
// deletePrivateBlob below rather than importing a driver directly, so this
// is the only place that needs to know which driver is active.
function selectedDriver() {
  return String(process.env.STORAGE_DRIVER || 'blob').trim().toLowerCase();
}

async function driver() {
  return selectedDriver() === 'fs'
    ? import('./storage-drivers/fs-blob-driver.js')
    : import('./storage-drivers/vercel-blob-driver.js');
}

export const PRIVATE_BLOB_CLASSIFICATIONS = Object.freeze({
  ACCOUNT_STATE: 'account-state',
  AUTHENTICATION_STATE: 'authentication-state',
  RATE_LIMIT_STATE: 'rate-limit-state',
  CUSTOMER_UPLOAD: 'customer-upload',
  IDENTITY_ENROLLMENT_SOURCE: 'identity-enrollment-source',
  IDENTITY_ENROLLMENT_PROBE: 'identity-enrollment-probe',
  FINISHED_CUSTOMER_VIDEO: 'finished-customer-video',
  JOB_STATE: 'job-state',
  CREDIT_STATE: 'credit-state',
  STRIPE_EVENT: 'stripe-event',
  RECOVERY_RECEIPT: 'recovery-receipt',
});

export const MAX_FINISHED_CUSTOMER_VIDEO_BYTES = 100 * 1024 * 1024;

const PREFIX_BY_CLASSIFICATION = Object.freeze({
  [PRIVATE_BLOB_CLASSIFICATIONS.ACCOUNT_STATE]: 'video-os/accounts/',
  [PRIVATE_BLOB_CLASSIFICATIONS.AUTHENTICATION_STATE]: 'video-os/auth/',
  [PRIVATE_BLOB_CLASSIFICATIONS.RATE_LIMIT_STATE]: 'video-os/rate/',
  [PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD]: 'video-os/uploads/',
  [PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE]: 'video-os/enrollment-sources/',
  [PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_PROBE]: 'video-os/enrollment-probes/',
  [PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO]: 'video-os/finals/',
  [PRIVATE_BLOB_CLASSIFICATIONS.JOB_STATE]: 'video-os/jobs/',
  [PRIVATE_BLOB_CLASSIFICATIONS.CREDIT_STATE]: 'video-os/credit-state/',
  [PRIVATE_BLOB_CLASSIFICATIONS.STRIPE_EVENT]: 'video-os/stripe-events/',
  [PRIVATE_BLOB_CLASSIFICATIONS.RECOVERY_RECEIPT]: 'video-os/recovery-receipts/',
});

function policyError(message) {
  return Object.assign(new Error(message), {
    statusCode: 503,
    failureCategory: 'PERSISTENCE',
  });
}

function finalStorageError(message, { code, statusCode }) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    failureCategory: 'PERSISTENCE',
  });
}

function finalTooLargeError() {
  return finalStorageError('Finished video exceeds the storage size limit.', {
    code: 'FINISHED_VIDEO_TOO_LARGE',
    statusCode: 413,
  });
}

function finalHashMismatchError() {
  return finalStorageError('Finished video bytes do not match the canonical pathname.', {
    code: 'FINISHED_VIDEO_HASH_MISMATCH',
    statusCode: 422,
  });
}

function finalConflictError() {
  return finalStorageError('Stored finished video does not match the submitted bytes.', {
    code: 'FINISHED_VIDEO_IMMUTABILITY_CONFLICT',
    statusCode: 409,
  });
}

function checkedChunk(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw finalStorageError('Finished video body type is not supported.', {
    code: 'FINISHED_VIDEO_BODY_UNSUPPORTED',
    statusCode: 500,
  });
}

async function boundedFinalBuffer(body) {
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw finalTooLargeError();
    return body;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw finalTooLargeError();
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw finalTooLargeError();
    return Buffer.from(body);
  }
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw finalStorageError('Finished video body type is not supported.', {
      code: 'FINISHED_VIDEO_BODY_UNSUPPORTED',
      statusCode: 500,
    });
  }

  const chunks = [];
  let bytes = 0;
  try {
    for await (const value of body) {
      const chunk = checkedChunk(value);
      bytes += chunk.length;
      if (bytes > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw finalTooLargeError();
      chunks.push(chunk);
    }
  } catch (error) {
    if (typeof body.destroy === 'function') body.destroy();
    throw error;
  }
  return Buffer.concat(chunks, bytes);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pathnameSha256(pathname) {
  return String(pathname || '').match(/-([a-f0-9]{64})\.mp4$/)?.[1] || null;
}

function isNoOverwriteConflict(error) {
  return error?.statusCode === 409
    || error?.statusCode === 412
    || error?.code === 'EEXIST'
    || error?.name === 'BlobPreconditionFailedError';
}

async function actualStoredBytesMatch(get, pathname, expected, options = {}) {
  let stored;
  try {
    stored = await get(pathname, options);
  } catch {
    return { matches: false, stored: null };
  }
  if (!stored?.stream || typeof stored.stream[Symbol.asyncIterator] !== 'function') {
    return { matches: false, stored };
  }

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of stored.stream) {
      const chunk = checkedChunk(value);
      bytes += chunk.length;
      if (bytes > expected.bytes || bytes > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) {
        if (typeof stored.stream.destroy === 'function') stored.stream.destroy();
        return { matches: false, stored };
      }
      hash.update(chunk);
    }
  } catch {
    return { matches: false, stored };
  }

  return {
    matches: bytes === expected.bytes && hash.digest('hex') === expected.sha256,
    stored,
  };
}

async function putImmutableFinishedVideo(pathname, body, options, storageDriver) {
  const buffer = await boundedFinalBuffer(body);
  const digest = sha256(buffer);
  if (pathnameSha256(pathname) !== digest) throw finalHashMismatchError();

  // Final pathnames are content-addressed. Caller-supplied overwrite and
  // conditional-overwrite settings can never weaken that invariant.
  const { allowOverwrite: _allowOverwrite, ifMatch: _ifMatch, ...safeOptions } = options;
  let writeError;
  try {
    const blob = await storageDriver.put(pathname, buffer, {
      ...safeOptions,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { ...blob, created: true };
  } catch (error) {
    // SDK conflicts and a lost write acknowledgement can have different error
    // shapes. Only an actual byte-identical readback can establish reuse.
    writeError = error;
  }

  const existing = await actualStoredBytesMatch(storageDriver.get, pathname, {
    bytes: buffer.length,
    sha256: digest,
  }, { token: safeOptions.token });
  if (!existing.matches) {
    if (existing.stored || isNoOverwriteConflict(writeError)) throw finalConflictError();
    throw finalStorageError('Finished video storage could not be verified.', { code: 'FINISHED_VIDEO_STORE_UNVERIFIED', statusCode: 503 });
  }

  return {
    ...(existing.stored?.blob || {}),
    pathname,
    etag: existing.stored?.blob?.etag || digest,
    contentType: safeOptions.contentType || null,
    size: buffer.length,
    created: false,
  };
}

export function privateBlobClassificationForPath(pathname) {
  const path = String(pathname || '');
  return Object.entries(PREFIX_BY_CLASSIFICATION)
    .find(([, prefix]) => path.startsWith(prefix))?.[0] || null;
}

export function assertPrivateBlobWrite({ classification, pathname, access = 'private' }) {
  const prefix = PREFIX_BY_CLASSIFICATION[classification];
  const path = String(pathname || '');
  if (!prefix) throw policyError('Blob write classification is not allowed.');
  if (access !== 'private') throw policyError('Public Blob writes are prohibited.');
  if (!path.startsWith(prefix) || path.length <= prefix.length || path.includes('..') || path.includes('\\')) {
    throw policyError('Blob pathname does not match its private classification.');
  }
  return { access: 'private', classification, pathname: path };
}

function assertConfigured() {
  if (selectedDriver() === 'fs') return; // local disk needs no credential, just STORAGE_FS_ROOT (defaulted)
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw policyError('Private Blob storage is not configured.');
}

export async function putPrivateBlob(classification, pathname, body, options = {}) {
  const { access = 'private', ...driverOptions } = options;
  assertPrivateBlobWrite({ classification, pathname, access });
  assertConfigured();
  const storageDriver = await driver();
  if (classification === PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO) {
    return putImmutableFinishedVideo(pathname, body, driverOptions, storageDriver);
  }
  return storageDriver.put(pathname, body, driverOptions);
}

export async function getPrivateBlob(pathname, options = {}) {
  assertConfigured();
  const { get } = await driver();
  return get(pathname, options);
}

export async function deletePrivateBlob(classification, pathname, options = {}) {
  const { ifMatch } = options;
  const policy = assertPrivateBlobWrite({ classification, pathname, access: 'private' });
  assertConfigured();
  if (!ifMatch) throw policyError('A Blob version is required for compensating deletion.');
  const { del } = await driver();
  await del(policy.pathname, { ifMatch });
  return { deleted: true };
}
