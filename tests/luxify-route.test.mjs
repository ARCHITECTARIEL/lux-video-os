import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import workspaceHandler from '../api/video-os-lite/workspace.js';
import { LUXIFY_CONTRACT_VERSION } from '../lib/luxify-contract.js';
import { verifyLuxifyQuote } from '../lib/luxify-quote.js';
import {
  LUXIFY_ACCOUNT_PIN_ENV,
  LUXIFY_FEATURE_FLAG,
  createLuxifyHandler,
  defaultLuxifyRuntimePreflight,
} from '../routes/video-os-lite/luxify.js';

const ORIGIN = 'https://video.example';
const ACCOUNT = 'owner-account';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const LOOK_A = '22222222-2222-4222-8222-222222222222';
const LOOK_B = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY = '44444444-4444-4444-8444-444444444444';
const SECRET = 'luxify-route-test-secret-at-least-32-bytes';
const QUOTE_NOW = Date.parse('2026-10-11T17:00:00.000Z');
const FINGERPRINT_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8');

const draft = Object.freeze({
  contractVersion: LUXIFY_CONTRACT_VERSION,
  projectId: PROJECT,
  title: 'LUXIFY owner scene',
  prompt: 'Track past the founder while generated ambience builds.',
  lookIdentityIds: [LOOK_A, LOOK_B],
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
});

const project = Object.freeze({
  id: PROJECT,
  contractVersion: LUXIFY_CONTRACT_VERSION,
  title: draft.title,
  prompt: draft.prompt,
  lookIdentityIds: draft.lookIdentityIds,
  aspectRatio: draft.aspectRatio,
  resolution: draft.resolution,
  durationSeconds: draft.durationSeconds,
});

const bindings = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'private-look-a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'private-look-b' }),
]);
const revision = 'luxify-look-eligibility-v1:canary:route-r1';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(raw) { this.body = raw ? JSON.parse(raw) : null; },
  };
}

function request(method = 'GET', { body, query = '', headers = {} } = {}) {
  return {
    method,
    url: `/api/video-os-lite/luxify${query}`,
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body,
  };
}

function activeEnv(overrides = {}) {
  return {
    VIDEO_OS_PUBLIC_ORIGIN: ORIGIN,
    [LUXIFY_FEATURE_FLAG]: 'true',
    [LUXIFY_ACCOUNT_PIN_ENV]: ACCOUNT,
    VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41',
    VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97',
    ...overrides,
  };
}

function runtimeEnv(overrides = {}) {
  return {
    HEYGEN_API_KEY: 'synthetic-runtime-credential',
    HEYGEN_TIMEOUT_MS: '20000',
    VIDEO_OS_SESSION_SECRET: 's'.repeat(40),
    STORAGE_DRIVER: 'blob',
    BLOB_READ_WRITE_TOKEN: 'synthetic-private-storage-token',
    VIDEO_OS_PROVIDER_MEDIA_HOSTS: 'files.heygen.ai',
    VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
    VIDEO_OS_DURABLE_WORKFLOW_ENABLED: 'true',
    VIDEO_OS_HOSTED_FINISHING_ENABLED: 'true',
    ...overrides,
  };
}

function approvedEvidenceFor(credential = 'synthetic-runtime-credential') {
  return {
    provider: 'heygen',
    credentialKeyFingerprint: createHash('sha256').update(FINGERPRINT_DOMAIN).update(credential, 'utf8').digest('hex'),
  };
}

function fixture(overrides = {}) {
  const calls = { authorize: [], eligibility: [], runtime: [], save: [], get: [], recover: [], rate: [] };
  const repository = {
    saveProject: async value => { calls.save.push(value); return project; },
    getProject: async (accountId, projectId) => { calls.get.push({ accountId, projectId }); return project; },
    recoverJob: async value => { calls.recover.push(value); return overrides.existingJob ?? null; },
    ...overrides.repository,
  };
  const resolveEligibility = overrides.resolveEligibility || (async value => {
    calls.eligibility.push(value);
    if (!value.lookIdentityIds) {
      return {
        eligibleLooks: [
          { identityId: LOOK_A, displayName: 'Owner look', providerLookId: 'must-not-leak', renderMode: 'must-not-leak' },
          { identityId: LOOK_B, displayName: 'Second look' },
        ],
      };
    }
    return { lookBindings: bindings, eligibilityRevision: revision };
  });
  const handler = createLuxifyHandler({
    authenticate: overrides.authenticate || (() => ({ accountId: ACCOUNT, email: 'owner@example.test' })),
    environment: overrides.environment || activeEnv(),
    rateLimit: overrides.rateLimit || (async value => { calls.rate.push(value); return true; }),
    repository,
    authorizePremium: overrides.authorizePremium || (async (accountId, tier) => { calls.authorize.push({ accountId, tier }); }),
    resolveEligibility,
    runtimePreflight: overrides.runtimePreflight || (async value => {
      calls.runtime.push(value);
      return { ready: true, reasons: [] };
    }),
    quoteOptions: {
      secret: SECRET,
      now: QUOTE_NOW,
      nonce: 'luxify-route-nonce-123456789',
      ...(overrides.quoteOptions || {}),
    },
    ...overrides.dependencies,
  });
  return { calls, handler, repository };
}

test('GET capability is default-off and never consults eligibility while gates are missing', async () => {
  const { handler, calls } = fixture({ environment: { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    capabilities: {
      available: false,
      reasons: ['feature_disabled', 'account_not_pinned', 'pricing_unconfigured'],
      eligibleLooks: [],
    },
  });
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.eligibility.length, 0);
  assert.equal(calls.runtime.length, 0);
});

test('GET capability requires current Premium authority and returns sanitized eligible looks', async () => {
  const active = fixture();
  const res = response();
  await active.handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.capabilities.available, true);
  assert.deepEqual(res.body.capabilities.reasons, []);
  assert.deepEqual(res.body.capabilities.eligibleLooks, [
    { identityId: LOOK_A, displayName: 'Owner look' },
    { identityId: LOOK_B, displayName: 'Second look' },
  ]);
  assert.equal(JSON.stringify(res.body).includes('must-not-leak'), false);
  assert.deepEqual(active.calls.authorize, [{ accountId: ACCOUNT, tier: 'premium' }]);
  assert.deepEqual(active.calls.eligibility, [{ accountId: ACCOUNT }]);
  assert.equal(active.calls.runtime.length, 1);
  assert.equal(active.calls.runtime[0].accountId, ACCOUNT);

  const denied = fixture({ authorizePremium: async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); } });
  const deniedRes = response();
  await denied.handler(request(), deniedRes);
  assert.equal(deniedRes.body.capabilities.available, false);
  assert.deepEqual(deniedRes.body.capabilities.reasons, ['premium_access_required']);
  assert.deepEqual(deniedRes.body.capabilities.eligibleLooks, []);
});

test('default runtime preflight verifies local prerequisites and returns only sanitized reasons', async () => {
  const env = runtimeEnv();
  const approved = approvedEvidenceFor();
  const options = {
    env,
    accountId: ACCOUNT,
    now: new Date('2026-10-11T17:00:00.000Z'),
    loadQualificationEvidence: async () => approved,
    assertQualificationEvidence: evidence => evidence,
  };
  assert.deepEqual(await defaultLuxifyRuntimePreflight(options), { ready: true, reasons: [] });

  const cases = [
    [runtimeEnv({ HEYGEN_API_KEY: '' }), ['provider_config_unavailable', 'provider_qualification_unavailable']],
    [runtimeEnv({ HEYGEN_TIMEOUT_MS: 'invalid' }), ['provider_timeout_invalid']],
    [runtimeEnv({ VIDEO_OS_SESSION_SECRET: 'short' }), ['quote_signing_unavailable']],
    [runtimeEnv({ BLOB_READ_WRITE_TOKEN: '' }), ['private_storage_unavailable']],
    [runtimeEnv({ VIDEO_OS_PROVIDER_MEDIA_HOSTS: '*.heygen.ai' }), ['provider_media_allowlist_unavailable']],
    [runtimeEnv({ VIDEO_OS_PROVIDER_CREATION_ENABLED: 'false' }), ['provider_creation_disabled']],
    [runtimeEnv({
      VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
      VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'other-account',
    }), ['provider_creation_disabled']],
    [runtimeEnv({ VIDEO_OS_DURABLE_WORKFLOW_ENABLED: '' }), ['durable_workflow_disabled']],
    [runtimeEnv({ VIDEO_OS_HOSTED_FINISHING_ENABLED: '0' }), ['hosted_finishing_disabled']],
  ];
  for (const [candidate, expected] of cases) {
    const result = await defaultLuxifyRuntimePreflight({ ...options, env: candidate });
    assert.equal(result.ready, false);
    for (const reason of expected) assert.equal(result.reasons.includes(reason), true, reason);
    assert.equal(JSON.stringify(result).includes(candidate.HEYGEN_API_KEY || 'never-match'), false);
  }

  const canaryEnv = runtimeEnv({ VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: ACCOUNT });
  assert.deepEqual(await defaultLuxifyRuntimePreflight({ ...options, env: canaryEnv }), { ready: true, reasons: [] });
  for (const accountId of [undefined, '', 'other-account']) {
    const result = await defaultLuxifyRuntimePreflight({ ...options, env: canaryEnv, accountId });
    assert.equal(result.reasons.includes('provider_creation_disabled'), true);
  }

  const mismatch = await defaultLuxifyRuntimePreflight({
    ...options,
    loadQualificationEvidence: async () => approvedEvidenceFor('different-credential'),
  });
  assert.deepEqual(mismatch, { ready: false, reasons: ['provider_qualification_unavailable'] });

  const currentLocalEvidence = await defaultLuxifyRuntimePreflight({ env });
  assert.equal(currentLocalEvidence.ready, false);
  assert.equal(currentLocalEvidence.reasons.includes('provider_qualification_unavailable'), true);
});

test('runtime preflight blocks capability and mutations before authority, eligibility, or persistence', async () => {
  const blocked = fixture({
    runtimePreflight: async () => ({
      ready: false,
      reasons: ['private_storage_unavailable', 'provider_qualification_unavailable'],
    }),
  });
  const capability = response();
  await blocked.handler(request(), capability);
  assert.equal(capability.statusCode, 200);
  assert.deepEqual(capability.body.capabilities, {
    available: false,
    reasons: ['private_storage_unavailable', 'provider_qualification_unavailable'],
    eligibleLooks: [],
  });
  assert.equal(blocked.calls.authorize.length, 0);
  assert.equal(blocked.calls.eligibility.length, 0);

  const save = response();
  await blocked.handler(request('POST', { body: { action: 'save-project', ...draft } }), save);
  assert.equal(save.statusCode, 503);
  assert.equal(save.body.code, 'luxify_unavailable');
  assert.deepEqual(save.body.reasons, ['private_storage_unavailable', 'provider_qualification_unavailable']);
  assert.equal(blocked.calls.save.length, 0);
});

test('each downstream execution flag independently blocks capability and new quote issuance', async () => {
  const cases = [
    [{ VIDEO_OS_PROVIDER_CREATION_ENABLED: 'false' }, 'provider_creation_disabled'],
    [{
      VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
      VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'other-account',
    }, 'provider_creation_disabled'],
    [{ VIDEO_OS_DURABLE_WORKFLOW_ENABLED: 'false' }, 'durable_workflow_disabled'],
    [{ VIDEO_OS_HOSTED_FINISHING_ENABLED: 'false' }, 'hosted_finishing_disabled'],
  ];
  for (const [overrides, reason] of cases) {
    const environment = { ...activeEnv(), ...runtimeEnv(overrides) };
    const label = JSON.stringify(overrides);
    const blocked = fixture({
      environment,
      runtimePreflight: ({ env, accountId }) => defaultLuxifyRuntimePreflight({
        env,
        accountId,
        now: new Date('2026-10-11T17:00:00.000Z'),
        loadQualificationEvidence: async () => approvedEvidenceFor(),
        assertQualificationEvidence: evidence => evidence,
      }),
    });
    const capability = response();
    await blocked.handler(request(), capability);
    assert.equal(capability.body.capabilities.available, false, label);
    assert.deepEqual(capability.body.capabilities.reasons, [reason], label);

    const quote = response();
    await blocked.handler(request('POST', {
      body: {
        action: 'quote',
        contractVersion: LUXIFY_CONTRACT_VERSION,
        projectId: PROJECT,
        idempotencyKey: IDEMPOTENCY,
      },
    }), quote);
    assert.equal(quote.statusCode, 503, label);
    assert.equal(quote.body.code, 'luxify_unavailable', label);
    assert.deepEqual(quote.body.reasons, [reason], label);
    assert.equal(blocked.calls.authorize.length, 0, label);
    assert.equal(blocked.calls.eligibility.length, 0, label);
  }
});

test('save-project accepts only browser intent and rechecks selected exact eligibility', async () => {
  const { handler, calls } = fixture();
  const res = response();
  await handler(request('POST', { body: { action: 'save-project', ...draft } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(calls.eligibility, [{ accountId: ACCOUNT, lookIdentityIds: [LOOK_A, LOOK_B] }]);
  assert.deepEqual(calls.save, [{ accountId: ACCOUNT, ...draft }]);
  assert.deepEqual(res.body.project, project);

  for (const forbidden of [
    { provider: 'heygen' },
    { renderMode: 'luxify_cinematic_v1' },
    { providerLookId: 'private-look-a' },
    { costCredits: 1 },
    { script: 'speak this' },
    { voice: { voiceId: 'private' } },
  ]) {
    const rejected = response();
    await handler(request('POST', { body: { action: 'save-project', ...draft, ...forbidden } }), rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.code, 'invalid_request');
  }
  assert.equal(calls.save.length, 1);
});

test('quote binds the authenticated account, saved project, ordered current looks, and current price', async () => {
  const { handler, calls } = fixture();
  const res = response();
  await handler(request('POST', {
    body: {
      action: 'quote',
      contractVersion: LUXIFY_CONTRACT_VERSION,
      projectId: PROJECT,
      idempotencyKey: IDEMPOTENCY,
    },
  }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.quote.credits, 41);
  assert.equal(res.body.quote.currency, 'lux_credits');
  assert.equal(res.body.quote.pricingVersion, 'luxify-cinematic-pricing-v1');
  assert.deepEqual(calls.get, [{ accountId: ACCOUNT, projectId: PROJECT }]);
  assert.deepEqual(calls.eligibility, [{ accountId: ACCOUNT, lookIdentityIds: [LOOK_A, LOOK_B] }]);
  assert.doesNotThrow(() => verifyLuxifyQuote(res.body.quote.token, {
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: draft.title,
    prompt: draft.prompt,
    lookBindings: bindings,
    eligibilityRevision: revision,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    durationSeconds: draft.durationSeconds,
  }, { secret: SECRET, now: QUOTE_NOW + 1_000, env: activeEnv() }));
});

test('quote fails closed on look order drift, feature drift, or Premium revocation', async () => {
  const quoteBody = { action: 'quote', contractVersion: LUXIFY_CONTRACT_VERSION, projectId: PROJECT, idempotencyKey: IDEMPOTENCY };
  const drift = fixture({
    resolveEligibility: async value => value.lookIdentityIds
      ? { lookBindings: [...bindings].reverse(), eligibilityRevision: revision }
      : { eligibleLooks: [] },
  });
  const driftRes = response();
  await drift.handler(request('POST', { body: quoteBody }), driftRes);
  assert.equal(driftRes.statusCode, 409);
  assert.equal(driftRes.body.code, 'luxify_look_unavailable');

  const disabled = fixture({ environment: activeEnv({ [LUXIFY_FEATURE_FLAG]: 'false' }) });
  const disabledRes = response();
  await disabled.handler(request('POST', { body: quoteBody }), disabledRes);
  assert.equal(disabledRes.statusCode, 503);
  assert.deepEqual(disabledRes.body.reasons, ['feature_disabled']);

  const revoked = fixture({ authorizePremium: async () => { throw Object.assign(new Error('revoked'), { statusCode: 403 }); } });
  const revokedRes = response();
  await revoked.handler(request('POST', { body: quoteBody }), revokedRes);
  assert.equal(revokedRes.statusCode, 403);
  assert.equal(revokedRes.body.code, 'luxify_premium_required');
});

test('recovery returns an exact existing request while activation is disabled and never creates work', async () => {
  const existingJob = { id: 'job-existing', status: 'provider_submitted', title: draft.title, projectId: PROJECT };
  const { handler, calls } = fixture({
    environment: { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN },
    existingJob,
  });
  const query = `?contractVersion=${LUXIFY_CONTRACT_VERSION}&projectId=${PROJECT}&idempotencyKey=${IDEMPOTENCY}`;
  const res = response();
  await handler(request('GET', { query }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.existingJob, existingJob);
  assert.deepEqual(calls.recover, [{
    accountId: ACCOUNT,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
  }]);
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.eligibility.length, 0);
  assert.equal(calls.runtime.length, 0);
  assert.equal(calls.save.length, 0);

  const quoteRecovery = response();
  await handler(request('POST', {
    body: {
      action: 'quote',
      contractVersion: LUXIFY_CONTRACT_VERSION,
      projectId: PROJECT,
      idempotencyKey: IDEMPOTENCY,
    },
  }), quoteRecovery);
  assert.equal(quoteRecovery.statusCode, 200);
  assert.equal(quoteRecovery.body.recovered, true);
  assert.deepEqual(quoteRecovery.body.existingJob, existingJob);
  assert.equal(calls.runtime.length, 0);
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.eligibility.length, 0);

  const partial = response();
  await handler(request('GET', { query: `?projectId=${PROJECT}` }), partial);
  assert.equal(partial.statusCode, 400);
});

test('authentication, same-origin JSON, and account rate limits fail before repository work', async () => {
  const unauthenticated = fixture({ authenticate: () => null });
  const authRes = response();
  await unauthenticated.handler(request(), authRes);
  assert.equal(authRes.statusCode, 401);

  const crossOrigin = fixture();
  const originRes = response();
  await crossOrigin.handler(request('POST', {
    body: { action: 'save-project', ...draft },
    headers: { origin: 'https://other.example' },
  }), originRes);
  assert.equal(originRes.statusCode, 403);

  const limited = fixture({ rateLimit: async () => false });
  const limitedRes = response();
  await limited.handler(request(), limitedRes);
  assert.equal(limitedRes.statusCode, 429);
  assert.equal(limited.calls.recover.length, 0);
  assert.equal(limited.calls.save.length, 0);
});

test('workspace and Vercel route the dedicated LUXIFY endpoint without exposing it anonymously', async () => {
  const res = response();
  await workspaceHandler({ method: 'GET', url: '/api/video-os-lite/luxify', headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'sign_in_required');

  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    config.routes.find(route => route.src === '/api/video-os-lite/luxify'),
    { src: '/api/video-os-lite/luxify', dest: '/api/video-os-lite/workspace.js' },
  );
});
