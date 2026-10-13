import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHostedAvatarConsentRequest, createHeygenHostedConsent } from '../services/heygen.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.HEYGEN_API_KEY;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.HEYGEN_API_KEY;
  else process.env.HEYGEN_API_KEY = originalKey;
});

test('hosted consent request accepts only a same-origin HTTPS return', () => {
  const publicOrigin = 'https://video.example';
  const rerouteUrl = 'https://video.example/identity?consent_state=opaque-state';
  assert.deepEqual(buildHostedAvatarConsentRequest({ rerouteUrl, publicOrigin }), { reroute_url: rerouteUrl });
  for (const bad of ['http://video.example/identity', 'https://other.example/identity', 'https://user@video.example/identity', 'https://video.example/identity#fragment']) {
    assert.throws(() => buildHostedAvatarConsentRequest({ rerouteUrl: bad, publicOrigin }), /return URL/i);
  }
});

test('hosted consent submission is one exact idempotent provider request with a validated URL', async () => {
  process.env.HEYGEN_API_KEY = 'test-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: {
      avatar_group: { id: 'group-1', status: 'pending_consent', consent_status: 'pending' },
      url: 'https://app.heygen.com/avatars/api-video/record?token=private',
    } }), { status: 200 });
  };
  const result = await createHeygenHostedConsent({
    groupId: 'group-1',
    rerouteUrl: 'https://video.example/identity?consent_state=opaque-state',
    publicOrigin: 'https://video.example',
    idempotencyKey: 'consent:group-1:operation-1',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.heygen.com/v3/avatars/group-1/consent');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'consent:group-1:operation-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { reroute_url: 'https://video.example/identity?consent_state=opaque-state' });
  assert.equal(result.providerGroupId, 'group-1');
  assert.equal(result.consentStatus, 'pending');
  assert.ok(result.url.startsWith('https://app.heygen.com/'));
});

test('hosted consent rejects a mismatched group and untrusted destination without returning the URL', async () => {
  process.env.HEYGEN_API_KEY = 'test-key';
  for (const response of [
    { avatar_group: { id: 'other-group', consent_status: 'pending' }, url: 'https://app.heygen.com/consent' },
    { avatar_group: { id: 'group-1', consent_status: 'pending' }, url: 'https://other.example/steal?token=private' },
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ data: response }), { status: 200 });
    await assert.rejects(createHeygenHostedConsent({
      groupId: 'group-1', rerouteUrl: 'https://video.example/identity?consent_state=opaque-state',
      publicOrigin: 'https://video.example', idempotencyKey: 'consent:group-1:operation-1',
    }), (error) => error.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN' && !error.message.includes('private'));
  }
});
