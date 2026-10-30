import assert from 'node:assert/strict';
import test from 'node:test';

import { createLuxifyConsentHandler } from '../routes/video-os-lite/luxify-consent.js';
import { createLuxifyHandler, LUXIFY_FEATURE_FLAG } from '../routes/video-os-lite/luxify.js';
import { LUXIFY_CONTRACT_VERSION } from '../lib/luxify-contract.js';
import { issueLuxifyConsentChallenge, LUXIFY_CONSENT_NOTICE_SHA256 } from '../lib/luxify-consent-policy.js';

const ORIGIN = 'https://video.example';
const ACCOUNT = 'subject-account-test';
const IDENTITY = '0c0c0c0c-0000-4000-8000-000000000001';
const CONSENT = '0c0c0c0c-0000-4000-8000-000000000002';
const KEY = '0c0c0c0c-0000-4000-8000-000000000003';
const ENV = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: 'consent-route-test-secret-at-least-32-bytes' };
const NOW = Date.parse('2026-11-02T10:00:00.000Z');

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = raw ? JSON.parse(raw) : null; } };
}
function request(method = 'GET', body, headers = {}) {
  return {
    method,
    url: '/api/video-os-lite/luxify-consent',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers },
    body,
  };
}
function fixture(overrides = {}) {
  const calls = [];
  const record = name => async input => { calls.push([name, input]); return overrides[name] ? overrides[name](input) : { consent: { id: CONSENT, status: 'active' }, replayed: false, changed: true }; };
  const repository = {
    listConsents: async input => { calls.push(['listConsents', input]); return { identities: [{ id: IDENTITY, displayName: 'Test look' }], consents: [] }; },
    grantConsent: record('grantConsent'),
    withdrawConsent: record('withdrawConsent'),
    revokeConsent: record('revokeConsent'),
    revokeSourceIdentityConsent: record('revokeSourceIdentityConsent'),
    grantStaff: record('grantStaff'),
    revokeStaffGrant: record('revokeStaffGrant'),
    approveCreativeAsset: record('approveCreativeAsset'),
    recordLookCapabilityEvidence: record('recordLookCapabilityEvidence'),
  };
  const handler = createLuxifyConsentHandler({
    authenticate: overrides.authenticate || (() => ({ accountId: ACCOUNT, email: 'subject@example.test' })),
    environment: ENV,
    repository,
    now: () => NOW,
  });
  return { handler, calls };
}
const grantBody = (overrides = {}) => ({
  action: 'grant', identityId: IDENTITY, idempotencyKey: KEY,
  challenge: issueLuxifyConsentChallenge({ accountId: ACCOUNT, identityId: IDENTITY, now: NOW, env: ENV }),
  noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
  cinematicGenerationAuthorization: true, providerProcessingAuthorization: true, ...overrides,
});

test('GET returns the consent notice, a per-look challenge and the caller\'s consents only', async () => {
  const { handler, calls } = fixture();
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.noticeSha256, LUXIFY_CONSENT_NOTICE_SHA256);
  assert.match(res.body.notice.paragraphs.join(' '), /BytePlus/);
  assert.equal(res.body.identities[0].identityId, IDENTITY);
  assert.ok(res.body.identities[0].challenge);
  assert.deepEqual(calls, [['listConsents', { accountId: ACCOUNT }]]);
});

test('grant uses the signed-in subject account and both explicit authorizations', async () => {
  const { handler, calls } = fixture();
  const res = response();
  await handler(request('POST', grantBody({ expiryDays: 90 })), res);
  assert.equal(res.statusCode, 201);
  assert.equal(calls[0][0], 'grantConsent');
  assert.equal(calls[0][1].accountId, ACCOUNT);
  assert.equal(calls[0][1].expiryDays, 90);
});

test('grant is refused for a non-subject: another account\'s challenge, a body account override, or a non-owned identity', async () => {
  const other = fixture({ authenticate: () => ({ accountId: 'other-account-test' }) });
  const res = response();
  await other.handler(request('POST', grantBody()), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'LUXIFY_CONSENT_CHALLENGE_INVALID');
  assert.equal(other.calls.length, 0);

  const override = fixture();
  const overrideRes = response();
  await override.handler(request('POST', grantBody({ accountId: 'other-account-test' })), overrideRes);
  assert.equal(overrideRes.statusCode, 400);
  assert.equal(override.calls.length, 0);

  const notOwned = fixture({ grantConsent: () => { throw Object.assign(new Error('Only the subject can manage consent for this identity.'), { code: 'LUXIFY_CONSENT_SUBJECT_REQUIRED', statusCode: 403 }); } });
  const notOwnedRes = response();
  await notOwned.handler(request('POST', grantBody()), notOwnedRes);
  assert.equal(notOwnedRes.statusCode, 403);
  assert.equal(notOwnedRes.body.code, 'LUXIFY_CONSENT_SUBJECT_REQUIRED');
});

test('grant validation refuses missing authorizations and expiry beyond 365 days', async () => {
  for (const body of [grantBody({ providerProcessingAuthorization: false }), grantBody({ cinematicGenerationAuthorization: undefined }), grantBody({ expiryDays: 366 })]) {
    const { handler, calls } = fixture();
    const res = response();
    await handler(request('POST', body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});

test('withdraw and staff actions always act as the signed-in account', async () => {
  const { handler, calls } = fixture();
  await handler(request('POST', { action: 'withdraw', consentId: CONSENT }), response());
  await handler(request('POST', { action: 'revoke', consentId: CONSENT }), response());
  await handler(request('POST', { action: 'grant-staff', staffAccountId: 'staff-account-test', explicitGrant: true }), response());
  assert.deepEqual(calls.map(([name, input]) => [name, input.accountId ?? input.staffAccountId ?? input.grantorAccountId]), [
    ['withdrawConsent', ACCOUNT], ['revokeConsent', ACCOUNT], ['grantStaff', 'staff-account-test'],
  ]);
  assert.equal(calls[2][1].grantorAccountId, ACCOUNT);
  const missing = fixture();
  const res = response();
  await missing.handler(request('POST', { action: 'grant-staff', staffAccountId: 'staff-account-test' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(missing.calls.length, 0);
});

test('consent route rejects anonymous, cross-origin and storage failures without leaking details', async () => {
  const anon = fixture({ authenticate: () => null });
  const anonRes = response();
  await anon.handler(request(), anonRes);
  assert.equal(anonRes.statusCode, 401);

  const cross = fixture();
  const crossRes = response();
  await cross.handler(request('POST', { action: 'withdraw', consentId: CONSENT }, { origin: 'https://evil.example' }), crossRes);
  assert.equal(crossRes.statusCode, 403);
  assert.equal(cross.calls.length, 0);

  const broken = fixture({ withdrawConsent: () => { throw new Error('connection string postgres://secret'); } });
  const brokenRes = response();
  await broken.handler(request('POST', { action: 'withdraw', consentId: CONSENT }), brokenRes);
  assert.equal(brokenRes.statusCode, 503);
  assert.equal(brokenRes.body.code, 'luxify_consent_unavailable');
  assert.doesNotMatch(JSON.stringify(brokenRes.body), /postgres|secret/);
});

test('LUXIFY stays off by default: with no VIDEO_OS_LUXIFY_* env the production resolver is never reached', async () => {
  const environment = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN };
  assert.equal(Object.keys(environment).some(key => key.startsWith('VIDEO_OS_LUXIFY_')), false);
  assert.equal(LUXIFY_FEATURE_FLAG.startsWith('VIDEO_OS_LUXIFY_'), true);
  const project = { id: '0c0c0c0c-0000-4000-8000-000000000009' };
  // Default resolveEligibility is the DB-backed resolver; no DATABASE_URL is
  // set under the env-safe wrapper, so reaching it would surface as an error.
  const handler = createLuxifyHandler({
    authenticate: () => ({ accountId: ACCOUNT, email: 'subject@example.test' }),
    environment,
    rateLimit: async () => true,
    repository: { saveProject: async () => project, getProject: async () => project, recoverJob: async () => null },
    authorizePremium: async () => { throw new Error('must not authorize while disabled'); },
    runtimePreflight: async () => { throw new Error('must not preflight while disabled'); },
  });
  const res = response();
  await handler({ method: 'GET', url: '/api/video-os-lite/luxify', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.capabilities.available, false);
  assert.equal(res.body.capabilities.reasons[0], 'feature_disabled');
  assert.deepEqual(res.body.capabilities.eligibleLooks, []);

  const quote = response();
  await handler({
    method: 'POST', url: '/api/video-os-lite/luxify',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: { action: 'quote', contractVersion: LUXIFY_CONTRACT_VERSION, projectId: project.id, idempotencyKey: KEY },
  }, quote);
  assert.equal(quote.statusCode, 503);
  assert.equal(quote.body.reasons[0], 'feature_disabled');
});
