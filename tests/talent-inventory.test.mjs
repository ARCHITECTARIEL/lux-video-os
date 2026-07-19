import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFeaturedAvatars,
  buildSharedAvatars,
  fetchPaginatedCollection,
} from '../api/video-os/talent.js';
import talentHandler from '../api/video-os/talent.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('HeyGen v3 pagination retrieves every page once, deduplicates, and preserves order', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? response({ data: [{ id: 'look-a' }, { id: 'look-duplicate' }], has_more: true, next_token: 'page-2' })
      : response({ data: [{ id: 'look-duplicate' }, { id: 'look-b' }], has_more: false, next_token: null });
  };

  const result = await fetchPaginatedCollection(
    'https://api.heygen.com/v3/avatars/looks?ownership=private&limit=50',
    'secret',
    { fetchImpl, maxPages: 4 },
  );

  assert.deepEqual(result.items.map((item) => item.id), ['look-a', 'look-duplicate', 'look-b']);
  assert.equal(result.pages, 2);
  assert.equal(new URL(urls[1]).searchParams.get('token'), 'page-2');
  assert.equal(new URL(urls[1]).searchParams.get('ownership'), 'private');
});

test('HeyGen v3 pagination fails closed on a repeated cursor', async () => {
  const fetchImpl = async () => response({ data: [], has_more: true, next_token: 'same-token' });
  await assert.rejects(
    fetchPaginatedCollection('https://api.heygen.com/v3/avatars/looks?limit=50', 'secret', { fetchImpl, maxPages: 4 }),
    /repeated pagination token/i,
  );
});

test('featured presenters are matched only by exact renderable look ID', () => {
  const [ariel, oso, kd] = buildFeaturedAvatars([
    { id: 'ddd0cccc81334e50b493a12c34fb47b1', name: 'Wrong display name', status: 'completed', preview_image_url: 'https://files.heygen.ai/ariel.jpg' },
    { id: 'not-oso', name: 'OSO', status: 'completed', preview_image_url: 'https://files.heygen.ai/not-oso.jpg' },
    { id: '880ad1223ca84f9590f21a0df4bf66b2', name: 'KD', status: 'completed', preview_image_url: 'https://files.heygen.ai/kd.jpg' },
  ]);

  assert.equal(ariel.providerReady, true);
  assert.equal(oso.providerReady, false);
  assert.equal(kd.providerReady, true);
});

test('shared looks stay stable, unique, active, and API-compatible', () => {
  const items = buildSharedAvatars([
    { id: 'one', status: 'completed', preview_image_url: 'https://files.heygen.ai/one.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'one', status: 'completed', preview_image_url: 'https://files.heygen.ai/duplicate.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'blocked', status: 'failed', preview_image_url: 'https://files.heygen.ai/blocked.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'unsupported', status: 'completed', preview_image_url: 'https://files.heygen.ai/no-engine.jpg', supported_api_engines: [] },
    { id: 'two', status: 'completed', preview_image_url: 'https://files.heygen.ai/two.jpg', supported_api_engines: ['avatar_iv'] },
  ]);

  assert.deepEqual(items.map((item) => item.id), ['one', 'two']);
});

test('talent handler uses paginated private and public v3 looks', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HEYGEN_API_KEY;
  t.after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.HEYGEN_API_KEY; else process.env.HEYGEN_API_KEY = originalKey; });
  process.env.HEYGEN_API_KEY = 'secret';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('ownership=private')) return response({ data: [
      { id: 'ddd0cccc81334e50b493a12c34fb47b1', status: 'completed', preview_image_url: 'https://files.heygen.ai/ariel.jpg' },
      { id: 'e8083119a1024dd0814b6ba7e9addfc4', status: 'completed', preview_image_url: 'https://files.heygen.ai/oso.jpg' },
      { id: '880ad1223ca84f9590f21a0df4bf66b2', status: 'completed', preview_image_url: 'https://files.heygen.ai/kd.jpg' },
    ], has_more: false, next_token: null });
    if (String(url).includes('ownership=public')) return response({ data: [{ id: 'shared', status: 'completed', preview_image_url: 'https://files.heygen.ai/shared.jpg', supported_api_engines: ['avatar_iv'] }], has_more: false, next_token: null });
    return response({ data: { voices: [{ voice_id: 'voice', status: 'active' }] } });
  };
  let body;
  const res = { setHeader() {}, end(value) { body = JSON.parse(value); } };
  await talentHandler({ method: 'GET' }, res);
  assert.equal(body.connection.featuredReady, 3);
  assert.equal(body.connection.privateLookCount, 3);
  assert.deepEqual(body.connection.pagination, { privateLooksPages: 1, publicLooksPages: 1 });
  assert(urls.some((url) => url.includes('/v3/avatars/looks?ownership=private&limit=50')));
  assert(urls.some((url) => url.includes('/v3/avatars/looks?ownership=public&limit=50')));
});
