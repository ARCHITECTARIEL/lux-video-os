import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { makeSession } from '../../lib/video-os-account.js';
import { FEATURED_CAST } from '../../lib/video-os-featured-cast.js';
import * as schema from '../../db/schema.js';
let grants = [];
const user = { id: 'authorized-account', email: 'owner@example.test' };
let databaseFailure = false;
const db = { select() {
  if (databaseFailure) throw new Error('private connection failure');
  let table;
  return { from(value) { table = value; return this; }, where() { return this; }, for() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(table === schema.entitlements ? grants : [user]).then(resolve, reject); } };
} };
mock.module('../../db/client.js', { namedExports: { database: () => db } });
const { default: talentHandler } = await import('../../api/video-os/talent.js');
const { requirePersistedRenderAuthorization } = await import('../../db/repositories.js');
function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return payload; } }; }
async function invoke(headers = {}) {
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await talentHandler({ method: 'GET', headers }, res);
  return { status: res.statusCode, body: res.body };
}
process.env.VIDEO_OS_SESSION_SECRET = 'unit-test-session-secret';
process.env.HEYGEN_API_KEY = 'unit-test-provider-key';
process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'unrelated-configured-account';
const grant = { accountId: user.id, entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant' };
const token = makeSession(user.id, user.email);
const headers = { cookie: `vos_session=${encodeURIComponent(token)}` };
let fetches = 0;
globalThis.fetch = async () => { fetches++; return response({ data: [] }); };
grants = [grant];
assert.equal((await invoke(headers)).status, 200, 'persisted admin grant must work in a cold process despite config allowlist');
assert.equal((await requirePersistedRenderAuthorization(user.id, 'premium')).tier, 'premium');
for (const configured of ['unrelated-configured-account', '']) {
  process.env.VIDEO_OS_RENDER_ACCOUNT_ID = configured;
  for (const invalid of [{ entitlementKey: 'standardRendering' }, { enabled: false }, { expiresAt: '2000-01-01' }, { expiresAt: 'invalid' }, { accountId: 'other' }]) {
    grants = [{ ...grant, ...invalid }]; fetches = 0;
    const result = await invoke(headers);
    assert.equal(result.status, 403, JSON.stringify(invalid));
    assert.equal(result.body.code, 'talent_forbidden');
    assert.equal(fetches, 0);
    await assert.rejects(requirePersistedRenderAuthorization(user.id, 'premium'), { statusCode: 403 });
  }
}
// A matching configured identity cannot bypass persisted revocation.
process.env.VIDEO_OS_RENDER_ACCOUNT_ID = user.id;
grants = [{ ...grant, enabled: false }];
assert.equal((await invoke(headers)).status, 403);
// Infrastructure failure must fail closed, not masquerade as a lost session.
databaseFailure = true; fetches = 0;
const unavailable = await invoke(headers);
assert.equal(unavailable.status, 503);
assert.equal(JSON.stringify(unavailable.body).includes('private connection failure'), false);
assert.equal(fetches, 0);
databaseFailure = false; grants = [grant];
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

