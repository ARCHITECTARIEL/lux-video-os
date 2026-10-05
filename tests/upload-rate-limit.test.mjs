// Dedicated coverage for the upload route's rate limiting, split out of
// tests/upload-write-order.test.mjs (which defaults rateLimit to
// always-allow so its own write-order assertions aren't coupled to this).
// Follows the same createUploadHandler() dependency-injection harness as
// that file, plus the live consumeRateLimit integration-test convention
// established in tests/copywriter.test.mjs (real DB, skipped when
// DATABASE_URL isn't configured).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createUploadHandler } from '../api/video-os-lite/uploads.js';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { ensureAccount } from '../db/repositories.js';
import { rateLimits, users } from '../db/schema.js';

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

function request(body = {}) {
  return {
    method: 'POST',
    headers: { 'x-request-id': 'upload-rate-limit-correlation' },
    body: { name: 'portrait.png', dataUrl: PNG_DATA_URL, ...body },
  };
}

function harness(overrides = {}) {
  const calls = { blobWrites: 0, databaseWrites: 0, rateLimitCalls: [] };
  const dependencies = {
    requestId: () => 'upload-rate-limit-correlation',
    sessionFromRequest: () => ({ accountId: 'account-one' }),
    assertDatabaseConfigured: () => true,
    blobToken: () => 'test-token-never-sent',
    putPrivateBlob: async (_classification, pathname) => {
      calls.blobWrites += 1;
      return { pathname, etag: 'created-object-etag' };
    },
    deletePrivateBlob: async () => ({ deleted: true }),
    getOwnedMediaAsset: async () => null,
    addUploadMediaAsset: async (asset) => {
      calls.databaseWrites += 1;
      return asset;
    },
    logUploadPersistenceError: () => {},
    ...overrides,
  };
  return { calls, handler: createUploadHandler(dependencies) };
}

test('upload handler returns 429 without touching Blob or database writes when the limit is exhausted', async () => {
  const { calls, handler } = harness({ rateLimit: async () => false });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.equal(calls.blobWrites, 0);
  assert.equal(calls.databaseWrites, 0);
});

test('production identity source uploads require the exact enrollment canary account', async () => {
  const prior = Object.fromEntries(['VERCEL_ENV', 'VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED', 'VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED', 'VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID', 'VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT', 'VIDEO_OS_ENROLLMENT_BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN', 'VIDEO_OS_PUBLIC_ORIGIN', 'WORKFLOW_DISPATCH_MODE', 'STORAGE_DRIVER'].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    VERCEL_ENV: 'production', VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED: 'true', VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED: 'true',
    VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'canary-account', VIDEO_OS_ENROLLMENT_BLOB_STORE_ID: 'store123',
    VIDEO_OS_ENROLLMENT_CANARY_STARTED_AT: '2026-10-04T14:00:00.000Z',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secret', VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example',
    WORKFLOW_DISPATCH_MODE: 'vercel', STORAGE_DRIVER: 'blob',
  });
  try {
    const { calls, handler } = harness({ rateLimit: async () => true });
    const denied = response();
    await handler(request({ kind: 'identity_photo' }), denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.blobWrites, 0);
    assert.equal(calls.databaseWrites, 0);

    const { calls: ownerCalls, handler: ownerHandler } = harness({
      sessionFromRequest: () => ({ accountId: 'canary-account' }), rateLimit: async () => true,
    });
    const allowed = response();
    await ownerHandler(request({ kind: 'identity_photo' }), allowed);
    assert.equal(allowed.statusCode, 400, 'the owner passed the gate and reached fixture image validation');

    delete process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED;
    const extractionOff = response();
    await ownerHandler(request({ kind: 'identity_photo' }), extractionOff);
    assert.equal(extractionOff.statusCode, 503);
    process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED = 'true';

    delete process.env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID;
    const unpinned = response();
    await ownerHandler(request({ kind: 'identity_photo' }), unpinned);
    assert.equal(unpinned.statusCode, 403);
    assert.equal(ownerCalls.blobWrites, 0);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('upload handler checks the rate limit before parsing the upload payload', async () => {
  let rateLimitCalled = false;
  const { handler } = harness({
    rateLimit: async () => { rateLimitCalled = true; return false; },
  });
  const res = response();
  // A malformed dataUrl would normally fail payload validation with 400 --
  // proving rate limiting still wins confirms the limit check runs first.
  await handler(request({ dataUrl: 'not-a-data-url' }), res);
  assert.equal(rateLimitCalled, true);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'rate_limited');
});

test('upload handler passes the account-scoped hourly key, configured limit, and a one-hour window to rateLimit', async () => {
  let seenArgs;
  const { handler } = harness({
    sessionFromRequest: () => ({ accountId: 'account-scoped-check' }),
    rateLimit: async (args) => { seenArgs = args; return true; },
    uploadHourlyLimit: () => 42,
  });
  await handler(request(), response());
  assert.deepEqual(seenArgs, {
    accountId: 'account-scoped-check',
    key: 'upload:hourly:account-scoped-check',
    limit: 42,
    windowMs: 60 * 60 * 1000,
  });
});

test('uploadHourlyLimit defaults to 60 and honors VIDEO_OS_UPLOAD_HOURLY_LIMIT', async () => {
  const original = process.env.VIDEO_OS_UPLOAD_HOURLY_LIMIT;
  try {
    delete process.env.VIDEO_OS_UPLOAD_HOURLY_LIMIT;
    let seenLimit;
    const defaultHandler = createUploadHandler({
      requestId: () => 'x',
      sessionFromRequest: () => ({ accountId: 'a' }),
      assertDatabaseConfigured: () => true,
      blobToken: () => 't',
      putPrivateBlob: async (_c, pathname) => ({ pathname, etag: 'e' }),
      deletePrivateBlob: async () => ({ deleted: true }),
      getOwnedMediaAsset: async () => null,
      addUploadMediaAsset: async (asset) => asset,
      logUploadPersistenceError: () => {},
      rateLimit: async (args) => { seenLimit = args.limit; return true; },
    });
    await defaultHandler(request(), response());
    assert.equal(seenLimit, 60);

    process.env.VIDEO_OS_UPLOAD_HOURLY_LIMIT = '3';
    const overriddenHandler = createUploadHandler({
      requestId: () => 'x',
      sessionFromRequest: () => ({ accountId: 'a' }),
      assertDatabaseConfigured: () => true,
      blobToken: () => 't',
      putPrivateBlob: async (_c, pathname) => ({ pathname, etag: 'e' }),
      deletePrivateBlob: async () => ({ deleted: true }),
      getOwnedMediaAsset: async () => null,
      addUploadMediaAsset: async (asset) => asset,
      logUploadPersistenceError: () => {},
      rateLimit: async (args) => { seenLimit = args.limit; return true; },
    });
    await overriddenHandler(request(), response());
    assert.equal(seenLimit, 3);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_UPLOAD_HOURLY_LIMIT;
    else process.env.VIDEO_OS_UPLOAD_HOURLY_LIMIT = original;
  }
});

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test(
  'the default export is wired to the real, atomic consumeRateLimit -- a flood of upload requests actually gets cut off',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-upload-rate-${crypto.randomUUID()}`;
    const key = `upload:hourly:${accountId}`;
    t.after(async () => {
      await database().delete(rateLimits).where(eq(rateLimits.key, key)).catch(() => {});
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });
    await ensureAccount({ accountId, email: `${accountId}@example.com`, name: 'Upload Rate Test' });

    const handler = createUploadHandler({
      requestId: () => 'upload-rate-limit-live',
      sessionFromRequest: () => ({ accountId }),
      assertDatabaseConfigured: () => true,
      blobToken: () => 'test-token-never-sent',
      putPrivateBlob: async (_c, pathname) => ({ pathname, etag: 'created-object-etag' }),
      deletePrivateBlob: async () => ({ deleted: true }),
      getOwnedMediaAsset: async () => null,
      addUploadMediaAsset: async (asset) => asset,
      logUploadPersistenceError: () => {},
      uploadHourlyLimit: () => 1,
      // rateLimit is left as the real consumeRateLimit (not overridden).
    });

    const first = response();
    await handler(request(), first);
    assert.equal(first.statusCode, 201);

    const second = response();
    await handler(request({ name: 'second-upload.png' }), second);
    assert.equal(second.statusCode, 429);
    assert.equal(second.body.code, 'rate_limited');
  },
);
