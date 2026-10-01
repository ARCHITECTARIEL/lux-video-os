import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { mock } from 'node:test';

const scenario = process.argv[2];
const source = Buffer.from('bounded enrollment source bytes');
const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
const audio = Buffer.from('RIFF-derived-audio');
const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex');
const enrollmentId = '11111111-1111-4111-8111-111111111111';
const operationKey = '22222222-2222-4222-8222-222222222222';
const sourcePath = `video-os/enrollment-sources/account/${enrollmentId}/phone.mp4`;
let completedHash;
let finalized;
let failed;
let storedDerived;
let cleanupResult;
let deleted = 0;
let expiryCalls = 0;
let sleeps = 0;

const enrollment = {
  id: enrollmentId, accountId: 'workflow-owner', status: scenario === 'hash' ? 'SOURCE_HASHING' : 'EXTRACTING',
  workflowOperationKey: operationKey, uploadPathname: sourcePath, uploadEtag: 'source-etag', declaredBytes: source.length,
  declaredContentType: 'video/mp4', sourceSha256, sourceBytes: source.length, consentedSourceSha256: sourceSha256,
};
const repository = await import('../../db/enrollment-repository.js');
mock.module('../../db/enrollment-repository.js', { namedExports: {
  ...repository,
  claimEnrollmentHash: async () => enrollment,
  completeEnrollmentHash: async input => { completedHash = input; return { ...enrollment, status: 'AWAITING_EXTRACTION_CONSENT' }; },
  claimEnrollmentExtraction: async () => enrollment,
  finalizeEnrollmentIdentity: async input => { finalized = input; return { enrollment: { ...enrollment, status: 'IDENTITY_READY' }, identity: { id: 'identity' } }; },
  failEnrollmentOperation: async input => { failed = input; return { ...enrollment, status: 'FAILED' }; },
  claimEnrollmentCleanup: async () => ({ ...enrollment, status: 'REVOKED', cleanupStatus: 'PENDING', cleanupAttempts: 1 }),
  recordEnrollmentCleanup: async input => { cleanupResult = input; return input; },
  expireEnrollmentInternal: async () => {
    expiryCalls++;
    if (scenario === 'expiry-terminal-failed') return { ...enrollment, status: 'FAILED', failureCode: 'DERIVATION_MISMATCH', cleanupStatus: 'DELETED', attemptCount: 1 };
    if (scenario === 'expiry-retryable-failed' && expiryCalls === 1) return { ...enrollment, status: 'FAILED', failureCode: 'PERSISTENCE', cleanupStatus: 'NOT_REQUIRED', attemptCount: 1 };
    return { ...enrollment, status: 'EXPIRED', cleanupStatus: 'PENDING' };
  },
} });
const privateBlob = await import('../../lib/video-os-private-blob.js');
mock.module('../../lib/video-os-private-blob.js', { namedExports: {
  ...privateBlob,
  getPrivateBlob: async pathname => pathname === sourcePath
    ? { stream: Readable.from([source]), blob: { pathname, etag: 'source-etag' } }
    : { stream: Readable.from([audio]), blob: { pathname, etag: 'audio-etag' } },
  putPrivateBlob: async (_classification, pathname, body) => {
    assert.deepEqual(body, audio); storedDerived = pathname;
    return { pathname, etag: 'audio-etag', created: true };
  },
  deletePrivateBlob: async () => { if (scenario === 'cleanup-failure') throw new Error('transient delete failure'); deleted++; return { deleted: true }; },
} });
const media = await import('../../services/enrollment-media.js');
mock.module('../../services/enrollment-media.js', { namedExports: {
  ...media,
  prepareEnrollmentMedia: async input => {
    assert.equal(input.expectedSha256, sourceSha256);
    assert.equal(input.consent.sourceSha256, sourceSha256);
    return {
      audioBuffer: audio, audioSha256, audioBytes: audio.length, audioMimeType: 'audio/wav', durationMs: 5_000,
      source: { sha256: sourceSha256, bytes: source.length, durationMs: 5_000, width: 720, height: 1280, mimeType: 'video/mp4', fullDecode: true },
      derivationVersion: 'test-derivation-v1',
    };
  },
} });
mock.module('workflow', { namedExports: {
  FatalError: class FatalError extends Error {},
  sleep: async () => { sleeps++; },
} });

process.env.VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED = 'true';
process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED = 'true';
process.env.VIDEO_OS_ENROLLMENT_BLOB_STORE_ID = 'store123';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video.example';
process.env.STORAGE_DRIVER = 'blob';
process.env.WORKFLOW_DISPATCH_MODE = 'vercel';

const workflow = await import('../../workflows/identity-enrollment.js');
if (scenario === 'hash') {
  const result = await workflow.hashEnrollmentSource(enrollmentId, operationKey);
  assert.equal(result.status, 'AWAITING_EXTRACTION_CONSENT');
  assert.equal(completedHash.sha256, sourceSha256);
  assert.equal(failed, undefined);
} else if (scenario === 'extract') {
  const result = await workflow.extractEnrollmentIdentity(enrollmentId, operationKey);
  assert.equal(result.enrollment.status, 'IDENTITY_READY');
  assert.match(storedDerived, new RegExp(`${audioSha256}\\.wav$`));
  assert.equal(finalized.result.audioSha256, audioSha256);
  assert.equal(failed, undefined);
} else if (scenario === 'failure') {
  // Force failure with a source byte mismatch before media processing.
  enrollment.declaredBytes += 1;
  await assert.rejects(workflow.hashEnrollmentSource(enrollmentId, operationKey), /ENROLLMENT_HASH_FAILED_V1/);
  assert.equal(failed.code, 'SOURCE_IDENTITY_MISMATCH');
} else if (scenario === 'cleanup') {
  const result = await workflow.cleanupEnrollmentStorage(enrollmentId);
  assert.equal(result.cleaned, true);
  assert.equal(deleted, 1);
  assert.equal(cleanupResult.deleted, true);
} else if (scenario === 'cleanup-failure') {
  await assert.rejects(workflow.cleanupEnrollmentStorage(enrollmentId), /ENROLLMENT_CLEANUP_RETRY_V1/);
  assert.equal(cleanupResult.deleted, false);
} else if (scenario === 'expiry') {
  const result = await workflow.expireEnrollmentStep(enrollmentId);
  assert.equal(result.status, 'EXPIRED');
} else if (scenario === 'expiry-terminal-failed') {
  const result = await workflow.identityEnrollmentExpiryWorkflow(enrollmentId);
  assert.equal(result.cleaned, true);
  assert.equal(sleeps, 1, 'terminal failure is rechecked as soon as the upload token has expired');
  assert.equal(deleted, 1);
} else if (scenario === 'expiry-retryable-failed') {
  const result = await workflow.identityEnrollmentExpiryWorkflow(enrollmentId);
  assert.equal(result.cleaned, true);
  assert.equal(sleeps, 2, 'retryable failure retains its source until the overall enrollment TTL');
  assert.equal(expiryCalls, 2);
  assert.equal(deleted, 1);
} else throw new Error(`unknown scenario ${scenario}`);
