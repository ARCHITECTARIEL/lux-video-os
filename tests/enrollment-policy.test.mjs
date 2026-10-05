import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  ENROLLMENT_CONSENT_POLICY_VERSION,
  LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION,
  ENROLLMENT_CONTRACT_VERSION,
  ENROLLMENT_STATUSES,
  assertEnrollmentAccountAllowed,
  assertEnrollmentCanaryRecord,
  assertEnrollmentCanaryPhoto,
  assertEnrollmentCapability,
  decodeEnrollmentUploadContext,
  enrollmentNeedsTerminalCleanup,
  encodeEnrollmentUploadContext,
  enrollmentAccountAllowed,
  enrollmentCanaryStartedAt,
  parseEnrollmentRequest,
  validateEnrollmentTransport,
} from '../lib/enrollment-policy.js';
import { enrollmentDto } from '../lib/enrollment-dto.js';
import { assertEnrollmentPrivateStoreReady, clearEnrollmentPrivateStoreProofForTests } from '../lib/enrollment-private-store.js';

const sessionSecret = 'enrollment-policy-test-session-secret-32';
const createRequest = {
  action: 'create',
  contractVersion: ENROLLMENT_CONTRACT_VERSION,
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  displayName: 'Ariel',
  photoAssetId: '22222222-2222-4222-8222-222222222222',
  filename: 'phone-video.mov',
  contentType: 'video/quicktime',
  bytes: 80_000_000,
};

test('enrollment requests are strict and consent is bound to the server-observed source hash', () => {
  assert.deepEqual(parseEnrollmentRequest(createRequest), createRequest);
  for (const mutation of [
    { provider: 'heygen' }, { pathname: 'attacker/path' }, { access: 'public' }, { bytes: 104_857_601 }, { contentType: 'video/avi' },
  ]) assert.throws(() => parseEnrollmentRequest({ ...createRequest, ...mutation }), { failureCategory: 'VALIDATION' });

  const consent = parseEnrollmentRequest({
    action: 'consent', contractVersion: ENROLLMENT_CONTRACT_VERSION,
    enrollmentId: '33333333-3333-4333-8333-333333333333', expectedStateVersion: 4,
    idempotencyKey: '44444444-4444-4444-8444-444444444444', policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
    purpose: 'identity-voice-enrollment', sourceVideoSha256: 'a'.repeat(64),
    audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
    providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  });
  assert.equal(consent.sourceVideoSha256, 'a'.repeat(64));
  assert.throws(() => parseEnrollmentRequest({ ...consent, sourceVideoSha256: 'b' }), { failureCategory: 'VALIDATION' });
  assert.throws(() => parseEnrollmentRequest({ ...consent, audioExtractionAuthorization: false }), { failureCategory: 'VALIDATION' });
  for (const value of [false, undefined, 'true', 1]) {
    assert.throws(() => parseEnrollmentRequest({ ...consent, temporaryPublicProviderExposureAuthorization: value }), { failureCategory: 'VALIDATION' });
  }
  assert.throws(() => parseEnrollmentRequest({ ...consent, policyVersion: LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION }), { failureCategory: 'VALIDATION' });

  const reconsent = {
    ...consent, action: 'provider-reconsent',
    identityId: '55555555-5555-4555-8555-555555555555',
    sourcePhotoSha256: 'b'.repeat(64), derivedVoiceSha256: 'c'.repeat(64),
  };
  assert.deepEqual(parseEnrollmentRequest(reconsent), reconsent);
  for (const key of ['sourcePhotoSha256', 'sourceVideoSha256', 'derivedVoiceSha256', 'identityId']) {
    assert.throws(() => parseEnrollmentRequest({ ...reconsent, [key]: undefined }), { failureCategory: 'VALIDATION' });
  }
  for (const key of ['audioExtractionAuthorization', 'faceAuthorization', 'voiceAuthorization', 'providerProcessingAuthorization', 'archiveDeleteAcknowledgment', 'temporaryPublicProviderExposureAuthorization']) {
    assert.throws(() => parseEnrollmentRequest({ ...reconsent, [key]: false }), { failureCategory: 'VALIDATION' });
  }
  assert.throws(() => parseEnrollmentRequest({ ...reconsent, file: 'replacement-video.mov' }), { failureCategory: 'VALIDATION' });
});

test('feature and exact private Blob store identity fail closed', () => {
  const valid = {
    VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED: 'true', STORAGE_DRIVER: 'blob',
    VIDEO_OS_ENROLLMENT_BLOB_STORE_ID: 'store123', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secret',
    VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example', WORKFLOW_DISPATCH_MODE: 'vercel',
  };
  assert.deepEqual(assertEnrollmentCapability(valid), { storeId: 'store123', publicOrigin: 'https://video.example' });
  for (const mutation of [
    { VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED: '' }, { STORAGE_DRIVER: 'fs' },
    { VIDEO_OS_ENROLLMENT_BLOB_STORE_ID: '' }, { VIDEO_OS_ENROLLMENT_BLOB_STORE_ID: 'other' },
    { BLOB_READ_WRITE_TOKEN: '' }, { VIDEO_OS_PUBLIC_ORIGIN: 'http://video.example' }, { WORKFLOW_DISPATCH_MODE: 'poll' },
  ]) assert.throws(() => assertEnrollmentCapability({ ...valid, ...mutation }), { failureCategory: 'CONFIG_MISSING' });
});

test('production enrollment canary permits only its pinned account', () => {
  const env = { VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'owner-account' };
  assert.equal(enrollmentAccountAllowed('owner-account', env), true);
  assert.equal(enrollmentAccountAllowed('other-account', env), false);
  assert.equal(enrollmentAccountAllowed('owner-account', { VERCEL_ENV: 'production' }), false);
  assert.equal(enrollmentAccountAllowed('owner-account', { VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: ' owner-account ' }), true);
  assert.equal(enrollmentAccountAllowed('other-account', { VERCEL_ENV: 'preview' }), true);
  assert.equal(enrollmentAccountAllowed('other-account', { ...env, VERCEL_ENV: 'preview' }), false);
  assert.throws(() => assertEnrollmentAccountAllowed('other-account', env), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
});

test('private canary boundary rejects historical enrollment records and missing epochs', () => {
  const env = {
    VERCEL_ENV: 'production', VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'owner-account',
    VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT: '2026-10-04T14:00:00.000Z',
  };
  assert.equal(enrollmentCanaryStartedAt(env).toISOString(), env.VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT);
  assert.doesNotThrow(() => assertEnrollmentCanaryRecord({ createdAt: '2026-10-04T14:00:01.000Z' }, env));
  assert.throws(() => assertEnrollmentCanaryRecord({ createdAt: '2026-10-04T13:59:59.000Z' }, env), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  assert.doesNotThrow(() => assertEnrollmentCanaryPhoto({ createdAt: '2026-10-04T14:00:01.000Z' }, env));
  assert.throws(() => assertEnrollmentCanaryPhoto({ createdAt: '2026-10-04T13:59:59.000Z' }, env), { statusCode: 403, failureCategory: 'ENTITLEMENT' });
  assert.throws(() => enrollmentCanaryStartedAt({ ...env, VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT: '' }), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  assert.throws(() => enrollmentCanaryStartedAt({ ...env, VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT: '2026-10-04T14:00:00-04:00' }), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  assert.equal(enrollmentCanaryStartedAt({ VERCEL_ENV: 'preview' }), null);
});

test('terminal cleanup policy preserves retryable failures until retry or TTL expiry', () => {
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.FAILED, attemptCount: 1, failureCode: 'PERSISTENCE' }), false);
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.FAILED, attemptCount: 3, failureCode: 'PERSISTENCE' }), true);
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.FAILED, attemptCount: 1, failureCode: 'DERIVATION_MISMATCH' }), true);
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.REVOKED }), true);
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.EXPIRED }), true);
  assert.equal(enrollmentNeedsTerminalCleanup({ status: ENROLLMENT_STATUSES.IDENTITY_READY }), false);
});

test('upload client context is opaque, authenticated and tamper evident', () => {
  const context = { version: 1, enrollmentId: '33333333-3333-4333-8333-333333333333', operationKey: '55555555-5555-4555-8555-555555555555' };
  const encoded = encodeEnrollmentUploadContext(context, sessionSecret);
  assert.doesNotMatch(encoded, /33333333|55555555/);
  assert.deepEqual(decodeEnrollmentUploadContext(encoded, sessionSecret), context);
  assert.throws(() => decodeEnrollmentUploadContext(`${encoded.slice(0, -1)}x`, sessionSecret), { failureCategory: 'VALIDATION' });
});

test('transport and DTO expose only the browser contract', () => {
  assert.doesNotThrow(() => validateEnrollmentTransport({ headers: { origin: 'https://video.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example' }));
  assert.throws(() => validateEnrollmentTransport({ headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }, { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example' }), { statusCode: 403 });
  const dto = enrollmentDto({
    id: 'enrollment', status: ENROLLMENT_STATUSES.AWAITING_CONSENT, stateVersion: 4, displayName: 'Ariel',
    uploadPathname: 'video-os/enrollment-sources/private.mov', uploadEtag: 'etag', uploadOperationKey: 'secret-op', accountId: 'account',
    sourceSha256: 'a'.repeat(64), sourceBytes: 100, declaredContentType: 'video/quicktime', sourceMetadata: {},
    consentPolicyVersion: null, consentedAt: null, revokedAt: null, createdAt: 'now', updatedAt: 'now',
  });
  assert.equal(dto.sourceVideo.sha256, 'a'.repeat(64));
  for (const secret of ['video-os/enrollment-sources', 'etag', 'secret-op', 'account']) assert.equal(JSON.stringify(dto).includes(secret), false);
});

test('private-store proof uses noncustomer bytes, anonymous denial, conditional cleanup and token-scoped cache', async () => {
  clearEnrollmentPrivateStoreProofForTests();
  const env = {
    VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED: 'true', STORAGE_DRIVER: 'blob', WORKFLOW_DISPATCH_MODE: 'vercel',
    VIDEO_OS_ENROLLMENT_BLOB_STORE_ID: 'store123', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secret',
    VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example', VERCEL_PROJECT_ID: 'project', VERCEL_ENV: 'preview',
  };
  let writes = 0; let deletes = 0; let anonymousBodiesCancelled = 0; let captured; let anonymousSignal;
  const put = async (_classification, pathname, bytes) => {
    writes++; captured = Buffer.from(bytes);
    return { pathname, etag: 'probe-etag', url: `https://store123.private.blob.vercel-storage.com/${pathname}` };
  };
  const get = async pathname => ({ stream: Readable.from([captured]), blob: { pathname, etag: 'probe-etag', url: `https://STORE123.private.blob.vercel-storage.com/${pathname}` } });
  const del = async (_classification, _pathname, options) => { assert.equal(options.ifMatch, 'probe-etag'); deletes++; };
  await assertEnrollmentPrivateStoreReady({
    env, put, get, del,
    fetchImpl: async (_url, options) => {
      anonymousSignal = options.signal;
      return { status: 403, body: { cancel: async () => { anonymousBodiesCancelled++; } } };
    },
    now: 1_000,
  });
  await assertEnrollmentPrivateStoreReady({ env, put, get, del, fetchImpl: async () => ({ status: 403 }), now: 2_000 });
  assert.equal(writes, 1); assert.equal(deletes, 1);
  assert.equal(anonymousBodiesCancelled, 1);
  assert.equal(anonymousSignal instanceof AbortSignal, true, 'anonymous privacy probe is bounded by an abort signal');

  clearEnrollmentPrivateStoreProofForTests();
  await assert.rejects(assertEnrollmentPrivateStoreReady({ env, put, get, del, fetchImpl: async () => ({ status: 200 }), now: 3_000 }), { code: 'PRIVATE_STORE_UNVERIFIED' });
  assert.equal(deletes, 2, 'failed privacy proof still conditionally deletes its noncustomer object');
});
