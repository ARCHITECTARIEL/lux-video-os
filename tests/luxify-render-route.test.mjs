import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { handleLuxifyRender } from '../api/video-os-lite/render-v2.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote } from '../lib/luxify-quote.js';

const ACCOUNT = 'luxify-phase-two-owner';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY = '22222222-2222-4222-8222-222222222222';
const LOOK_A = '33333333-3333-4333-8333-333333333333';
const LOOK_B = '44444444-4444-4444-8444-444444444444';
const PROOF_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = 'luxify-phase-two-route-secret-at-least-32-bytes';
const NOW = Date.parse('2026-10-11T20:00:00.000Z');
const REVISION = 'luxify-look-eligibility-v1:canary:phase-two-route';
const LOOK_BINDINGS = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'server_look_a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'server_look_b' }),
]);
const ENV = Object.freeze({
  VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example',
  VIDEO_OS_LUXIFY_ENABLED: 'true',
  VIDEO_OS_LUXIFY_ACCOUNT_ID: ACCOUNT,
  VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41',
  VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97',
});

const PROJECT_RECORD = Object.freeze({
  id: PROJECT,
  contractVersion: LUXIFY_CONTRACT_VERSION,
  title: 'LUXIFY phase two route',
  prompt: 'A cinematic tracking shot with provider generated ambient sound.',
  lookIdentityIds: Object.freeze([LOOK_A, LOOK_B]),
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
});

function quoteToken() {
  return issueLuxifyQuote({
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: PROJECT_RECORD.title,
    prompt: PROJECT_RECORD.prompt,
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: PROJECT_RECORD.aspectRatio,
    resolution: PROJECT_RECORD.resolution,
    durationSeconds: PROJECT_RECORD.durationSeconds,
  }, {
    secret: SECRET,
    env: ENV,
    now: NOW,
    nonce: 'luxify-phase-two-route-nonce-123456789',
  }).token;
}

function body(overrides = {}) {
  return {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: PROJECT_RECORD.title,
    prompt: PROJECT_RECORD.prompt,
    lookIdentityIds: [LOOK_A, LOOK_B],
    aspectRatio: PROJECT_RECORD.aspectRatio,
    resolution: PROJECT_RECORD.resolution,
    durationSeconds: PROJECT_RECORD.durationSeconds,
    quoteToken: quoteToken(),
    ...overrides,
  };
}

function request() {
  return {
    headers: {
      origin: ENV.VIDEO_OS_PUBLIC_ORIGIN,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
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

function account() {
  return {
    user: { id: ACCOUNT, name: 'LUXIFY owner', role: 'owner' },
    credits: { balance: 500, reserved: 41 },
    entitlements: { liveRendering: true },
  };
}

function dependencies(state, overrides = {}) {
  return {
    environment: ENV,
    projectRepository: {
      getProject: async (accountId, projectId) => {
        state.projectReads.push({ accountId, projectId });
        return PROJECT_RECORD;
      },
    },
    runtimePreflight: async () => ({ ready: true, reasons: [] }),
    authorizePremium: async (accountId, tier) => {
      state.authorizations.push({ accountId, tier });
      return { tier };
    },
    resolveEligibility: async input => {
      state.eligibilityReads.push(input);
      return {
        lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
        eligibilityRevision: REVISION,
      };
    },
    quoteOptions: { secret: SECRET, now: NOW },
    resolveLuxifyAuthority: async input => {
      state.authorityReads.push(input);
      return {
        lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
        eligibilityRevision: REVISION,
      };
    },
    reserve: async function reserve(reservation, trusted) {
      state.reservations.push({ reservation, argumentCount: arguments.length });
      const authority = await trusted.resolveLuxifyAuthority({
        phase: 'reservation',
        accountId: reservation.accountId,
        projectId: reservation.input.projectId,
        lookIdentityIds: [...reservation.input.lookIdentityIds],
      });
      const job = {
        id: reservation.jobId,
        accountId: reservation.accountId,
        projectId: reservation.input.projectId,
        idempotencyKey: reservation.idempotencyKey,
        correlationId: reservation.correlationId,
        provider: reservation.provider,
        status: 'reserved',
        title: reservation.title,
        format: reservation.format,
        costCredits: reservation.costCredits,
        input: {
          ...reservation.input,
          lookBindings: authority.lookBindings,
          eligibleLookIds: authority.lookBindings.map(value => value.providerLookId),
          eligibilityRevision: authority.eligibilityRevision,
        },
        output: {},
      };
      state.job = job;
      return { job, replayed: false, proofId: PROOF_ID };
    },
    ensureAccountRecord: async () => account(),
    claimStart: async () => {
      state.job = { ...state.job, status: 'workflow_started' };
      return state.job;
    },
    getJobRecord: async () => state.job,
    shouldDispatch: () => false,
    ...overrides,
  };
}

function state() {
  return {
    projectReads: [],
    authorizations: [],
    eligibilityReads: [],
    authorityReads: [],
    reservations: [],
    job: null,
  };
}

test('LUXIFY render reloads exact intent and reserves only server-owned mode, price, correlation, and look authority', async () => {
  const observed = state();
  const res = response();
  await handleLuxifyRender(
    request(),
    res,
    { accountId: ACCOUNT, email: 'owner@example.test' },
    body(),
    'diagnostic-request-id',
    dependencies(observed),
  );

  assert.equal(res.statusCode, 202);
  assert.equal(res.headers['X-Request-Id'], 'diagnostic-request-id');
  assert.equal(res.body.proofId, PROOF_ID);
  assert.equal(res.body.job.mode, 'luxify');
  assert.equal(res.body.correlationId, observed.reservations[0].reservation.correlationId);
  assert.notEqual(res.body.correlationId, 'diagnostic-request-id');
  assert.match(res.body.correlationId, /^corr-[0-9a-f-]{36}$/i);
  assert.deepEqual(observed.projectReads, [{ accountId: ACCOUNT, projectId: PROJECT }]);
  assert.deepEqual(observed.authorizations, [{ accountId: ACCOUNT, tier: 'premium' }]);
  assert.deepEqual(observed.eligibilityReads[0].lookIdentityIds, [LOOK_A, LOOK_B]);
  assert.equal(observed.authorityReads[0].phase, 'reservation');

  const { reservation, argumentCount } = observed.reservations[0];
  assert.equal(argumentCount, 2);
  assert.equal(reservation.provider, 'heygen');
  assert.equal(reservation.tier, 'premium');
  assert.equal(reservation.costCredits, 41);
  assert.equal(reservation.format, 'landscape');
  assert.equal(reservation.input.renderMode, LUXIFY_RENDER_MODE);
  assert.equal(reservation.input.providerCapability, LUXIFY_PROVIDER_CAPABILITY);
  assert.equal(reservation.input.script, undefined);
  assert.equal(reservation.input.voice, undefined);
  assert.equal(reservation.input.avatar, undefined);
  assert.equal(reservation.input.lookBindings, undefined);
  assert.equal(reservation.input.eligibleLookIds, undefined);
  assert.equal(JSON.stringify(reservation).includes('server_look_a'), false);
});

test('saved-project drift and client provider fields fail before reservation', async () => {
  let observed = state();
  await assert.rejects(
    handleLuxifyRender(
      request(),
      response(),
      { accountId: ACCOUNT, email: 'owner@example.test' },
      body(),
      'request-project-drift',
      dependencies(observed, {
        projectRepository: {
          getProject: async () => ({ ...PROJECT_RECORD, prompt: 'Changed after quote.' }),
        },
      }),
    ),
    { code: 'LUXIFY_PROJECT_BINDING_CHANGED', statusCode: 409 },
  );
  assert.equal(observed.reservations.length, 0);

  for (const injected of [
    { providerLookId: 'client_look' },
    { eligibleLookIds: ['client_look'] },
    { provider: 'heygen' },
    { script: 'Presenter words are forbidden.' },
    { voice: { voiceId: 'client_voice' } },
  ]) {
    observed = state();
    await assert.rejects(
      handleLuxifyRender(
        request(),
        response(),
        { accountId: ACCOUNT, email: 'owner@example.test' },
        body(injected),
        'request-client-field',
        dependencies(observed),
      ),
      { code: 'invalid_request', statusCode: 400 },
    );
    assert.equal(observed.reservations.length, 0);
    assert.equal(observed.eligibilityReads.length, 0);
  }
});

test('route eligibility never becomes reservation authority outside the explicit test-only resolver', async () => {
  const observed = state();
  let reserveArgumentCount = 0;
  const deps = dependencies(observed, {
    resolveLuxifyAuthority: undefined,
    reserve: async function reserve() {
      reserveArgumentCount = arguments.length;
      throw Object.assign(new Error('Cinematic evidence is not persisted.'), {
        code: 'LUXIFY_CINEMATIC_CONSENT_PERSISTENCE_UNAVAILABLE',
        statusCode: 503,
        failureCategory: 'CONSENT',
      });
    },
  });
  await assert.rejects(
    handleLuxifyRender(
      request(),
      response(),
      { accountId: ACCOUNT, email: 'owner@example.test' },
      body(),
      'request-default-authority',
      deps,
    ),
    { code: 'LUXIFY_CINEMATIC_CONSENT_PERSISTENCE_UNAVAILABLE', statusCode: 503 },
  );
  assert.equal(reserveArgumentCount, 1);
  assert.equal(observed.eligibilityReads.length, 1);
  assert.equal(observed.authorityReads.length, 0);
});

test('expired or changed signed quotes fail before credit reservation', async () => {
  for (const changedBody of [
    body({ prompt: PROJECT_RECORD.prompt + ' changed' }),
    body({ quoteToken: quoteToken().slice(0, -1) + 'x' }),
  ]) {
    const observed = state();
    await assert.rejects(
      handleLuxifyRender(
        request(),
        response(),
        { accountId: ACCOUNT, email: 'owner@example.test' },
        changedBody,
        'request-quote-mismatch',
        dependencies(observed, changedBody.prompt === PROJECT_RECORD.prompt
          ? {}
          : { projectRepository: { getProject: async () => ({ ...PROJECT_RECORD, prompt: changedBody.prompt }) } }),
      ),
      error => ['LUXIFY_QUOTE_MISMATCH', 'LUXIFY_QUOTE_INVALID'].includes(error.code),
    );
    assert.equal(observed.reservations.length, 0);
  }
});
