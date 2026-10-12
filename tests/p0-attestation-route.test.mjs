import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import adminHandler, {
  handleP0AttestationRequest,
  p0AttestationWindow,
} from '../routes/video-os-lite/admin.js';
import { P0JobAttestationError } from '../db/p0-job-attestation.js';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const NOW = Date.parse('2026-10-11T16:00:00.000Z');

function environment(overrides = {}) {
  return {
    VIDEO_OS_ADMIN_TOKEN: 'exact-diagnostic-operator-token',
    CRON_SECRET: 'cron-token-must-not-work',
    VIDEO_OS_P0_ATTESTATION_ENABLED: 'true',
    VIDEO_OS_P0_ATTESTATION_STARTED_AT: '2026-10-11T15:30:00.000Z',
    VIDEO_OS_P0_ATTESTATION_EXPIRES_AT: '2026-10-11T16:30:00.000Z',
    VIDEO_OS_PUBLIC_ORIGIN: 'https://lux-video-os.vercel.app',
    VERCEL_ENV: 'production',
    VERCEL_DEPLOYMENT_ID: 'deployment-test',
    VERCEL_GIT_COMMIT_SHA: 'source-test',
    ...overrides,
  };
}

function bindingHeaders(env = environment()) {
  return {
    host: 'lux-video-os.vercel.app',
    authorization: 'Bearer ' + env.VIDEO_OS_ADMIN_TOKEN,
    'x-p0-proof-id': randomUUID(),
    'x-p0-job-id': 'job-p0-route',
    'x-p0-correlation-id': 'corr-p0-route',
    'x-p0-account-hash': 'a'.repeat(24),
    'x-p0-deployment-id-hash': sha256(env.VERCEL_DEPLOYMENT_ID),
    'x-p0-source-commit-hash': sha256(env.VERCEL_GIT_COMMIT_SHA),
    'x-p0-deployment-mode': 'production',
    'x-p0-render-mode': 'premium_presenter_v1',
  };
}

function request({ method = 'GET', headers = {}, url = '/api/video-os-lite/admin?operation=p0-attestation' } = {}) {
  return { method, headers, url };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(raw) { this.body = JSON.parse(raw); },
  };
}

test('P0 attestation is default-off and bounded to a valid UTC window', async () => {
  for (const env of [
    environment({ VIDEO_OS_P0_ATTESTATION_ENABLED: 'false' }),
    environment({ VIDEO_OS_P0_ATTESTATION_EXPIRES_AT: '2026-10-11T15:59:59.000Z' }),
    environment({ VIDEO_OS_P0_ATTESTATION_STARTED_AT: '2026-10-11T16:00:01.000Z' }),
    environment({ VIDEO_OS_P0_ATTESTATION_STARTED_AT: '2026-10-11T12:00:00.000Z' }),
  ]) {
    assert.equal(p0AttestationWindow(env, NOW), false);
    let called = false;
    const res = response();
    await handleP0AttestationRequest(request({ headers: bindingHeaders(env) }), res, {
      env,
      now: NOW,
      attest: async () => { called = true; },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'attestation_unavailable');
    assert.equal(called, false);
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  }
});

test('P0 attestation requires the exact diagnostic Bearer, not cron or cookie auth', async () => {
  const env = environment();
  for (const headers of [
    { ...bindingHeaders(env), authorization: undefined },
    { ...bindingHeaders(env), authorization: 'Bearer ' + env.CRON_SECRET },
    { ...bindingHeaders(env), authorization: undefined, cookie: 'vos_admin=synthetic-admin-cookie' },
  ]) {
    let called = false;
    const res = response();
    await handleP0AttestationRequest(request({ headers }), res, {
      env,
      now: NOW,
      attest: async () => { called = true; },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'operator_required');
    assert.equal(called, false);
  }
});

test('P0 attestation forwards exact header binding and returns private no-store JSON', async () => {
  const env = environment();
  const headers = bindingHeaders(env);
  let captured;
  const attestation = {
    version: 'video-os-p0-job-attestation/v1',
    ok: true,
    applicationSnapshotComplete: true,
    providerNativeVerified: false,
  };
  const res = response();
  await handleP0AttestationRequest(request({ headers }), res, {
    env,
    now: NOW,
    attest: async (binding, options) => {
      captured = { binding, options };
      return attestation;
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, attestation);
  assert.deepEqual(captured.binding, {
    proofId: headers['x-p0-proof-id'],
    jobId: headers['x-p0-job-id'],
    correlationId: headers['x-p0-correlation-id'],
    accountHash: headers['x-p0-account-hash'],
    deploymentIdHash: headers['x-p0-deployment-id-hash'],
    sourceCommitHash: headers['x-p0-source-commit-hash'],
    deploymentMode: 'production',
    renderMode: 'premium_presenter_v1',
  });
  assert.equal(captured.options.env, env);
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers.Vary, 'Authorization');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});

test('P0 attestation returns sanitized failures and rejects non-GET methods', async () => {
  const env = environment();
  const headers = bindingHeaders(env);
  const method = response();
  await handleP0AttestationRequest(request({ method: 'POST', headers }), method, { env, now: NOW });
  assert.equal(method.statusCode, 405);
  assert.equal(method.body.code, 'method_not_allowed');

  const incomplete = response();
  await handleP0AttestationRequest(request({ headers }), incomplete, {
    env,
    now: NOW,
    attest: async () => { throw new P0JobAttestationError('credit_debit_cardinality'); },
  });
  assert.equal(incomplete.statusCode, 409);
  assert.deepEqual(incomplete.body, { ok: false, code: 'credit_debit_cardinality' });

  const unavailable = response();
  await handleP0AttestationRequest(request({ headers }), unavailable, {
    env,
    now: NOW,
    attest: async () => { throw new Error('private account/path/provider body'); },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { ok: false, code: 'attestation_unavailable' });
  assert.doesNotMatch(JSON.stringify(unavailable), /private account|provider body/u);
});

test('default admin handler routes P0 requests through the private default-off surface', async () => {
  const original = process.env.VIDEO_OS_P0_ATTESTATION_ENABLED;
  process.env.VIDEO_OS_P0_ATTESTATION_ENABLED = 'false';
  try {
    const res = response();
    await adminHandler(request({ headers: { host: 'lux-video-os.vercel.app' } }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'attestation_unavailable');
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_P0_ATTESTATION_ENABLED;
    else process.env.VIDEO_OS_P0_ATTESTATION_ENABLED = original;
  }
});
