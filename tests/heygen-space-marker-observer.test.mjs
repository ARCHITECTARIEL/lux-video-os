import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { readHeygenSpaceMarkerAsset } from '../services/heygen-space-marker.js';

const API_KEY = 'marker-observer-secret';
const ASSET_ID = 'asset_marker_1';
const NOW = '2026-10-19T12:00:00.000Z';

function marker(overrides = {}) {
  return {
    id: ASSET_ID,
    owner: 'owner_marker_1',
    space_id: 'space_marker_1',
    type: 'image',
    uploaded_at: 1_760_790_855,
    private_url: 'https://private.invalid/must-not-return',
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function read(fetchImpl, overrides = {}) {
  return readHeygenSpaceMarkerAsset({ apiKey: API_KEY, assetId: ASSET_ID, now: NOW, fetchImpl, ...overrides });
}

test('returns only normalized private marker fields through the fixed read-only request', async () => {
  const requests = [];
  const result = await read(async (url, request) => {
    requests.push({ url, request });
    return jsonResponse(200, { data: marker() });
  });
  assert.deepEqual(result, {
    id: ASSET_ID,
    owner: 'owner_marker_1',
    spaceId: 'space_marker_1',
    type: 'image',
    uploadedAt: 1_760_790_855,
    observedAt: NOW,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes('private_url'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.heygen.com/v3/assets/${ASSET_ID}`);
  assert.equal(requests[0].request.method, 'GET');
  assert.equal(requests[0].request.redirect, 'error');
  assert.deepEqual(requests[0].request.headers, { Accept: 'application/json', 'X-Api-Key': API_KEY });
  assert.equal('body' in requests[0].request, false);
  assert.ok(requests[0].request.signal instanceof AbortSignal);
});

test('rejects a response for a different asset ID', async () => {
  await assert.rejects(read(async () => jsonResponse(200, { data: marker({ id: 'asset_other' }) })), { code: 'HEYGEN_SPACE_MARKER_ID_MISMATCH' });
});

test('rejects malformed owner, space, type, and upload time fields', async () => {
  for (const overrides of [
    { owner: '' }, { space_id: '' }, { type: '' }, { type: 'Image File' },
    { uploaded_at: '1760790855' }, { uploaded_at: 0 }, { uploaded_at: 1.5 },
  ]) {
    await assert.rejects(read(async () => jsonResponse(200, { data: marker(overrides) })), { code: 'HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE' });
  }
});

for (const [status, code] of [
  [401, 'HEYGEN_SPACE_MARKER_AUTHORIZATION_FAILURE'], [403, 'HEYGEN_SPACE_MARKER_AUTHORIZATION_FAILURE'],
  [404, 'HEYGEN_SPACE_MARKER_NOT_FOUND'], [429, 'HEYGEN_SPACE_MARKER_RATE_LIMITED'],
  [500, 'HEYGEN_SPACE_MARKER_PROVIDER_FAILURE'], [503, 'HEYGEN_SPACE_MARKER_PROVIDER_FAILURE'],
]) {
  test(`classifies provider HTTP ${status}`, async () => {
    await assert.rejects(read(async () => jsonResponse(status, { error: { code: 'provider_error' } })), {
      code, providerHttpStatus: status, method: 'GET', pathTemplate: '/v3/assets/{asset_id}',
    });
  });
}

test('rejects malformed and oversized response bodies', async () => {
  await assert.rejects(read(async () => new Response('{', { status: 200 })), { code: 'HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE' });
  await assert.rejects(read(async () => new Response('x'.repeat((128 * 1024) + 1), { status: 200 })), { code: 'HEYGEN_SPACE_MARKER_RESPONSE_TOO_LARGE' });
});

test('classifies timeout and makes no retry', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let calls = 0;
  globalThis.setTimeout = callback => { queueMicrotask(callback); return 1; };
  globalThis.clearTimeout = () => {};
  try {
    await assert.rejects(read((_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    }), { code: 'HEYGEN_SPACE_MARKER_TIMEOUT' });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(calls, 1);
});

test('redirect response is rejected and never followed or retried', async () => {
  let calls = 0;
  await assert.rejects(read(async (_url, request) => {
    calls += 1;
    assert.equal(request.redirect, 'error');
    return jsonResponse(302, { error: { code: 'redirect' } });
  }), { code: 'HEYGEN_SPACE_MARKER_REJECTED', providerHttpStatus: 302 });
  assert.equal(calls, 1);
});

test('transport and clock injection are unavailable outside the Node test runner', () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const script = `
    import { readHeygenSpaceMarkerAsset } from './services/heygen-space-marker.js';
    try {
      await readHeygenSpaceMarkerAsset({
        apiKey: 'test-only', assetId: 'asset', now: '2026-10-19T12:00:00Z',
        fetchImpl: async () => new Response('{}'),
      });
      console.log('UNEXPECTED_SUCCESS');
    } catch (error) { console.log(error.code); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: environment, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), 'INVALID_HEYGEN_SPACE_MARKER_OPTIONS');
  assert.equal(child.stderr, '');
});
