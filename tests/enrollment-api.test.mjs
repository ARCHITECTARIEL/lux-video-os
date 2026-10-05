import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createEnrollmentHandler } from '../routes/video-os-lite/enrollments.js';
import { createEnrollmentUploadHandler } from '../routes/video-os-lite/enrollment-upload.js';
import { ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_CONTRACT_VERSION, ENROLLMENT_STATUSES, decodeEnrollmentUploadContext, encodeEnrollmentUploadContext } from '../lib/enrollment-policy.js';
import { identityEnrollmentExpiryWorkflowMetadata } from '../workflows/identity-enrollment-metadata.js';

const accountId = 'enrollment-api-owner';
const enrollmentId = '11111111-1111-4111-8111-111111111111';
const photoAssetId = '22222222-2222-4222-8222-222222222222';
const operationKey = '33333333-3333-4333-8333-333333333333';
const idempotencyKey = '44444444-4444-4444-8444-444444444444';
const sessionSecret = 'enrollment-api-test-session-secret-32';

function environment(enabled = true) {
  process.env.VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED = enabled ? 'true' : '';
  process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED = enabled ? 'true' : '';
  process.env.VIDEO_OS_ENROLLMENT_BLOB_STORE_ID = 'store123';
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_store123_secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video.example';
  process.env.VIDEO_OS_SESSION_SECRET = sessionSecret;
  process.env.STORAGE_DRIVER = 'blob';
  process.env.WORKFLOW_DISPATCH_MODE = 'vercel';
}

function enrollment(overrides = {}) {
  return {
    id: enrollmentId, accountId, idempotencyKey, correlationId: 'corr', contractVersion: ENROLLMENT_CONTRACT_VERSION,
    status: ENROLLMENT_STATUSES.AWAITING_UPLOAD, stateVersion: 1, displayName: 'Ariel', photoAssetId, photoSha256: 'c'.repeat(64),
    declaredFilename: 'phone.mov', declaredContentType: 'video/quicktime', declaredBytes: 80_000_000,
    uploadPathname: `video-os/enrollment-sources/account/${enrollmentId}/phone.mov`, uploadEtag: null,
    uploadOperationKey: operationKey, uploadExpiresAt: new Date(Date.now() + 600_000), expiresAt: new Date(Date.now() + 3_600_000),
    sourceMetadata: {}, attemptCount: 0, cleanupStatus: 'NOT_REQUIRED', createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

function request(method, body, url = '/api/video-os-lite/enrollments', headers = {}) {
  return {
    method, url,
    headers: { origin: 'https://video.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
}

function response() {
  return {
    headers: {}, chunks: [], setHeader(name, value) { this.headers[name] = value; },
    write(value) { this.chunks.push(Buffer.from(value)); return true; },
    end(raw) { if (raw !== undefined) this.body = JSON.parse(raw); this.ended = true; }, destroy() { this.destroyed = true; },
  };
}

test('disabled capability still permits safe existing-state reads and schema-not-yet-present fallback', async () => {
  environment(false);
  let queried = 0;
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId }),
    listOwnedEnrollments: async () => { queried++; throw Object.assign(new Error('missing relation'), { code: '42P01' }); },
  });
  const res = response();
  await handler(request('GET', undefined), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.deepEqual(res.body.enrollments, []);
  assert.equal(queried, 1);
});

test('provider reconsent binds the authenticated owner and never dispatches media or provider work', async () => {
  environment(true);
  const identityId = '55555555-5555-4555-8555-555555555555';
  const input = {
    action: 'provider-reconsent', contractVersion: ENROLLMENT_CONTRACT_VERSION,
    enrollmentId, identityId, expectedStateVersion: 7, idempotencyKey,
    policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, purpose: 'identity-voice-enrollment',
    sourcePhotoSha256: 'c'.repeat(64), sourceVideoSha256: 'a'.repeat(64), derivedVoiceSha256: 'b'.repeat(64),
    faceAuthorization: true, audioExtractionAuthorization: true, voiceAuthorization: true,
    providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  };
  const received = [];
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId }),
    consumeRateLimit: async () => true, ensureAccount: async () => ({}),
    requireAnyPersistedRenderAuthorization: async () => ({}),
    grantProviderBridgeReconsent: async value => {
      received.push(value);
      return {
        enrollment: enrollment({ status: ENROLLMENT_STATUSES.IDENTITY_READY, identityId, stateVersion: 8 }),
        replayed: received.length > 1,
      };
    },
    getOwnedIdentity: async (owner, id) => {
      assert.equal(owner, accountId); assert.equal(id, identityId);
      return { id, overallStatus: 'DRAFT', avatarStatus: 'DRAFT', voiceStatus: 'DRAFT' };
    },
    start: async () => assert.fail('Reconsent must not dispatch a workflow.'),
    getPrivateBlob: async () => assert.fail('Reconsent must not upload or process media.'),
    createEnrollment: async () => assert.fail('Reconsent must preserve the existing enrollment.'),
  });
  for (const statusCode of [201, 200]) {
    const res = response();
    await handler(request('POST', input), res);
    assert.equal(res.statusCode, statusCode);
    assert.equal(res.body.enrollment.stateVersion, 8);
    assert.deepEqual(received.at(-1), { accountId, input });
  }
  const rejected = response();
  await handler(request('POST', { ...input, accountId: 'other-account' }), rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(received.length, 2, 'A caller cannot substitute the account scope.');
});

test('create returns resumable private multipart instructions and revoke remains available after feature shutdown', async () => {
  environment(true);
  let authorizationChecks = 0;
  const startedMetadata = [];
  const row = enrollment();
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId, email: 'owner@example.test' }),
    consumeRateLimit: async () => true,
    ensureAccount: async () => ({}),
    requireAnyPersistedRenderAuthorization: async () => { authorizationChecks++; },
    createEnrollment: async () => ({ enrollment: row, replayed: false }),
    getOwnedIdentity: async () => null,
    revokeEnrollment: async () => ({ enrollment: { ...row, status: ENROLLMENT_STATUSES.REVOKED, stateVersion: 2, revokedAt: new Date() }, replayed: false }),
    getPrivateBlob: async () => null,
    recordEnrollmentCleanup: async () => ({}),
    start: async metadata => { startedMetadata.push(metadata); return { runId: 'test-run' }; },
  });
  const createRes = response();
  await handler(request('POST', {
    action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey, displayName: 'Ariel', photoAssetId,
    filename: 'phone.mov', contentType: 'video/quicktime', bytes: 80_000_000,
  }), createRes);
  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.body.upload.access, 'private');
  assert.equal(createRes.body.upload.multipart, true);
  assert.deepEqual(decodeEnrollmentUploadContext(createRes.body.upload.clientPayload, sessionSecret), { version: 1, enrollmentId, operationKey });
  assert.equal(authorizationChecks, 1);

  environment(false);
  const revokeRes = response();
  await handler(request('POST', { action: 'revoke', contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId, expectedStateVersion: 1, idempotencyKey }), revokeRes);
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.body.enrollment.status, ENROLLMENT_STATUSES.REVOKED);
  assert.equal(authorizationChecks, 1, 'revocation never depends on a current render entitlement');
  assert.equal(startedMetadata.filter(metadata => metadata === identityEnrollmentExpiryWorkflowMetadata).length, 2,
    'create and revoke each schedule the post-upload-expiry cleanup recheck');
});

test('production canary hides enrollment from other accounts and denies their new writes', async () => {
  environment(true);
  process.env.VERCEL_ENV = 'production';
  process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID = accountId;
  process.env.VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT = '2026-10-04T14:00:00.000Z';
  try {
    let created = 0;
    let tokenIssued = 0;
    let historicalMutations = 0;
    const handler = createEnrollmentHandler({
      sessionFromRequest: () => ({ accountId: 'other-account', email: 'other@example.test' }),
      listOwnedEnrollments: async () => [],
      createEnrollment: async () => { created++; return { enrollment: enrollment() }; },
      revokeEnrollment: async () => ({ enrollment: enrollment({ status: ENROLLMENT_STATUSES.REVOKED }), replayed: false }),
      getPrivateBlob: async () => null,
      recordEnrollmentCleanup: async () => ({}),
      start: async () => ({ runId: 'test-run' }),
    });
    const getRes = response();
    await handler(request('GET'), getRes);
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.body.enabled, false);
    assert.equal(getRes.body.extractionEnabled, false);

    const ownerHandler = createEnrollmentHandler({
      sessionFromRequest: () => ({ accountId }),
      listOwnedEnrollments: async () => [],
      getOwnedEnrollment: async () => enrollment({ createdAt: '2026-10-04T13:00:00.000Z' }),
      retryEnrollment: async () => { historicalMutations++; },
      grantProviderBridgeReconsent: async () => { historicalMutations++; },
    });
    const ownerGetRes = response();
    await ownerHandler(request('GET'), ownerGetRes);
    assert.equal(ownerGetRes.statusCode, 200);
    assert.equal(ownerGetRes.body.enabled, true);
    assert.equal(ownerGetRes.body.extractionEnabled, true);

    const historicalRetry = response();
    await ownerHandler(request('POST', { action: 'retry', contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId, expectedStateVersion: 1, idempotencyKey }), historicalRetry);
    assert.equal(historicalRetry.statusCode, 403);

    const historicalReconsent = response();
    await ownerHandler(request('POST', {
      action: 'provider-reconsent', contractVersion: ENROLLMENT_CONTRACT_VERSION,
      enrollmentId, identityId: '55555555-5555-4555-8555-555555555555', expectedStateVersion: 1, idempotencyKey,
      policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, purpose: 'identity-voice-enrollment',
      sourcePhotoSha256: 'a'.repeat(64), sourceVideoSha256: 'b'.repeat(64), derivedVoiceSha256: 'c'.repeat(64),
      audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
      providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: true,
    }), historicalReconsent);
    assert.equal(historicalReconsent.statusCode, 403);
    assert.equal(historicalMutations, 0);

    delete process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED;
    const extractionOffRes = response();
    await ownerHandler(request('POST', {
      action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey, displayName: 'Owner', photoAssetId,
      filename: 'phone.mov', contentType: 'video/quicktime', bytes: 10_000,
    }), extractionOffRes);
    assert.equal(extractionOffRes.statusCode, 503, 'a new enrollment cannot start when extraction is disabled');
    process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED = 'true';

    const createRes = response();
    await handler(request('POST', {
      action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey, displayName: 'Other', photoAssetId,
      filename: 'phone.mov', contentType: 'video/quicktime', bytes: 10_000,
    }), createRes);
    assert.equal(createRes.statusCode, 403);
    assert.equal(created, 0);

    const uploadHandler = createEnrollmentUploadHandler({
      sessionFromRequest: () => ({ accountId: 'other-account' }),
      assertEnrollmentPrivateStoreReady: async () => { tokenIssued++; },
      handleUpload: async () => { tokenIssued++; },
    });
    const uploadReq = request('POST', { type: 'blob.generate-client-token' }, '/api/video-os-lite/enrollment-upload');
    uploadReq.body = { type: 'blob.generate-client-token' };
    const uploadRes = response();
    await uploadHandler(uploadReq, uploadRes);
    assert.equal(uploadRes.statusCode, 403);
    assert.equal(tokenIssued, 0);

    const historicalCallbackHandler = createEnrollmentUploadHandler({
      getEnrollmentForUploadCallback: async () => enrollment({ createdAt: '2026-10-04T13:00:00.000Z' }),
      getPrivateBlob: async () => assert.fail('Historical callback must not read media.'),
      acceptEnrollmentUpload: async () => { historicalMutations++; },
      handleUpload: async options => options.onUploadCompleted({
        blob: { pathname: enrollment().uploadPathname, contentType: 'video/quicktime', etag: 'test-etag' },
        tokenPayload: encodeEnrollmentUploadContext({ version: 1, enrollmentId, operationKey }, sessionSecret),
      }),
    });
    const callbackReq = request('POST', { type: 'blob.upload-completed' }, '/api/video-os-lite/enrollment-upload');
    callbackReq.body = { type: 'blob.upload-completed' };
    const callbackRes = response();
    await historicalCallbackHandler(callbackReq, callbackRes);
    assert.equal(callbackRes.statusCode, 403);
    assert.equal(historicalMutations, 0);

    const changedBoundaryHandler = createEnrollmentUploadHandler({
      getEnrollmentForUploadCallback: async () => enrollment({ createdAt: '2026-10-04T14:00:01.000Z' }),
      getPrivateBlob: async () => assert.fail('Changed-boundary callback must not read media.'),
      acceptEnrollmentUpload: async () => { historicalMutations++; },
      handleUpload: async options => options.onUploadCompleted({
        blob: { pathname: enrollment().uploadPathname, contentType: 'video/quicktime', etag: 'test-etag' },
        tokenPayload: encodeEnrollmentUploadContext({ version: 1, enrollmentId, operationKey }, sessionSecret),
      }),
    });
    process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID = 'different-account';
    const changedPinRes = response();
    await changedBoundaryHandler(callbackReq, changedPinRes);
    assert.equal(changedPinRes.statusCode, 403);
    process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID = accountId;
    process.env.VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT = '2026-10-04T14:00:02.000Z';
    const changedEpochRes = response();
    await changedBoundaryHandler(callbackReq, changedEpochRes);
    assert.equal(changedEpochRes.statusCode, 403);
    assert.equal(historicalMutations, 0);
    process.env.VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT = '2026-10-04T14:00:00.000Z';

    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    const unpinnedGetRes = response();
    await ownerHandler(request('GET'), unpinnedGetRes);
    assert.equal(unpinnedGetRes.body.enabled, false, 'missing production pin cannot expose enrollment');

    const revokeRes = response();
    await handler(request('POST', { action: 'revoke', contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId, expectedStateVersion: 1, idempotencyKey }), revokeRes);
    assert.equal(revokeRes.statusCode, 200, 'revocation remains available after canary access is removed');
  } finally {
    delete process.env.VERCEL_ENV;
    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT;
  }
});

test('owner-only source preview streams exact private bytes without exposing a Blob URL', async () => {
  environment(false);
  const bytes = Buffer.from('private phone video');
  const row = enrollment({ uploadEtag: 'etag-1', sourceBytes: bytes.length, sourceSha256: 'a'.repeat(64), status: ENROLLMENT_STATUSES.AWAITING_CONSENT });
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId }), getOwnedEnrollment: async () => row,
    getPrivateBlob: async () => ({ stream: Readable.from([bytes]), blob: { pathname: row.uploadPathname, etag: row.uploadEtag } }),
  });
  const res = response();
  await handler(request('GET', undefined, `/api/video-os-lite/enrollments?enrollmentId=${enrollmentId}&preview=video`), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), bytes);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(JSON.stringify(res).includes('blob.vercel-storage.com'), false);
});

test('source preview cancels invalid streams and removes backpressure listeners', async () => {
  environment(false);
  let cancelled = 0;
  const invalid = enrollment({ uploadEtag: 'etag-1', sourceBytes: -1, sourceSha256: 'a'.repeat(64), status: ENROLLMENT_STATUSES.AWAITING_CONSENT });
  const invalidHandler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId }), getOwnedEnrollment: async () => invalid,
    getPrivateBlob: async () => ({ stream: { destroy: () => { cancelled++; } }, blob: { pathname: invalid.uploadPathname, etag: invalid.uploadEtag } }),
  });
  const invalidRes = response();
  await invalidHandler(request('GET', undefined, `/api/video-os-lite/enrollments?enrollmentId=${enrollmentId}&preview=video`), invalidRes);
  assert.equal(invalidRes.statusCode, 410);
  assert.equal(cancelled, 1);

  const bytes = Buffer.from('backpressured private video');
  const row = enrollment({ uploadEtag: 'etag-2', sourceBytes: bytes.length, sourceSha256: 'b'.repeat(64), status: ENROLLMENT_STATUSES.AWAITING_CONSENT });
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId }), getOwnedEnrollment: async () => row,
    getPrivateBlob: async () => ({ stream: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]), blob: { pathname: row.uploadPathname, etag: row.uploadEtag } }),
  });
  const res = new EventEmitter();
  res.headers = {}; res.chunks = []; res.firstWrite = true;
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.write = value => {
    res.chunks.push(Buffer.from(value));
    if (res.firstWrite) { res.firstWrite = false; setImmediate(() => res.emit('drain')); return false; }
    return true;
  };
  res.end = () => { res.ended = true; };
  res.destroy = () => { res.destroyed = true; };
  await handler(request('GET', undefined, `/api/video-os-lite/enrollments?enrollmentId=${enrollmentId}&preview=video`), res);
  assert.equal(res.ended, true);
  assert.deepEqual(Buffer.concat(res.chunks), bytes);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
  assert.equal(res.listenerCount('drain'), 0);
});

test('SDK upload token and callback are bound to the exact operation, private readback and hash workflow', async () => {
  environment(true);
  const row = enrollment();
  const clientPayload = encodeEnrollmentUploadContext({ version: 1, enrollmentId, operationKey }, sessionSecret);
  let accepted;
  let started;
  const handler = createEnrollmentUploadHandler({
    assertEnrollmentPrivateStoreReady: async () => ({ storeId: 'store123' }),
    sessionFromRequest: () => ({ accountId }),
    authorizeEnrollmentUpload: async input => { assert.equal(input.pathname, row.uploadPathname); return row; },
    getEnrollmentForUploadCallback: async () => row,
    getPrivateBlob: async () => ({
      stream: Readable.from([Buffer.from('video')]),
      blob: { pathname: row.uploadPathname, etag: 'etag-1', size: row.declaredBytes, contentType: row.declaredContentType, url: `https://store123.private.blob.vercel-storage.com/${row.uploadPathname}` },
    }),
    deletePrivateBlob: async () => ({ deleted: true }),
    acceptEnrollmentUpload: async input => {
      accepted = input;
      return { enrollment: { ...row, status: ENROLLMENT_STATUSES.SOURCE_HASHING, workflowOperationKey: '55555555-5555-4555-8555-555555555555' }, dispatch: true };
    },
    claimEnrollmentWorkflowDispatch: async () => ({ claimed: true, dispatchClaim: 'dispatching:test' }),
    recordEnrollmentWorkflowRun: async () => ({}),
    start: async (_metadata, args) => { started = args; return { runId: 'run' }; },
    handleUpload: async options => {
      const token = await options.onBeforeGenerateToken(row.uploadPathname, clientPayload, true);
      assert.deepEqual(token.allowedContentTypes, ['video/quicktime']);
      assert.equal(token.allowOverwrite, false);
      await options.onUploadCompleted({ blob: { pathname: row.uploadPathname, contentType: row.declaredContentType, etag: 'etag-1' }, tokenPayload: clientPayload });
      return { type: 'blob.upload-completed', response: 'ok' };
    },
  });
  const req = request('POST', { type: 'blob.generate-client-token' }, '/api/video-os-lite/enrollment-upload');
  req.body = { type: 'blob.generate-client-token' };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(accepted.etag, 'etag-1');
  assert.deepEqual(started, [enrollmentId, '55555555-5555-4555-8555-555555555555']);
});

test('late callbacks for revoked or terminal-failed enrollment delete the exact private object', async () => {
  environment(true);
  const clientPayload = encodeEnrollmentUploadContext({ version: 1, enrollmentId, operationKey }, sessionSecret);
  for (const terminal of [
    { status: ENROLLMENT_STATUSES.REVOKED, revokedAt: new Date(), cleanupStatus: 'DELETED' },
    { status: ENROLLMENT_STATUSES.FAILED, failureCode: 'DERIVATION_MISMATCH', cleanupStatus: 'DELETED' },
  ]) {
    const row = enrollment({ ...terminal, stateVersion: 2 });
    let deleted;
    let cleanup;
    const handler = createEnrollmentUploadHandler({
      getEnrollmentForUploadCallback: async () => row,
      getPrivateBlob: async () => ({
        stream: Readable.from([]),
        blob: { pathname: row.uploadPathname, etag: 'late-etag', size: row.declaredBytes, contentType: row.declaredContentType, url: `https://store123.private.blob.vercel-storage.com/${row.uploadPathname}` },
      }),
      acceptEnrollmentUpload: async () => { throw Object.assign(new Error('Completed upload does not match its enrollment.'), { statusCode: 409, code: 'UPLOAD_COMPLETION_MISMATCH' }); },
      deletePrivateBlob: async (_classification, pathname, options) => { deleted = { pathname, ifMatch: options.ifMatch }; return { deleted: true }; },
      recordEnrollmentCleanup: async input => { cleanup = input; },
      handleUpload: async options => {
        await options.onUploadCompleted({ blob: { pathname: row.uploadPathname, contentType: row.declaredContentType, etag: 'late-etag' }, tokenPayload: clientPayload });
      },
    });
    const req = request('POST', { type: 'blob.upload-completed' }, '/api/video-os-lite/enrollment-upload');
    req.body = { type: 'blob.upload-completed' };
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(deleted, { pathname: row.uploadPathname, ifMatch: 'late-etag' });
    assert.deepEqual(cleanup, { enrollmentId, deleted: true });
  }
});
