import assert from 'node:assert/strict';
import test from 'node:test';

import renderHandler, { authorizedIdentityInput } from '../api/video-os-lite/render-v2.js';


function request(body, headers = {}) {
  return {
    method: 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}


function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}


test('anonymous render requests are rejected before provider payload validation', async () => {
  const res = response();

  await renderHandler(request({}), res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'Sign in to render videos.');
});

test('owned ready identity replaces all browser provider resource identifiers', () => {
  const identityId = crypto.randomUUID();
  const payload = { identityId, avatar: { avatarId: 'forged-avatar' } };
  const identity = { id: identityId, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', providerRenderableAvatarId: 'owned-avatar', providerVoiceId: 'owned-voice', archivedAt: null };
  const authorized = authorizedIdentityInput({ identityId }, payload, identity);
  assert.deepEqual(authorized.avatar, { avatarId: 'owned-avatar' });
  assert.deepEqual(authorized.voice, { voiceId: 'owned-voice' });
});

test('owned identity keeps an explicit saved shared voice but rejects a mismatched voice', () => {
  const identityId = crypto.randomUUID();
  const identity = { id: identityId, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', providerRenderableAvatarId: 'owned-avatar', providerVoiceId: 'owned-voice', archivedAt: null };
  const payload = { identityId, voice: { voiceId: 'shared-voice' } };
  assert.deepEqual(authorizedIdentityInput({ identityId, voice: { id: 'shared-voice' } }, payload, identity).voice, payload.voice);
  assert.throws(() => authorizedIdentityInput({ identityId, voice: { id: 'different-voice' } }, payload, identity), /voice does not match/);
});

test('identity render fails closed for project mismatch, incomplete, or archived identities', () => {
  const identityId = crypto.randomUUID();
  const payload = { identityId };
  const ready = { id: identityId, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', providerRenderableAvatarId: 'owned-avatar', providerVoiceId: 'owned-voice', archivedAt: null };
  assert.throws(() => authorizedIdentityInput({ identityId: crypto.randomUUID() }, payload, ready), /does not match/);
  assert.throws(() => authorizedIdentityInput({ identityId }, payload, { ...ready, voiceStatus: 'PROCESSING' }), /not ready/);
  assert.throws(() => authorizedIdentityInput({ identityId }, payload, { ...ready, archivedAt: new Date() }), /not ready/);
});
