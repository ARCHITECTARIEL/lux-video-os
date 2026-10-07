import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import talentHandler, { assertTalentSelectionsAvailable, buildFeaturedAvatars, buildSharedAvatars, buildVoices, loadTalentInventory, normalizeTalentItem } from '../api/video-os/talent.js';
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

test('talent discovery uses persisted Premium grants and preserves inventory privacy', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/talent-authorization-scenario.mjs'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
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
  assert.deepEqual(featured.slice(0, 3).map((item) => item.id), ['featured:ariel', 'featured:oso', 'featured:kd']);
  assert.deepEqual(featured.slice(0, 3).map((item) => item.providerReady), [true, false, true]);

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

test('persisted render input stays namespaced instead of embedding unverified inventory provider IDs', async () => {
  const renderSource = await readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  assert.match(renderSource, /let authorizedInput = payload/);
  assert.match(renderSource, /input: authorizedInput/);
  assert.doesNotMatch(renderSource, /input: providerPayload|resolveFeaturedProviderSelections/);
  // Submission now requires a canonical owned-identity claim; provider
  // submission boundaries have their own runtime wiring regression suite.
});

test('private featured looks require exact accepted group consent before selection', async (t) => {
  withInventoryEnvironment(t);
  const pending = FEATURED_CAST[0];
  const accepted = FEATURED_CAST[2];
  const unsupported = FEATURED_CAST[3];
  const unusable = FEATURED_CAST[4];
  const groupReads = [];
  const fetchImpl = async (url) => {
    if (url.includes('ownership=private')) return response({ data: [
      { id: pending.avatarId, group_id: 'group-pending', avatar_type: 'digital_twin', status: 'completed', preview_image_url: 'https://media.example/pending.jpg' },
      { id: accepted.avatarId, group_id: 'group-accepted', avatar_type: 'digital_twin', status: 'completed', preview_image_url: 'https://media.example/accepted.jpg' },
      { id: unsupported.avatarId, group_id: 'group-null', avatar_type: 'prompt_avatar', status: 'completed', preview_image_url: 'https://media.example/unknown.jpg' },
      { id: unusable.avatarId, group_id: 'group-unusable', avatar_type: 'digital_twin', status: 'completed' },
    ] });
    if (url.includes('ownership=public')) return response({ data: [] });
    if (url.includes('/voices')) return response({ data: [{ voice_id: accepted.voiceId, status: 'active' }] });
    if (url.endsWith('/group-pending') || url.endsWith('/group-accepted') || url.endsWith('/group-null')) {
      groupReads.push(url);
      return response({ data: { id: url.split('/').pop(), status: 'completed', consent_status: url.endsWith('/group-pending') ? 'pending' : url.endsWith('/group-null') ? null : 'accepted' } });
    }
    throw new Error('Unexpected provider inventory request');
  };
  const { talent } = await loadTalentInventory({ fetchImpl });
  assert.equal(talent.avatars.find((item) => item.id === 'featured:' + pending.key).providerReady, false);
  assert.equal(talent.avatars.find((item) => item.id === 'featured:' + accepted.key).providerReady, true);
  assert.equal(talent.avatars.find((item) => item.id === 'featured:' + unsupported.key).providerReady, false, 'prompt avatar has no qualified LUX consent path');
  assert.equal(talent.avatars.find((item) => item.id === 'featured:oso').providerReady, false, 'missing private look cannot use local fallback as live readiness');
  assert.equal(talent.voices.find((item) => item.id === 'featured:' + pending.key + ':voice').providerReady, false, 'missing private voice cannot use local fallback as live readiness');
  assert.equal(groupReads.length, 3);
  assert.equal(talent.avatars.find((item) => item.id === 'featured:' + unusable.key).providerReady, false);
  const unavailable = await loadTalentInventory({ fetchImpl: async (url) => url.includes('/v3/avatars/group-') ? response({}, 503) : fetchImpl(url) });
  assert.equal(unavailable.talent.avatars.find((item) => item.id === 'featured:' + accepted.key).providerReady, false);
  assert.equal(unavailable.connection.status, 'degraded');
});

test('unconfigured provider cannot present curated private avatars as ready', async (t) => {
  withInventoryEnvironment(t);
  delete process.env.HEYGEN_API_KEY;
  const inventory = await loadTalentInventory();
  assert.equal(inventory.connection.connected, false);
  assert.ok(inventory.talent.avatars.every((item) => item.providerReady === false));
});
