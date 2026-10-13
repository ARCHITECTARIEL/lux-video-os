import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { assertPersistedLuxifyJob, hasLuxifyJobMarker } from '../lib/luxify-job-binding.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';

const ACCOUNT = 'luxify-job-binding-owner';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY = '22222222-2222-4222-8222-222222222222';
const LOOK_A = '33333333-3333-4333-8333-333333333333';
const LOOK_B = '44444444-4444-4444-8444-444444444444';
const SECRET = 'luxify-job-binding-secret-at-least-32-bytes';
const ENV = { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
const NOW = Date.parse('2026-10-11T18:00:00.000Z');
const LOOK_BINDINGS = [
  { identityId: LOOK_A, providerLookId: 'look_a' },
  { identityId: LOOK_B, providerLookId: 'look_b' },
];
const REVISION = 'luxify-look-eligibility-v1:canary:job-binding-r1';

function validJob() {
  const binding = {
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: 'LUXIFY strict job binding',
    prompt: 'A cinematic tracking shot with generated ambient audio.',
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  };
  const token = issueLuxifyQuote(binding, {
    secret: SECRET,
    env: ENV,
    now: NOW,
    nonce: 'luxify-job-binding-nonce-123456789',
  }).token;
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, binding, { secret: SECRET, env: ENV, now: NOW }));
  const id = 'job-luxify-strict-binding';
  return {
    id,
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    provider: 'heygen',
    format: 'landscape',
    title: binding.title,
    costCredits: 41,
    input: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      projectId: PROJECT,
      idempotencyKey: IDEMPOTENCY,
      title: binding.title,
      prompt: binding.prompt,
      lookIdentityIds: [LOOK_A, LOOK_B],
      aspectRatio: binding.aspectRatio,
      resolution: binding.resolution,
      durationSeconds: binding.durationSeconds,
      lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
      eligibleLookIds: LOOK_BINDINGS.map(value => value.providerLookId),
      eligibilityRevision: REVISION,
      quoteProof,
      renderAuthorization: {
        version: 1,
        accountId: ACCOUNT,
        tier: 'premium',
        entitlementKey: 'liveRendering',
        sourceType: 'admin_tester_grant',
        sourceId: null,
        jobId: id,
      },
    },
  };
}

function rejected(job) {
  return assert.throws(() => assertPersistedLuxifyJob(job), error => {
    assert.equal(error.code, 'LUXIFY_JOB_BINDING_INVALID');
    assert.equal(error.validationCode, 'LUXIFY_JOB_BINDING_INVALID');
    assert.equal(error.failureCategory, 'FINAL_MEDIA_VALIDATION');
    return true;
  });
}

test('strict LUXIFY binding returns only canonical signed intent authority', () => {
  const job = validJob();
  const result = assertPersistedLuxifyJob(job);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.intent.projectId, PROJECT);
  assert.equal(result.intent.idempotencyKey, IDEMPOTENCY);
  assert.deepEqual(result.lookBindings, LOOK_BINDINGS);
  assert.equal(result.eligibilityRevision, REVISION);
  assert.equal(result.quoteProof.luxCredits, 41);
  assert.equal(hasLuxifyJobMarker(job), true);
  assert.equal(hasLuxifyJobMarker({ provider: 'heygen', input: {} }), false);
});

test('quote proof is mandatory and bound to account, project, key, title, prompt, looks, revision, and cost', () => {
  for (const mutate of [
    job => { job.accountId = 'another-owner'; },
    job => { job.projectId = LOOK_A; },
    job => { job.idempotencyKey = LOOK_B; },
    job => { job.title = 'Changed title'; },
    job => { job.input.prompt = 'Changed prompt'; },
    job => { job.costCredits = 42; },
    job => { delete job.input.quoteProof; },
    job => { job.input.quoteProof = { ...job.input.quoteProof, promptSha256: 'f'.repeat(64) }; },
    job => { job.input.quoteProof = { ...job.input.quoteProof, prompt: 'must-not-persist' }; },
    job => { job.input.eligibilityRevision = REVISION + ':changed'; },
  ]) {
    const job = structuredClone(validJob());
    mutate(job);
    rejected(job);
  }
});

test('ordered identity/provider look bindings and provider-facing ID projection are exact', () => {
  for (const mutate of [
    job => { delete job.input.lookBindings; },
    job => { job.input.lookBindings.reverse(); },
    job => { job.input.lookBindings[0].providerLookId = 'changed_look'; },
    job => { job.input.lookBindings[0].extra = true; },
    job => { job.input.eligibleLookIds.reverse(); },
    job => { job.input.lookIdentityIds.reverse(); },
  ]) {
    const job = structuredClone(validJob());
    mutate(job);
    rejected(job);
  }
});

test('Presenter script, voice, avatar, production kit, and unknown fields are forbidden', () => {
  for (const [field, value] of Object.entries({
    script: 'Exact Presenter words are forbidden in LUXIFY.',
    voice: { voiceId: 'voice_1' },
    voiceId: 'voice_1',
    avatar: { avatarId: 'look_a' },
    productionKit: {},
    unknown: true,
  })) {
    const job = structuredClone(validJob());
    job.input[field] = value;
    rejected(job);
  }
});

test('mode, provider, format, and persisted Premium authorization must remain exact', () => {
  for (const mutate of [
    job => { job.provider = 'sadtalker'; },
    job => { job.format = 'vertical'; },
    job => { job.input.contractVersion = 'luxify-cinematic-v0'; },
    job => { job.input.renderMode = 'premium_presenter_v1'; },
    job => { job.input.providerCapability = 'avatar'; },
    job => { delete job.input.renderAuthorization; },
    job => { job.input.renderAuthorization.tier = 'standard'; },
    job => { job.input.renderAuthorization.jobId = 'another-job'; },
    job => { job.input.renderAuthorization.extra = true; },
  ]) {
    const job = structuredClone(validJob());
    mutate(job);
    rejected(job);
  }
});
