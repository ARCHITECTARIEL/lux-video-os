import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import adminHandler from '../routes/video-os-lite/admin.js';
import { handleHeygenRuntimeAttestation, heygenAttestationWindow } from '../routes/video-os-lite/heygen-attestation.js';

const NOW = Date.parse('2026-10-12T20:00:00.000Z');
const DEPLOYMENT_ID = 'dpl_exactuniquedeployment';
const deploymentHash = createHash('sha256').update(DEPLOYMENT_ID).digest('hex');
const HEX_KEY = 'a'.repeat(64);
const HEX_SCOPE = 'b'.repeat(64);

function environment(overrides = {}) {
  return {
    VIDEO_OS_HEYGEN_ATTESTATION_ENABLED: 'true',
    VIDEO_OS_HEYGEN_ATTESTATION_STARTED_AT: '2026-10-12T19:30:00.000Z',
    VIDEO_OS_HEYGEN_ATTESTATION_EXPIRES_AT: '2026-10-12T20:30:00.000Z',
    VIDEO_OS_ADMIN_TOKEN: 'exact-operator-bearer-token',
    CRON_SECRET: 'cron-token-must-not-work',
    HEYGEN_API_KEY: 'synthetic-provider-secret-not-for-output',
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_ID: 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW',
    VERCEL_DEPLOYMENT_ID: DEPLOYMENT_ID,
    VERCEL_URL: 'lux-video-unique-lux-3035s-projects.vercel.app',
    ...overrides,
  };
}

function request({ method = 'GET', headers = {} } = {}) {
  return {
    method,
    url: '/api/video-os-lite/admin?operation=heygen-runtime-attestation',
    headers: {
      host: 'lux-video-unique-lux-3035s-projects.vercel.app',
      authorization: 'Bearer exact-operator-bearer-token',
      'x-expected-deployment-id-hash': deploymentHash,
      ...headers,
    },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(raw) { this.body = JSON.parse(raw); },
  };
}

function qualification(overrides = {}) {
  return {
    credentialKeyFingerprint: HEX_KEY,
    credentialScopeFingerprint: HEX_SCOPE,
    publicSummary: { credentialStatus: 'active', profileProbeOutcome: 'OBSERVED' },
    privateEvidence: {
      profile: { username: 'private-provider-username', email: 'private@example.test' },
    },
    ...overrides,
  };
}

test('runtime attestation is default off and refuses wrong target or expired windows before provider I/O', async () => {
  assert.equal(heygenAttestationWindow(environment({ VIDEO_OS_HEYGEN_ATTESTATION_ENABLED: 'false' }), NOW), false);
  for (const env of [
    environment({ VIDEO_OS_HEYGEN_ATTESTATION_ENABLED: 'false' }),
    environment({ VIDEO_OS_HEYGEN_ATTESTATION_EXPIRES_AT: '2026-10-12T19:59:59.000Z' }),
    environment({ VIDEO_OS_HEYGEN_ATTESTATION_STARTED_AT: '2026-10-12T20:00:01.000Z' }),
    environment({ VIDEO_OS_HEYGEN_ATTESTATION_STARTED_AT: '2026-10-12T17:00:00.000Z' }),
    environment({ VERCEL_PROJECT_ID: 'prj_unrelated' }),
    environment({ VERCEL_ENV: 'preview' }),
    environment({ VERCEL_DEPLOYMENT_ID: '' }),
  ]) {
    let calls = 0;
    const res = response();
    await handleHeygenRuntimeAttestation(request(), res, {
      env, now: NOW, clock: () => NOW, qualify: async () => { calls++; },
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, code: 'attestation_unavailable' });
    assert.equal(calls, 0);
  }
  const wrongHost = response();
  await handleHeygenRuntimeAttestation(request({ headers: { host: 'lux-video-os.vercel.app' } }), wrongHost, {
    env: environment(), now: NOW, clock: () => NOW,
  });
  assert.equal(wrongHost.statusCode, 404);
  const noSystemHost = response();
  await handleHeygenRuntimeAttestation(request(), noSystemHost, {
    env: environment({ VERCEL_URL: '' }), now: NOW, clock: () => NOW,
    qualify: async () => qualification(),
  });
  assert.equal(noSystemHost.statusCode, 200);
  assert.equal(noSystemHost.body.target.observedHost, 'lux-video-unique-lux-3035s-projects.vercel.app');
  assert.deepEqual(noSystemHost.body.space, { verified: false, status: 'not_attested' });
});

test('runtime attestation accepts only exact operator Bearer and exact deployment binding', async () => {
  const env = environment();
  for (const headers of [
    { authorization: undefined },
    { authorization: 'Bearer ' + env.CRON_SECRET },
    { authorization: undefined, cookie: 'vos_admin=synthetic' },
    { authorization: 'Bearer wrong-token' },
  ]) {
    let calls = 0;
    const res = response();
    await handleHeygenRuntimeAttestation(request({ headers }), res, {
      env, now: NOW, clock: () => NOW, qualify: async () => { calls++; },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'operator_required');
    assert.equal(calls, 0);
  }
  const mismatch = response();
  await handleHeygenRuntimeAttestation(request({ headers: { 'x-expected-deployment-id-hash': '0'.repeat(64) } }), mismatch, {
    env, now: NOW, clock: () => NOW, qualify: async () => { throw new Error('must not run'); },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.body.code, 'deployment_mismatch');
  const method = response();
  await handleHeygenRuntimeAttestation(request({ method: 'POST' }), method, { env, now: NOW, clock: () => NOW });
  assert.equal(method.statusCode, 405);
});

test('qualified runtime key returns only nonsecret target-bound fields and never space authority', async () => {
  const env = environment();
  const res = response();
  await handleHeygenRuntimeAttestation(request(), res, {
    env, now: NOW, clock: () => NOW,
    qualify: async ({ apiKey }) => {
      assert.equal(apiKey, env.HEYGEN_API_KEY);
      return qualification();
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.target.projectId, env.VERCEL_PROJECT_ID);
  assert.equal(res.body.target.deploymentIdHash, deploymentHash);
  assert.equal(res.body.credential.keyFingerprint, HEX_KEY);
  assert.equal(res.body.credential.scopeFingerprint, HEX_SCOPE);
  assert.match(res.body.credential.usernameDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(res.body.space, { verified: false, status: 'not_attested' });
  assert.equal(res.body.canaryAuthorized, false);
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(res.headers.Vary, 'Authorization');
  assert.doesNotMatch(JSON.stringify(res.body), /synthetic-provider-secret|private-provider-username|private@example\.test|cron-token/u);
});

test('an unavailable credential status cannot become an eligibility receipt', async () => {
  const env = environment();
  const inactive = response();
  await handleHeygenRuntimeAttestation(request(), inactive, {
    env, now: NOW, clock: () => NOW,
    qualify: async () => qualification({
      publicSummary: { credentialStatus: 'inactive', profileProbeOutcome: 'OBSERVED' },
    }),
  });
  assert.equal(inactive.body.credential.status, 'unavailable');
  assert.deepEqual(inactive.body.space, { verified: false, status: 'not_attested' });
  assert.equal(inactive.body.canaryAuthorized, false);
});

test('an attestation window expiring during provider reads cannot return a receipt', async () => {
  const res = response();
  await handleHeygenRuntimeAttestation(request(), res, {
    env: environment(), now: NOW,
    clock: () => Date.parse('2026-10-12T20:30:00.000Z'),
    qualify: async () => qualification(),
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, code: 'attestation_unavailable' });
});

test('missing, rejected or malformed credentials fail without secret or provider-body exposure', async () => {
  for (const [env, qualify, expected] of [
    [environment({ HEYGEN_API_KEY: '' }), async () => { throw new Error('must not run'); }, 'credential_unavailable'],
    [environment({ HEYGEN_API_KEY: '[SENSITIVE]' }), async () => { throw new Error('must not run'); }, 'credential_unavailable'],
    [environment(), async () => { throw Object.assign(new Error('private provider body'), { code: 'HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE' }); }, 'credential_rejected'],
    [environment(), async () => qualification({ credentialKeyFingerprint: 'private raw key' }), 'credential_unavailable'],
  ]) {
    const res = response();
    await handleHeygenRuntimeAttestation(request(), res, { env, now: NOW, clock: () => NOW, qualify });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, code: expected });
    assert.doesNotMatch(JSON.stringify(res.body), /private provider body|private raw key|synthetic-provider-secret/u);
  }
});

test('admin dispatch keeps the new attestation route dormant by default', async () => {
  const original = process.env.VIDEO_OS_HEYGEN_ATTESTATION_ENABLED;
  delete process.env.VIDEO_OS_HEYGEN_ATTESTATION_ENABLED;
  try {
    const res = response();
    await adminHandler(request(), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, code: 'attestation_unavailable' });
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_HEYGEN_ATTESTATION_ENABLED;
    else process.env.VIDEO_OS_HEYGEN_ATTESTATION_ENABLED = original;
  }
});
