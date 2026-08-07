import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { makeSession } from '../lib/video-os-account.js';
import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import talentHandler, { assertTalentSelectionsAvailable, buildFeaturedAvatars, buildSharedAvatars, buildVoices, normalizeTalentItem } from '../api/video-os/talent.js';
import { fetchHeygenPaginatedCollection } from '../services/heygen.js';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

async function invoke(headers = {}) {
  let body;
  let status;
  const res = {
    setHeader() {},
    end(value) { body = JSON.parse(value); },
    set statusCode(value) { status = value; },
    get statusCode() { return status; },
  };
  await talentHandler({ method: 'GET', headers }, res);
  return { status, body };
}

function withInventoryEnvironment(t) {
  const names = ['HEYGEN_API_KEY', 'HEYGEN_TOKEN', 'VIDEO_OS_SESSION_SECRET', 'VIDEO_OS_RENDER_ACCOUNT_ID'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name];
  });
  process.env.VIDEO_OS_SESSION_SECRET = 'unit-test-session-secret';
  process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'authorized-account';
  process.env.HEYGEN_API_KEY = 'unit-test-provider-key';
  delete process.env.HEYGEN_TOKEN;
}

test('anonymous inventory returns 401 before any provider request', async (t) => {
  withInventoryEnvironment(t);
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('unexpected provider request'); };
  const result = await invoke();
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'authentication_required');
  assert.equal(fetches, 0);
  assert.equal(JSON.stringify(result.body).includes('previewUrl'), false);
});

test('cross-account inventory returns 403 before any provider request', async (t) => {
  withInventoryEnvironment(t);
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('unexpected provider request'); };
  const token = makeSession('different-account', 'different@example.test');
  const result = await invoke({ cookie: `vos_session=${encodeURIComponent(token)}` });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'talent_forbidden');
  assert.equal(fetches, 0);
});

test('authorized inventory is UI-bounded and suppresses provider mappings and private counts', async (t) => {
  withInventoryEnvironment(t);
  const providerRequests = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    providerRequests.push(value);
    if (value.includes('ownership=private')) {
      return response({ data: FEATURED_CAST.map((item) => ({ id: item.avatarId, name: item.label, status: 'completed', preview_image_url: `https://media.example/${item.key}.jpg` })), has_more: false });
    }
    if (value.includes('ownership=public')) {
      return response({ data: Array.from({ length: 30 }, (_, index) => ({ id: `shared-${index}`, name: `Shared ${index}`, status: 'completed', preview_image_url: `https://media.example/shared-${index}.jpg`, supported_api_engines: ['avatar_iv'] })), has_more: false });
    }
    return response({ data: { voices: FEATURED_CAST.map((item) => ({ voice_id: item.voiceId, voice_name: item.label, status: 'active' })) } });
  };
  const token = makeSession('authorized-account', 'owner@example.test');
  const result = await invoke({ cookie: `vos_session=${encodeURIComponent(token)}` });
  const serialized = JSON.stringify(result.body);

  assert.equal(result.status, 200);
  assert.equal(result.body.talent.avatars.length, 20);
  assert.deepEqual(result.body.talent.avatars.slice(0, 3).map((item) => item.id), ['featured:ariel', 'featured:oso', 'featured:kd']);
  assert.equal('privateLookCount' in result.body.connection, false);
  assert.equal('privateLooksPages' in (result.body.connection.pagination || {}), false);
  for (const item of FEATURED_CAST) {
    assert.equal(serialized.includes(item.avatarId), false, 'response must suppress a configured avatar identifier');
    assert.equal(serialized.includes(item.voiceId), false, 'response must suppress a configured voice identifier');
  }
  assert(providerRequests.every((url) => {
    const normalizedUrl = url.toLowerCase();
    return !normalizedUrl.includes('video/generate')
      && !normalizedUrl.includes('video/create')
      && !normalizedUrl.endsWith('/v2/video');
  }), 'inventory must never submit a video job');
});

test('shared inventory pagination deduplicates, rejects repeated cursors, and validates origin', async (t) => {
  withInventoryEnvironment(t);
  let page = 0;
  const result = await fetchHeygenPaginatedCollection('https://api.heygen.com/v3/avatars/looks?limit=50', {
    fetchImpl: async () => response(page++ === 0
      ? { data: [{ id: 'one' }, { id: 'duplicate' }], has_more: true, next_token: 'next' }
      : { data: [{ id: 'duplicate' }, { id: 'two' }], has_more: false }),
  });
  assert.deepEqual(result.items.map((item) => item.id), ['one', 'duplicate', 'two']);

  await assert.rejects(fetchHeygenPaginatedCollection('https://api.heygen.com/v3/avatars/looks?limit=50', {
    fetchImpl: async () => response({ data: [], has_more: true, next_token: 'same' }),
    maxPages: 4,
  }), /repeated pagination token/i);

  let alternateOriginFetches = 0;
  await assert.rejects(fetchHeygenPaginatedCollection('https://example.test/v3/avatars', {
    fetchImpl: async () => { alternateOriginFetches += 1; return response({}); },
  }), /provider API origin/i);
  assert.equal(alternateOriginFetches, 0);
});

test('public provider inventory is intentionally capped to one page', async (t) => {
  withInventoryEnvironment(t);
  const result = await fetchHeygenPaginatedCollection('https://api.heygen.com/v3/avatars/looks?ownership=public&limit=50', {
    fetchImpl: async () => response({ data: [{ id: 'one' }, { id: 'two' }], has_more: true, next_token: 'page-2' }),
    maxPages: 1,
    maxItems: 2,
    allowTruncatedPageLimit: true,
  });
  assert.deepEqual(result.items.map((item) => item.id), ['one', 'two']);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('provider preview normalization drops URL credentials, queries, and fragments', () => {
  const safe = normalizeTalentItem({ id: 'shared-safe', preview_image_url: 'https://media.example/avatar.jpg?token=private#frame' }, 'avatar');
  assert.equal(safe.previewUrl, 'https://media.example/avatar.jpg');
  const credentialed = normalizeTalentItem({ id: 'shared-unsafe', preview_image_url: 'https://user:password@media.example/avatar.jpg' }, 'avatar');
  assert.equal('previewUrl' in credentialed, false);
});

test('featured aliases use exact provider matches and shared looks remain filtered', () => {
  const featured = buildFeaturedAvatars([
    { id: FEATURED_CAST[0].avatarId, status: 'completed', preview_image_url: 'https://media.example/ariel.jpg' },
    { id: 'not-oso', name: 'OSO', status: 'completed', preview_image_url: 'https://media.example/not-oso.jpg' },
    { id: FEATURED_CAST[2].avatarId, status: 'completed', preview_image_url: 'https://media.example/kd.jpg' },
  ]);
  assert.deepEqual(featured.map((item) => item.id), ['featured:ariel', 'featured:oso', 'featured:kd']);
  assert.deepEqual(featured.map((item) => item.providerReady), [true, false, true]);

  const shared = buildSharedAvatars([
    { id: 'provider-avatar-one-private', status: 'completed', preview_image_url: 'https://media.example/a.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'provider-avatar-one-private', status: 'completed', preview_image_url: 'https://media.example/duplicate.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'blocked', status: 'failed', preview_image_url: 'https://media.example/blocked.jpg', supported_api_engines: ['avatar_iv'] },
    { id: 'unsupported', status: 'completed', preview_image_url: 'https://media.example/unsupported.jpg', supported_api_engines: [] },
    { id: 'provider-avatar-two-private', status: 'completed', preview_image_url: 'https://media.example/b.jpg', supported_api_engines: ['avatar_iv'] },
  ]);
  assert.equal(shared.length, 2);
  assert(shared.every((item) => /^shared:avatar:[A-Za-z0-9_-]{32}$/.test(item.id)));
  assert.equal(JSON.stringify(shared).includes('provider-avatar-one-private'), false);
  assert.equal(JSON.stringify(shared).includes('provider-avatar-two-private'), false);
});

test('server availability rejects unavailable, mismatched, duplicate-name, and raw configured selections', () => {
  const featured = FEATURED_CAST[2];
  const safeAvatar = buildFeaturedAvatars([{ id: featured.avatarId, name: featured.label, status: 'completed', preview_image_url: 'https://media.example/kd.jpg' }])[2];
  const voices = buildVoices([
    { voice_id: featured.voiceId, voice_name: featured.label, status: 'active' },
    { voice_id: 'duplicate-name', voice_name: featured.label, status: 'active' },
  ]);
  const safeVoice = voices.find((item) => item.featuredKey === featured.key);
  const duplicateVoice = voices.find((item) => item.featuredKey !== featured.key);
  const talent = { avatars: [safeAvatar], voices };

  const available = assertTalentSelectionsAvailable(talent, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: safeVoice.id } });
  assert.equal(available.avatar, safeAvatar);
  assert.equal(available.voice, safeVoice);
  assert.deepEqual(available.providerSelections, { avatarId: featured.avatarId, voiceId: featured.voiceId });
  assert.throws(() => assertTalentSelectionsAvailable(talent, { avatar: { avatarId: featured.avatarId }, voice: { voiceId: featured.voiceId } }), /unavailable/i);
  assert.throws(() => assertTalentSelectionsAvailable(talent, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: duplicateVoice.id } }), /exact matched voice/i);
  assert.throws(() => assertTalentSelectionsAvailable({ ...talent, avatars: [{ ...safeAvatar, providerReady: false }] }, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: safeVoice.id } }), /unavailable/i);
});

test('persisted render input stays namespaced while workflow resolves only at submission time', async () => {
  const renderSource = await readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  const workflowSource = await readFile(new URL('../workflows/video-render.js', import.meta.url), 'utf8');
  assert.match(renderSource, /let authorizedInput = payload/);
  assert.match(renderSource, /input: authorizedInput/);
  assert.doesNotMatch(renderSource, /input: providerPayload|resolveFeaturedProviderSelections/);
  assert.match(workflowSource, /requireRenderAccountAuthorization\(job\.accountId\)/);
  assert.match(workflowSource, /providerSelections/);
  assert.match(workflowSource, /submitHeygen\(\{ \.\.\.job, input: submissionInput \}\)/);
});
