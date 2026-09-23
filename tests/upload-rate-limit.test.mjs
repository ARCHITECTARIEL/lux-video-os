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
