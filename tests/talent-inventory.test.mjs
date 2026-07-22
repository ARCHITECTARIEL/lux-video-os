import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { makeSession } from '../lib/video-os-account.js';
import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import talentHandler, { assertTalentSelectionsAvailable, fetchPaginatedCollection } from '../api/video-os/talent.js';

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
  assert.equal('privateLookCount' in result.body.connection, false);
  assert.equal('privateLooksPages' in (result.body.connection.pagination || {}), false);
  for (const item of FEATURED_CAST) {
    assert.equal(serialized.includes(item.avatarId), false, 'response must suppress a configured avatar identifier');
    assert.equal(serialized.includes(item.voiceId), false, 'response must suppress a configured voice identifier');
  }
  assert(providerRequests.every((url) => !/video\/generate|video\/create|\/v2\/video$/i.test(url)), 'inventory must never submit a video job');
});

test('pagination deduplicates and fails closed on repeated cursors', async () => {
  let page = 0;
  const result = await fetchPaginatedCollection('https://api.example.test/looks?limit=50', 'test-key', {
    fetchImpl: async () => response(page++ === 0
      ? { data: [{ id: 'one' }, { id: 'duplicate' }], has_more: true, next_token: 'next' }
      : { data: [{ id: 'duplicate' }, { id: 'two' }], has_more: false }),
  });
  assert.deepEqual(result.items.map((item) => item.id), ['one', 'duplicate', 'two']);

  await assert.rejects(fetchPaginatedCollection('https://api.example.test/looks?limit=50', 'test-key', {
    fetchImpl: async () => response({ data: [], has_more: true, next_token: 'same' }),
    maxPages: 4,
  }), /repeated pagination token/i);
});


test('server availability rejects unavailable, mismatched, duplicate-name, and raw configured selections', () => {
  const featured = FEATURED_CAST[2];
  const safeAvatar = { id: `featured:${featured.key}`, name: featured.label, featuredKey: featured.key, matchedVoiceId: `featured:${featured.key}:voice`, providerReady: true, active: true };
  const safeVoice = { id: `featured:${featured.key}:voice`, name: `${featured.label} voice`, featuredKey: featured.key, providerReady: true, active: true };
  const talent = {
    avatars: [safeAvatar, { id: 'shared-safe', name: featured.label, providerReady: true, active: true }],
    voices: [safeVoice, { id: 'duplicate-name', name: `${featured.label} voice`, providerReady: true, active: true }],
  };

  assert.deepEqual(assertTalentSelectionsAvailable(talent, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: safeVoice.id } }), { avatar: safeAvatar, voice: safeVoice });
  assert.throws(() => assertTalentSelectionsAvailable(talent, { avatar: { avatarId: featured.avatarId }, voice: { voiceId: featured.voiceId } }), /unavailable/i);
  assert.throws(() => assertTalentSelectionsAvailable(talent, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: 'duplicate-name' } }), /exact matched voice/i);
  assert.throws(() => assertTalentSelectionsAvailable({ ...talent, avatars: [{ ...safeAvatar, providerReady: false }] }, { avatar: { avatarId: safeAvatar.id }, voice: { voiceId: safeVoice.id } }), /unavailable/i);
});

test('persisted render input stays namespaced while workflow resolves only at submission time', async () => {
  const renderSource = await readFile(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  const workflowSource = await readFile(new URL('../workflows/video-render.js', import.meta.url), 'utf8');
  assert.match(renderSource, /input: payload/);
  assert.doesNotMatch(renderSource, /input: providerPayload|resolveFeaturedProviderSelections/);
  assert.match(workflowSource, /submitHeygen\(\{ \.\.\.job, input: resolveFeaturedProviderSelections\(job\.input\) \}\)/);
});
