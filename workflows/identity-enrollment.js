import { FatalError, sleep } from 'workflow';
import crypto from 'node:crypto';
import { access, open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimEnrollmentExtraction,
  claimEnrollmentHash,
  claimEnrollmentCleanup,
  completeEnrollmentHash,
  failEnrollmentOperation,
  finalizeEnrollmentIdentity,
  expireEnrollmentInternal,
  recordEnrollmentCleanup,
} from '../db/enrollment-repository.js';
import { getOwnedMediaAsset } from '../db/repositories.js';
import { accountHash } from '../lib/video-os-security.js';
import { assertEnrollmentCapability, assertEnrollmentExtractionCapability, ENROLLMENT_MEDIA_CONSENT_PURPOSE, ENROLLMENT_MEDIA_LIMITS, enrollmentNeedsTerminalCleanup } from '../lib/enrollment-policy.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { prepareEnrollmentMedia } from '../services/enrollment-media.js';

function safeFailure(error) {
  const code = String(error?.code || error?.failureCategory || 'ENROLLMENT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 80);
  const message = String(error?.message || 'Enrollment processing failed.').replace(/[^A-Za-z0-9 _.,:;!?()'"+\-_/]/g, '').slice(0, 240);
  return { code: code || 'ENROLLMENT_FAILED', message: message || 'Enrollment processing failed.' };
}

async function cancelStream(stream) {
  if (typeof stream?.destroy === 'function') stream.destroy();
  else if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
}

async function privateSourceToFile(enrollment, directory) {
  const stored = await getPrivateBlob(enrollment.uploadPathname);
  if (!stored?.stream || stored.blob?.pathname !== enrollment.uploadPathname || stored.blob?.etag !== enrollment.uploadEtag) {
    await cancelStream(stored?.stream);
    throw Object.assign(new Error('Enrollment source storage identity changed.'), { code: 'SOURCE_STORAGE_MISMATCH' });
  }
  const filePath = join(directory, 'phone-video.source');
  const handle = await open(filePath, 'wx');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const value of stored.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > ENROLLMENT_MEDIA_LIMITS.maxSourceBytes || bytes > enrollment.declaredBytes) throw Object.assign(new Error('Enrollment source exceeds its byte contract.'), { code: 'SOURCE_BYTE_LIMIT' });
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await cancelStream(stored.stream);
    throw error;
  } finally {
    await handle.close();
  }
  if (bytes !== enrollment.declaredBytes) throw Object.assign(new Error('Enrollment source size does not match its upload contract.'), { code: 'SOURCE_IDENTITY_MISMATCH' });
  return { filePath, bytes, sha256: hash.digest('hex') };
}

async function verifiedPrivateBuffer(pathname, expected) {
  const stored = await getPrivateBlob(pathname);
  if (!stored?.stream || stored.blob?.pathname !== pathname) {
    await cancelStream(stored?.stream);
    throw Object.assign(new Error('Derived enrollment audio is unavailable.'), { code: 'DERIVED_STORAGE_UNAVAILABLE' });
  }
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let bytes = 0;
  try {
    for await (const value of stored.stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > ENROLLMENT_MEDIA_LIMITS.maxAudioBytes || bytes > expected.bytes) throw Object.assign(new Error('Derived enrollment audio exceeds its byte contract.'), { code: 'DERIVED_STORAGE_MISMATCH' });
      hash.update(chunk); chunks.push(chunk);
    }
  } catch (error) {
    await cancelStream(stored.stream);
    throw error;
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw Object.assign(new Error('Derived enrollment audio failed byte verification.'), { code: 'DERIVED_STORAGE_MISMATCH' });
  return { bytes, etag: stored.blob?.etag || null };
}

async function stagedFfmpegPath() {
  const candidate = join(process.cwd(), 'ffmpeg');
  try { await access(candidate); return candidate; } catch { return undefined; }
}

export async function hashEnrollmentSource(enrollmentId, operationKey) {
  'use step';
  assertEnrollmentCapability();
  const enrollment = await claimEnrollmentHash(enrollmentId, operationKey);
  const directory = await mkdtemp(join(tmpdir(), 'lux-enrollment-hash-'));
  try {
    const source = await privateSourceToFile(enrollment, directory);
    return await completeEnrollmentHash({ enrollmentId, operationKey, sha256: source.sha256, bytes: source.bytes });
  } catch (error) {
    const safe = safeFailure(error);
    const failed = await failEnrollmentOperation({ enrollmentId, operationKey, ...safe }).catch(() => null);
    if (failed?.cleanupStatus === 'PENDING') await cleanupEnrollmentStorage(enrollmentId).catch(() => {});
    throw new FatalError(`ENROLLMENT_HASH_FAILED_V1:${safe.code}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractEnrollmentIdentity(enrollmentId, operationKey) {
  'use step';
  assertEnrollmentExtractionCapability();
  const enrollment = await claimEnrollmentExtraction(enrollmentId, operationKey);
  const directory = await mkdtemp(join(tmpdir(), 'lux-enrollment-extract-source-'));
  let derived;
  try {
    const source = await privateSourceToFile(enrollment, directory);
    if (source.sha256 !== enrollment.sourceSha256) throw Object.assign(new Error('Enrollment source changed after consent.'), { code: 'CONSENT_SOURCE_MISMATCH' });
    const ffmpegPath = await stagedFfmpegPath();
    const result = await prepareEnrollmentMedia({
      filePath: source.filePath,
      expectedSha256: enrollment.sourceSha256,
      consent: { granted: true, sourceSha256: enrollment.consentedSourceSha256, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE },
      ...(ffmpegPath ? { ffmpegPath } : {}),
    });
    const derivedPathname = `video-os/enrollment-sources/${accountHash(enrollment.accountId)}/${enrollment.id}/derived-${result.audioSha256}.wav`;
    try {
      derived = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, derivedPathname, result.audioBuffer, {
        contentType: 'audio/wav', addRandomSuffix: false, allowOverwrite: false,
      });
    } catch {
      derived = { pathname: derivedPathname, created: false };
    }
    const readback = await verifiedPrivateBuffer(derivedPathname, { bytes: result.audioBytes, sha256: result.audioSha256 });
    return await finalizeEnrollmentIdentity({
      enrollmentId, operationKey, result, derivedPathname, derivedEtag: derived?.etag || readback.etag,
    });
  } catch (error) {
    const safe = safeFailure(error);
    const failed = await failEnrollmentOperation({ enrollmentId, operationKey, ...safe }).catch(() => null);
    if (derived?.created !== false && derived?.pathname && derived?.etag) {
      await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, derived.pathname, { ifMatch: derived.etag }).catch(() => {});
    }
    if (failed?.cleanupStatus === 'PENDING') await cleanupEnrollmentStorage(enrollmentId).catch(() => {});
    throw new FatalError(`ENROLLMENT_EXTRACTION_FAILED_V1:${safe.code}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function identityEnrollmentHashWorkflow(enrollmentId, operationKey) {
  'use workflow';
  return hashEnrollmentSource(enrollmentId, operationKey);
}

export async function identityEnrollmentExtractionWorkflow(enrollmentId, operationKey) {
  'use workflow';
  return extractEnrollmentIdentity(enrollmentId, operationKey);
}

export async function cleanupEnrollmentStorage(enrollmentId, afterUploadExpiry = false) {
  'use step';
  const enrollment = await claimEnrollmentCleanup(enrollmentId, new Date(), { afterUploadExpiry });
  if (!enrollment) return { cleaned: false };
  const candidates = [{ pathname: enrollment.uploadPathname }];
  if (enrollment.derivedVoiceAssetId) {
    const derived = await getOwnedMediaAsset(enrollment.accountId, enrollment.derivedVoiceAssetId);
    if (derived?.privatePathname) candidates.push({ pathname: derived.privatePathname });
  }
  try {
    for (const candidate of candidates) {
      const pathname = String(candidate.pathname || '');
      if (!pathname.startsWith('video-os/enrollment-sources/')) throw new Error('Enrollment cleanup pathname escaped its namespace.');
      const stored = await getPrivateBlob(pathname);
      await cancelStream(stored?.stream);
      if (!stored?.blob?.etag) continue;
      if (stored.blob.pathname !== pathname) throw new Error('Enrollment cleanup storage identity changed.');
      await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, pathname, { ifMatch: stored.blob.etag });
    }
    await recordEnrollmentCleanup({ enrollmentId, deleted: true });
    return { cleaned: true };
  } catch (error) {
    await recordEnrollmentCleanup({ enrollmentId, deleted: false }).catch(() => {});
    throw new Error('ENROLLMENT_CLEANUP_RETRY_V1');
  }
}

export async function identityEnrollmentCleanupWorkflow(enrollmentId) {
  'use workflow';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await cleanupEnrollmentStorage(enrollmentId); } catch (error) {
      if (attempt === 2) throw new FatalError('ENROLLMENT_CLEANUP_FAILED_V1');
      await sleep('30s');
    }
  }
  return { cleaned: false };
}

export async function expireEnrollmentStep(enrollmentId) {
  'use step';
  const enrollment = await expireEnrollmentInternal(enrollmentId);
  // Keep the policy module's Node-only dependency graph in the step realm.
  return enrollment ? { ...enrollment, needsTerminalCleanup: enrollmentNeedsTerminalCleanup(enrollment) } : null;
}

export async function identityEnrollmentExpiryWorkflow(enrollmentId) {
  'use workflow';
  await sleep('15m');
  let enrollment = await expireEnrollmentStep(enrollmentId);
  if (enrollment?.needsTerminalCleanup) return cleanupEnrollmentStorage(enrollmentId, true);
  if (enrollment && !['IDENTITY_READY', 'REVOKED', 'EXPIRED'].includes(enrollment.status)) {
    await sleep('24h');
    enrollment = await expireEnrollmentStep(enrollmentId);
  }
  if (enrollment?.needsTerminalCleanup) return cleanupEnrollmentStorage(enrollmentId, true);
  return { cleaned: false };
}
