import assert from 'node:assert/strict';
import test from 'node:test';

import renderHandler, { authorizedIdentityInput } from '../api/video-os-lite/render-v2.js';
import { assertDatabaseConfigured } from '../db/client.js';
import { makeSession } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}


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

// Real gap found via a fresh entitlement/authorization audit: render-v2.js's
// handler called requireRenderAccountAuthorization(session.accountId) with
// no email argument, even though session.email is already available right
// there (used two lines later for ensureAccount). requireRenderAccountAuthorization's
// isTesterEmailExact() check only ever fires when email is passed -- without
// it, a designated individual tester's access to actually SUBMIT a render
// depended entirely on REGISTERED_TESTER_ACCOUNTS already having their
// accountId from a prior sign-in on the same warm serverless instance:
// non-deterministic across cold starts, even though tests/mvp-tester-whitelist.test.mjs
// already proved the underlying function correctly honors an exact tester
// email on its own. This proves the actual HTTP handler now wires session.email
// through, not just that the function supports it in isolation -- a fresh
// accountId (never seen by REGISTERED_TESTER_ACCOUNTS) paired with the real
// designated tester email must not be rejected with the entitlement 403.
test(
  'render-v2 handler authorizes a designated tester email even on a brand-new accountId never seen by the in-memory tester registry',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
    const originalWorkflow = process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED;
    const originalAllowlist = process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
    if (!originalSecret) process.env.VIDEO_OS_SESSION_SECRET = 'render-auth-test-secret-with-adequate-length';
    process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED = 'true';
    delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID; // prove the email path alone authorizes, not the accountId allowlist
    try {
      const freshAccountId = `acct-fresh-${crypto.randomUUID()}`;
      const cookie = makeSession(freshAccountId, 'arielsmailbox@gmail.com');
      const res = response();
      await renderHandler(request({}, { cookie: `vos_session=${cookie}` }), res);

      assert.notEqual(res.body.error, 'This account is not authorized for contained rendering.', 'a designated tester email must authorize the render-v2 handler directly, not just the underlying function');
      assert.notEqual(res.statusCode, 503, 'must not be the CONFIG_MISSING failure either -- that would mean authorization was skipped for an unrelated reason, not genuinely passed');
    } finally {
      if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET; else process.env.VIDEO_OS_SESSION_SECRET = originalSecret;
      if (originalWorkflow === undefined) delete process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED; else process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED = originalWorkflow;
      if (originalAllowlist === undefined) delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID; else process.env.VIDEO_OS_RENDER_ACCOUNT_ID = originalAllowlist;
    }
  },
);
