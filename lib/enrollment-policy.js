import crypto from 'node:crypto';
import { z } from 'zod';
import { ENROLLMENT_MEDIA_CONSENT_PURPOSE, ENROLLMENT_MEDIA_LIMITS } from '../services/enrollment-media.js';

export const ENROLLMENT_CONTRACT_VERSION = 'identity-phone-video-v1';
export const LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION = 'identity-video-audio-extraction-v1';
export const ENROLLMENT_CONSENT_POLICY_VERSION = 'identity-provider-bridge-v2';
export const ENROLLMENT_FEATURE_FLAG = 'VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED';
export const ENROLLMENT_EXTRACTION_FLAG = 'VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED';
export const ENROLLMENT_CANARY_ACCOUNT_FLAG = 'VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID';
export const ENROLLMENT_CANARY_STARTED_AT_FLAG = 'VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT';
export const ENROLLMENT_UPLOAD_VALIDITY_MS = 15 * 60 * 1000;
export const ENROLLMENT_MAX_ATTEMPTS = 3;
export const ENROLLMENT_RETRYABLE_FAILURE_CODES = Object.freeze([
  'PERSISTENCE', 'SOURCE_STORAGE_MISMATCH', 'DERIVED_STORAGE_UNAVAILABLE',
  'FFMPEG_UNAVAILABLE', 'FFMPEG_TIMEOUT', 'TEMPORARY_STORAGE_UNAVAILABLE',
]);
const retryableEnrollmentFailures = new Set(ENROLLMENT_RETRYABLE_FAILURE_CODES);
export const ENROLLMENT_ALLOWED_CONTENT_TYPES = Object.freeze(['video/mp4', 'video/quicktime', 'video/webm']);
export const ENROLLMENT_STATUSES = Object.freeze({
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  SOURCE_HASHING: 'SOURCE_HASHING',
  AWAITING_CONSENT: 'AWAITING_EXTRACTION_CONSENT',
  EXTRACTION_QUEUED: 'EXTRACTION_QUEUED',
  EXTRACTING: 'EXTRACTING',
  IDENTITY_READY: 'IDENTITY_READY',
  FAILED: 'FAILED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
});

export function enrollmentFailureIsRetryable(code) {
  return retryableEnrollmentFailures.has(String(code || ''));
}

export function enrollmentNeedsTerminalCleanup(enrollment) {
  if (!enrollment) return false;
  if ([ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED].includes(enrollment.status)) return true;
  return enrollment.status === ENROLLMENT_STATUSES.FAILED
    && (Number(enrollment.attemptCount) >= ENROLLMENT_MAX_ATTEMPTS || !enrollmentFailureIsRetryable(enrollment.failureCode));
}

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commonMutation = { contractVersion: z.literal(ENROLLMENT_CONTRACT_VERSION), enrollmentId: uuid, expectedStateVersion: z.number().int().nonnegative() };
const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'), contractVersion: z.literal(ENROLLMENT_CONTRACT_VERSION), idempotencyKey: uuid,
    displayName: z.string().trim().min(1).max(80), photoAssetId: uuid,
    filename: z.string().trim().min(1).max(120), contentType: z.enum(ENROLLMENT_ALLOWED_CONTENT_TYPES),
    bytes: z.number().int().positive().max(ENROLLMENT_MEDIA_LIMITS.maxSourceBytes),
  }).strict(),
  z.object({
    action: z.literal('consent'), ...commonMutation, idempotencyKey: uuid,
    policyVersion: z.literal(ENROLLMENT_CONSENT_POLICY_VERSION), purpose: z.literal(ENROLLMENT_MEDIA_CONSENT_PURPOSE),
    sourceVideoSha256: sha256, audioExtractionAuthorization: z.literal(true), faceAuthorization: z.literal(true),
    voiceAuthorization: z.literal(true), providerProcessingAuthorization: z.literal(true), archiveDeleteAcknowledgment: z.literal(true),
    temporaryPublicProviderExposureAuthorization: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('provider-reconsent'), ...commonMutation, identityId: uuid, idempotencyKey: uuid,
    policyVersion: z.literal(ENROLLMENT_CONSENT_POLICY_VERSION), purpose: z.literal(ENROLLMENT_MEDIA_CONSENT_PURPOSE),
    sourcePhotoSha256: sha256, sourceVideoSha256: sha256, derivedVoiceSha256: sha256,
    audioExtractionAuthorization: z.literal(true), faceAuthorization: z.literal(true), voiceAuthorization: z.literal(true),
    providerProcessingAuthorization: z.literal(true), archiveDeleteAcknowledgment: z.literal(true),
    temporaryPublicProviderExposureAuthorization: z.literal(true),
  }).strict(),
  z.object({ action: z.literal('retry'), ...commonMutation, idempotencyKey: uuid }).strict(),
  z.object({ action: z.literal('revoke'), ...commonMutation, idempotencyKey: uuid }).strict(),
  z.object({ action: z.literal('reconcile-upload'), ...commonMutation }).strict(),
  z.object({ action: z.literal('upload-instructions'), ...commonMutation }).strict(),
]);

function failure(message, statusCode = 400, failureCategory = 'VALIDATION') {
  return Object.assign(new Error(message), { statusCode, failureCategory });
}

export function parseEnrollmentRequest(value) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw failure('Enrollment request validation failed.');
  return parsed.data;
}

export function enrollmentEnabled(env = process.env) {
  return String(env[ENROLLMENT_FEATURE_FLAG] || '').trim().toLowerCase() === 'true';
}

export function enrollmentAccountAllowed(accountId, env = process.env) {
  const pinnedAccountId = String(env[ENROLLMENT_CANARY_ACCOUNT_FLAG] || '').trim();
  if (pinnedAccountId) return Boolean(accountId && accountId === pinnedAccountId);
  return env.VERCEL_ENV !== 'production';
}

export function assertEnrollmentAccountAllowed(accountId, env = process.env) {
  if (!enrollmentAccountAllowed(accountId, env)) throw failure('Phone-video enrollment is unavailable for this account.', 403, 'ENTITLEMENT');
}

export function enrollmentCanaryStartedAt(env = process.env) {
  const pinnedAccountId = String(env[ENROLLMENT_CANARY_ACCOUNT_FLAG] || '').trim();
  if (!pinnedAccountId && env.VERCEL_ENV !== 'production') return null;
  const value = String(env[ENROLLMENT_CANARY_STARTED_AT_FLAG] || '').trim();
  if (!pinnedAccountId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw failure('Phone-video enrollment canary boundary is not configured.', 503, 'CONFIG_MISSING');
  }
  const startedAt = new Date(value);
  if (!Number.isFinite(startedAt.getTime())) throw failure('Phone-video enrollment canary boundary is invalid.', 503, 'CONFIG_MISSING');
  return startedAt;
}

function assertCanaryCreatedAt(value, env, message) {
  const startedAt = enrollmentCanaryStartedAt(env);
  if (!startedAt) return;
  const createdAt = new Date(value);
  if (!Number.isFinite(createdAt.getTime()) || createdAt < startedAt) {
    throw failure(message, 403, 'ENTITLEMENT');
  }
}

export function assertEnrollmentCanaryRecord(record, env = process.env) {
  assertCanaryCreatedAt(record?.createdAt, env, 'This enrollment is outside the current private canary.');
}

export function assertEnrollmentCanaryPhoto(photo, env = process.env) {
  assertCanaryCreatedAt(photo?.createdAt, env, 'Identity photo is outside the current private canary.');
}

function expectedPrivateStore(env) {
  const expected = String(env.VIDEO_OS_ENROLLMENT_BLOB_STORE_ID || '').trim();
  const token = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  const tokenStore = /^vercel_blob_rw_([^_]+)_/i.exec(token)?.[1] || '';
  if (!expected || !tokenStore || tokenStore.toLowerCase() !== expected.toLowerCase()) throw failure('Enrollment private storage identity is not configured.', 503, 'CONFIG_MISSING');
  return expected;
}

function exactHttpsOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function assertEnrollmentCapability(env = process.env) {
  if (!enrollmentEnabled(env)) throw failure('Phone-video enrollment is disabled.', 503, 'CONFIG_MISSING');
  enrollmentCanaryStartedAt(env);
  if (String(env.STORAGE_DRIVER || 'blob').trim().toLowerCase() !== 'blob') throw failure('Phone-video enrollment requires private Blob storage.', 503, 'CONFIG_MISSING');
  if (String(env.WORKFLOW_DISPATCH_MODE || 'vercel').trim().toLowerCase() !== 'vercel') throw failure('Phone-video enrollment requires durable Workflow dispatch.', 503, 'CONFIG_MISSING');
  const storeId = expectedPrivateStore(env);
  const publicOrigin = exactHttpsOrigin(env.VIDEO_OS_PUBLIC_ORIGIN);
  if (!publicOrigin) throw failure('Enrollment public origin is not configured.', 503, 'CONFIG_MISSING');
  return { storeId, publicOrigin };
}

export function assertEnrollmentExtractionCapability(env = process.env) {
  const capability = assertEnrollmentCapability(env);
  if (String(env[ENROLLMENT_EXTRACTION_FLAG] || '').trim().toLowerCase() !== 'true') throw failure('Phone-video extraction is disabled.', 503, 'CONFIG_MISSING');
  return capability;
}

export function validateEnrollmentTransport(req, env = process.env) {
  const origin = exactHttpsOrigin(env.VIDEO_OS_PUBLIC_ORIGIN);
  const headers = req?.headers || {};
  if (!origin || headers.origin !== origin || !['same-origin', 'none', undefined].includes(headers['sec-fetch-site'])) throw failure('Origin not allowed.', 403, 'VALIDATION');
  if (String(headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw failure('JSON required.', 400, 'VALIDATION');
  return true;
}

function contextKey(secret) {
  const value = String(secret || '');
  if (value.length < 32) throw failure('Enrollment upload context signing is unavailable.', 503, 'CONFIG_MISSING');
  return value;
}

export function encodeEnrollmentUploadContext(context, secret = process.env.VIDEO_OS_SESSION_SECRET) {
  const payload = Buffer.from(JSON.stringify({ version: context?.version, enrollmentId: context?.enrollmentId, operationKey: context?.operationKey })).toString('base64url');
  const signature = crypto.createHmac('sha256', contextKey(secret)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function decodeEnrollmentUploadContext(value, secret = process.env.VIDEO_OS_SESSION_SECRET) {
  const [payload, provided, extra] = String(value || '').split('.');
  if (!payload || !provided || extra) throw failure('Enrollment upload context is invalid.');
  const expected = crypto.createHmac('sha256', contextKey(secret)).update(payload).digest();
  let observed;
  try { observed = Buffer.from(provided, 'base64url'); } catch { throw failure('Enrollment upload context is invalid.'); }
  if (observed.length !== expected.length || !crypto.timingSafeEqual(observed, expected)) throw failure('Enrollment upload context is invalid.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw failure('Enrollment upload context is invalid.'); }
  const parsed = z.object({ version: z.literal(1), enrollmentId: uuid, operationKey: uuid }).strict().safeParse(decoded);
  if (!parsed.success) throw failure('Enrollment upload context is invalid.');
  return parsed.data;
}

export function safeEnrollmentFilename(value, contentType) {
  const extension = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' }[contentType];
  if (!extension) throw failure('Enrollment content type is invalid.');
  const stem = String(value || 'phone-video').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'phone-video';
  return `${stem}${extension}`;
}

export function enrollmentUploadInstructions(enrollment, env = process.env) {
  assertEnrollmentCapability(env);
  if (!enrollment || enrollment.status !== ENROLLMENT_STATUSES.AWAITING_UPLOAD || enrollment.revokedAt) throw failure('Enrollment is not awaiting an upload.', 409, 'RECONCILIATION');
  return {
    pathname: enrollment.uploadPathname,
    handleUploadUrl: '/api/video-os-lite/enrollment-upload',
    clientPayload: encodeEnrollmentUploadContext({ version: 1, enrollmentId: enrollment.id, operationKey: enrollment.uploadOperationKey }, env.VIDEO_OS_SESSION_SECRET),
    access: 'private',
    multipart: true,
    maximumSizeInBytes: ENROLLMENT_MEDIA_LIMITS.maxSourceBytes,
    allowedContentTypes: [...ENROLLMENT_ALLOWED_CONTENT_TYPES],
    expiresAt: enrollment.uploadExpiresAt,
  };
}

export function assertEnrollmentPrivateReadback(result, enrollment, storeId) {
  const blob = result?.blob || result;
  if (!result?.stream || typeof result.stream[Symbol.asyncIterator] !== 'function' || blob?.pathname !== enrollment.uploadPathname || blob?.etag !== enrollment.uploadEtag
    || Number(blob?.size) !== Number(enrollment.declaredBytes) || blob?.contentType !== enrollment.declaredContentType) {
    throw failure('Enrollment upload could not be verified in private storage.', 503, 'PERSISTENCE');
  }
  if (!blob?.url) throw failure('Enrollment private storage omitted its private object identity.', 503, 'PERSISTENCE');
  let url;
  try { url = new URL(blob.url); } catch { throw failure('Enrollment private storage returned an invalid object identity.', 503, 'PERSISTENCE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.toLowerCase() !== `${String(storeId).toLowerCase()}.private.blob.vercel-storage.com`) {
    throw failure('Enrollment upload was not stored in the expected private store.', 503, 'PERSISTENCE');
  }
  return true;
}

export function assertEnrollmentTransition(from, to) {
  const allowed = {
    [ENROLLMENT_STATUSES.AWAITING_UPLOAD]: [ENROLLMENT_STATUSES.SOURCE_HASHING, ENROLLMENT_STATUSES.EXPIRED, ENROLLMENT_STATUSES.REVOKED],
    [ENROLLMENT_STATUSES.SOURCE_HASHING]: [ENROLLMENT_STATUSES.AWAITING_CONSENT, ENROLLMENT_STATUSES.FAILED, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED],
    [ENROLLMENT_STATUSES.AWAITING_CONSENT]: [ENROLLMENT_STATUSES.EXTRACTION_QUEUED, ENROLLMENT_STATUSES.EXPIRED, ENROLLMENT_STATUSES.REVOKED],
    [ENROLLMENT_STATUSES.EXTRACTION_QUEUED]: [ENROLLMENT_STATUSES.EXTRACTING, ENROLLMENT_STATUSES.FAILED, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED],
    [ENROLLMENT_STATUSES.EXTRACTING]: [ENROLLMENT_STATUSES.IDENTITY_READY, ENROLLMENT_STATUSES.FAILED, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED],
    [ENROLLMENT_STATUSES.FAILED]: [ENROLLMENT_STATUSES.SOURCE_HASHING, ENROLLMENT_STATUSES.EXTRACTION_QUEUED, ENROLLMENT_STATUSES.REVOKED, ENROLLMENT_STATUSES.EXPIRED],
    [ENROLLMENT_STATUSES.IDENTITY_READY]: [ENROLLMENT_STATUSES.REVOKED],
    [ENROLLMENT_STATUSES.EXPIRED]: [], [ENROLLMENT_STATUSES.REVOKED]: [],
  };
  if (!allowed[from]?.includes(to)) throw failure(`Invalid enrollment transition: ${from} -> ${to}.`, 409, 'RECONCILIATION');
  return true;
}

export { ENROLLMENT_MEDIA_CONSENT_PURPOSE, ENROLLMENT_MEDIA_LIMITS };
