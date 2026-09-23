import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createUploadHandler } from '../api/video-os-lite/uploads.js';
import { assertDatabaseConfigured } from '../db/client.js';
import { classifyDatabaseCommitOutcome } from '../db/repositories.js';

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
    headers: { 'x-request-id': 'upload-correlation-123' },
    body: { name: 'portrait.png', dataUrl: PNG_DATA_URL, ...body },
  };
}

function harness(overrides = {}) {
  const calls = {
    blobWrites: 0,
    blobDeletes: [],
    databaseReads: 0,
    databaseWrites: 0,
    logs: [],
    providers: 0,
  };
  const dependencies = {
    requestId: () => 'upload-correlation-123',
    sessionFromRequest: () => ({ accountId: 'account-one' }),
    assertDatabaseConfigured: () => true,
    // Every existing test in this file predates rate limiting and uses a
    // synthetic accountId that isn't a real DB row -- default to always
    // allowing so those tests keep exercising what they were written to
    // test, not this. See tests/upload-rate-limit.test.mjs for real
    // coverage of the rate-limit path itself.
    rateLimit: async () => true,
    blobToken: () => 'test-token-never-sent',
    putPrivateBlob: async (_classification, pathname) => {
      calls.blobWrites += 1;
      return { pathname, etag: 'created-object-etag' };
    },
    deletePrivateBlob: async (classification, pathname, options) => {
      calls.blobDeletes.push({ classification, pathname, options });
      return { deleted: true };
    },
    getOwnedMediaAsset: async () => {
      calls.databaseReads += 1;
      return null;
    },
    addUploadMediaAsset: async (asset) => {
      calls.databaseWrites += 1;
      return asset;
    },
    logUploadPersistenceError: (entry) => calls.logs.push(entry),
    ...overrides,
  };
  return { calls, handler: createUploadHandler(dependencies) };
}

async function invoke(handler, req = request()) {
  const res = response();
  await handler(req, res);
  return res;
}

test('database configuration gate rejects absent and malformed URLs without opening a connection', (t) => {
  const previous = process.env.DATABASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });

  delete process.env.DATABASE_URL;
  assert.throws(() => assertDatabaseConfigured(), (error) => error.statusCode === 503 && error.failureCategory === 'CONFIG_MISSING' && !error.message.includes('DATABASE_URL'));

  process.env.DATABASE_URL = 'not-a-database-url';
  assert.throws(() => assertDatabaseConfigured(), (error) => error.statusCode === 503 && error.failureCategory === 'CONFIG_MISSING');

  process.env.DATABASE_URL = 'postgresql://local.invalid/video_os';
  assert.equal(assertDatabaseConfigured(), true);
});

test('missing database configuration fails with 503 before Blob or database writes', async () => {
  const { calls, handler } = harness({
    assertDatabaseConfigured: () => {
      throw Object.assign(new Error('Database configuration is unavailable.'), {
        statusCode: 503,
        failureCategory: 'CONFIG_MISSING',
      });
    },
  });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'database_unavailable');
  assert.equal(calls.blobWrites, 0);
  assert.equal(calls.databaseWrites, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /DATABASE_URL|configuration is unavailable|postgres|connection/i);
});

test('database persistence failure deletes only the newly created Blob version', async () => {
  let calls;
  const setup = harness({
    addUploadMediaAsset: async () => {
      setup.calls.databaseWrites += 1;
      throw Object.assign(new Error('database connection detail'), { failureCategory: 'PERSISTENCE', commitOutcome: 'not_committed' });
    },
  });
  ({ calls } = setup);
  const res = await invoke(setup.handler);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'database_unavailable');
  assert.equal(calls.blobWrites, 1);
  assert.equal(calls.databaseWrites, 1);
  assert.equal(calls.blobDeletes.length, 1);
  assert.match(calls.blobDeletes[0].pathname, /^video-os\/uploads\/[^/]+\/portrait-[\w-]+\.png$/);
  assert.equal(calls.blobDeletes[0].options.ifMatch, 'created-object-etag');
  assert.equal(calls.logs[0].cleanup.succeeded, true);
  assert.doesNotMatch(JSON.stringify({ response: res.body, log: calls.logs[0] }), /connection detail|DATABASE_URL|test-token|signed|portrait/i);
});

test('cleanup failure stays sanitized and preserves the original persistence category', async () => {
  const setup = harness({
    addUploadMediaAsset: async () => {
      setup.calls.databaseWrites += 1;
      throw Object.assign(new Error('secret database host'), { failureCategory: 'CONFIG_MISSING', commitOutcome: 'not_committed' });
    },
    deletePrivateBlob: async (classification, pathname, options) => {
      setup.calls.blobDeletes.push({ classification, pathname, options });
      throw new Error('secret Blob token');
    },
  });
  const res = await invoke(setup.handler);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'database_unavailable');
  assert.equal(setup.calls.blobDeletes.length, 1);
  assert.equal(setup.calls.logs[0].correlationId, 'upload-correlation-123');
  assert.equal(setup.calls.logs[0].failureCategory, 'CONFIG_MISSING');
  assert.equal(setup.calls.logs[0].commitOutcome, 'not_committed');
  assert.deepEqual(setup.calls.logs[0].cleanup, { attempted: true, succeeded: false });
  assert.doesNotMatch(JSON.stringify({ response: res.body, log: setup.calls.logs[0] }), /secret|host|token|DATABASE_URL/i);
});

test('successful upload creates one private Blob and one owned media asset', async () => {
  let persisted;
  const setup = harness({
    addUploadMediaAsset: async (asset) => {
      setup.calls.databaseWrites += 1;
      persisted = asset;
      return asset;
    },
  });
  const res = await invoke(setup.handler);
  assert.equal(res.statusCode, 201);
  assert.equal(setup.calls.blobWrites, 1);
  assert.equal(setup.calls.databaseWrites, 1);
  assert.equal(setup.calls.blobDeletes.length, 0);
  assert.equal(persisted.accountId, 'account-one');
  assert.equal(persisted.privatePathname, res.body.pathname);
  assert.equal(res.body.url, null);
  assert.equal(res.body.providerUrl, null);
});

test('confirmed commit recovery returns the owned media record without deleting Blob', async () => {
  let attempted;
  let reads = 0;
  const setup = harness({
    getOwnedMediaAsset: async () => {
      setup.calls.databaseReads += 1;
      reads += 1;
      return reads === 1 ? null : attempted;
    },
    addUploadMediaAsset: async (asset) => {
      setup.calls.databaseWrites += 1;
      attempted = asset;
      throw Object.assign(new Error('connection closed after commit'), { failureCategory: 'PERSISTENCE', commitOutcome: 'unknown' });
    },
  });
  const res = await invoke(setup.handler);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.recovered, true);
  assert.equal(res.body.assetId, attempted.id);
  assert.equal(setup.calls.blobDeletes.length, 0);
  assert.equal(setup.calls.logs.length, 0);
});

test('unknown commit outcome retains Blob and emits only reconciliation metadata', async () => {
  const setup = harness({
    addUploadMediaAsset: async () => {
      setup.calls.databaseWrites += 1;
      throw Object.assign(new Error('private database endpoint'), { failureCategory: 'PERSISTENCE', commitOutcome: 'unknown' });
    },
  });
  const res = await invoke(setup.handler);
  assert.equal(res.statusCode, 503);
  assert.equal(setup.calls.blobDeletes.length, 0);
  assert.equal(setup.calls.logs.length, 1);
  assert.deepEqual(Object.keys(setup.calls.logs[0]).sort(), [
    'accountRef',
    'commitOutcome',
    'correlationId',
    'failureCategory',
    'mediaAssetId',
    'objectPathHash',
  ]);
  assert.equal(setup.calls.logs[0].commitOutcome, 'unknown');
  assert.match(setup.calls.logs[0].objectPathHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify({ response: res.body, log: setup.calls.logs[0] }), /private database|DATABASE_URL|test-token|signed|portrait/i);
});

test('retry with the same correlation ID reuses the owned row without duplicate writes', async () => {
  let stored = null;
  const setup = harness({
    getOwnedMediaAsset: async () => {
      setup.calls.databaseReads += 1;
      return stored;
    },
    addUploadMediaAsset: async (asset) => {
      setup.calls.databaseWrites += 1;
      stored = asset;
      return asset;
    },
  });
  const first = await invoke(setup.handler);
  const retry = await invoke(setup.handler);
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.assetId, first.body.assetId);
  assert.equal(setup.calls.blobWrites, 1);
  assert.equal(setup.calls.databaseWrites, 1);
  assert.equal(setup.calls.blobDeletes.length, 0);
});

test('shipped client pins one request ID across retryable upload failures', () => {
  const client = readFileSync(new URL('../public/lite.js', import.meta.url), 'utf8');
  const start = client.indexOf('async function uploadAvatarSource(type)');
  const end = client.indexOf('function setRecoveryAction', start);
  const upload = client.slice(start, end);
  assert.match(upload, /appState\.uploadOperations\[type\] = operation/);
  assert.match(upload, /'x-request-id': operation\.requestId/);
  assert.match(upload, /if \(!error\?\.retryable\) delete appState\.uploadOperations\[type\]/);
});

test('same request ID with changed upload input fails closed without another Blob write', async () => {
  let stored = null;
  const setup = harness({
    getOwnedMediaAsset: async () => {
      setup.calls.databaseReads += 1;
      return stored;
    },
    addUploadMediaAsset: async (asset) => {
      setup.calls.databaseWrites += 1;
      stored = asset;
      return asset;
    },
  });
  const first = await invoke(setup.handler);
  const conflict = await invoke(setup.handler, request({ name: 'different.png' }));
  assert.equal(first.statusCode, 201);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'upload_conflict');
  assert.equal(setup.calls.blobWrites, 1);
  assert.equal(setup.calls.databaseWrites, 1);
  assert.equal(setup.calls.blobDeletes.length, 0);
});

test('database error classification proves non-commit only for statement rejection classes', () => {
  assert.equal(classifyDatabaseCommitOutcome({ code: '23505' }), 'not_committed');
  assert.equal(classifyDatabaseCommitOutcome({ code: '40001' }), 'not_committed');
  assert.equal(classifyDatabaseCommitOutcome({ code: 'ECONNRESET' }), 'unknown');
  assert.equal(classifyDatabaseCommitOutcome(new Error('timeout')), 'unknown');
});

test('anonymous and cross-account denials happen before Blob or database activity', async (t) => {
  for (const denied of [
    Object.assign(new Error('Sign in.'), { statusCode: 401 }),
    Object.assign(new Error('Wrong account.'), { statusCode: 403 }),
  ]) {
    await t.test(String(denied.statusCode), async () => {
      const { calls, handler } = harness({ sessionFromRequest: () => { throw denied; } });
      const res = await invoke(handler);
      assert.equal(res.statusCode, denied.statusCode);
      assert.equal(calls.blobWrites, 0);
      assert.equal(calls.databaseWrites, 0);
      assert.equal(calls.providers, 0);
    });
  }
});

test('anonymous malformed requests are denied before request-body parsing or external activity', async () => {
  const { calls, handler } = harness({
    sessionFromRequest: () => { throw Object.assign(new Error('Sign in.'), { statusCode: 401 }); },
  });
  const res = await invoke(handler, { method: 'POST', headers: {}, body: '{configured-secret:' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'authentication_required');
  assert.doesNotMatch(JSON.stringify(res.body), /configured-secret/);
  assert.equal(calls.blobWrites, 0);
  assert.equal(calls.databaseWrites, 0);
});

test('spoofed media is rejected before all external writes', async () => {
  const { calls, handler } = harness();
  const spoofed = `data:image/png;base64,${Buffer.from('not-a-png').toString('base64')}`;
  const res = await invoke(handler, request({ dataUrl: spoofed }));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_upload');
  assert.equal(calls.blobWrites, 0);
  assert.equal(calls.databaseWrites, 0);
  assert.equal(calls.providers, 0);
});
