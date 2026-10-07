import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PREMIUM_SCRIPTED_PHOTO_CREDITS,
  SCRIPTED_PHOTO_CONTRACT_VERSION,
  assertScriptedPhotoHeygenInput,
  renderTierForJob,
  renderTierForReservation,
  durableProviderSubmissionPossibleMessage,
  durableHeygenPreclaimMessage,
  parseDurableRenderFailure,
  scriptedPhotoActivation,
  validateScriptedPhotoTransport,
} from '../lib/scripted-photo-contract.js';

const accountId = 'scripted-photo-owner';
const jobId = 'scripted-photo-job';

function authorization(tier) {
  return {
    version: 1,
    accountId,
    tier,
    entitlementKey: tier === 'standard' ? 'standardRendering' : 'liveRendering',
    sourceType: 'test_fixture',
    sourceId: null,
    jobId,
  };
}

function scriptedJob(tier = 'STANDARD', overrides = {}) {
  const normalizedTier = tier.toLowerCase();
  return {
    id: jobId,
    accountId,
    provider: 'heygen',
    costCredits: tier === 'STANDARD' ? 37 : PREMIUM_SCRIPTED_PHOTO_CREDITS,
    input: {
      contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
      tier,
      renderAuthorization: authorization(normalizedTier),
    },
    ...overrides,
  };
}

test('scripted-photo activation is explicitly gated and Standard pricing has no default', () => {
  for (const env of [
    {},
    { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'false', VIDEO_OS_STANDARD_SCRIPTED_CREDITS: '37' },
  ]) {
    assert.throws(() => scriptedPhotoActivation('STANDARD', env), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  }

  for (const value of [undefined, '', '0', '-1', '1.5', 'not-a-number']) {
    assert.throws(
      () => scriptedPhotoActivation('STANDARD', { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true', VIDEO_OS_STANDARD_SCRIPTED_CREDITS: value }),
      { statusCode: 503, failureCategory: 'CONFIG_MISSING' },
    );
  }
  assert.throws(() => scriptedPhotoActivation('toString', { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true' }), { statusCode: 400 });

  assert.deepEqual(
    scriptedPhotoActivation('STANDARD', { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true', VIDEO_OS_STANDARD_SCRIPTED_CREDITS: '37' }),
    { tier: 'standard', provider: 'heygen', costCredits: 37 },
  );
  assert.deepEqual(
    scriptedPhotoActivation('PREMIUM', { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true' }),
    { tier: 'premium', provider: 'heygen', costCredits: 90 },
  );
});

test('new scripted-photo jobs derive tier from their durable binding, never from HeyGen', () => {
  assert.equal(renderTierForJob(scriptedJob('STANDARD')), 'standard');
  assert.equal(renderTierForJob(scriptedJob('PREMIUM')), 'premium');

  const malformed = [
    scriptedJob('STANDARD', { provider: 'sadtalker' }),
    scriptedJob('STANDARD', { input: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD' } }),
    scriptedJob('STANDARD', { input: { ...scriptedJob('STANDARD').input, tier: 'PREMIUM' } }),
    scriptedJob('STANDARD', { input: { ...scriptedJob('STANDARD').input, renderAuthorization: authorization('premium') } }),
    scriptedJob('STANDARD', { input: { ...scriptedJob('STANDARD').input, contractVersion: 'scripted-photo-v2' } }),
  ];
  for (const job of malformed) assert.throws(() => renderTierForJob(job), { failureCategory: 'RECONCILIATION' });
});

test('provider-derived fallback remains legacy-only and ignores arbitrary legacy input tier', () => {
  assert.equal(renderTierForJob({ provider: 'heygen', input: { tier: 'STANDARD' } }), 'premium');
  assert.equal(renderTierForJob({ provider: 'sadtalker', input: { tier: 'PREMIUM' } }), 'standard');
  assert.throws(() => renderTierForJob({ provider: 'unknown', input: {} }), { failureCategory: 'RECONCILIATION' });
});

test('reservation tier is explicit for scripted-photo and provider-derived only for legacy', () => {
  assert.equal(renderTierForReservation({ provider: 'heygen', tier: 'standard', input: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD' } }), 'standard');
  assert.throws(() => renderTierForReservation({ provider: 'heygen', input: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD' } }), { failureCategory: 'RECONCILIATION' });
  assert.throws(() => renderTierForReservation({ provider: 'heygen', tier: 'premium', input: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD' } }), { failureCategory: 'RECONCILIATION' });
  assert.equal(renderTierForReservation({ provider: 'heygen', input: { tier: 'STANDARD' } }), 'premium');
});

test('scripted-photo transport requires the configured same origin and JSON', () => {
  const env = { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example' };
  assert.doesNotThrow(() => validateScriptedPhotoTransport({ headers: { origin: 'https://video.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, env));
  assert.throws(() => validateScriptedPhotoTransport({ headers: { origin: 'https://other.example', 'content-type': 'application/json' } }, env), { statusCode: 403 });
  assert.throws(() => validateScriptedPhotoTransport({ headers: { origin: 'https://video.example', 'content-type': 'text/plain' } }, env), { statusCode: 400 });
});

test('scripted-photo HeyGen input is fully buildable before provider claim', () => {
  const job = scriptedJob('STANDARD', {
    title: 'Scripted proof',
    format: 'vertical',
    input: {
      ...scriptedJob('STANDARD').input,
      script: 'A bounded script.',
      avatar: { avatarId: 'avatar-1' },
      voice: { voiceId: 'voice-1' },
      sourceBinding: { provider: 'heygen', providerRenderableAvatarId: 'avatar-1', providerVoiceId: 'voice-1' },
    },
  });
  assert.doesNotThrow(() => assertScriptedPhotoHeygenInput(job, {}));
  for (const input of [
    { ...job.input, avatar: undefined },
    { ...job.input, voice: { voiceId: 'invalid provider id with spaces' } },
    { ...job.input, script: '' },
    { ...job.input, productionKit: { overlay: 'client-controlled' } },
    { ...job.input, avatar: { avatarId: 'different' } },
  ]) assert.throws(() => assertScriptedPhotoHeygenInput({ ...job, input }), { failureCategory: 'VALIDATION' });
  for (const timeout of ['NaN', '0', '2147483648']) {
    assert.throws(() => assertScriptedPhotoHeygenInput(job, { HEYGEN_TIMEOUT_MS: timeout }), { failureCategory: 'CONFIG_MISSING' });
  }
});

test('scripted-photo repository binds the avatar group through reservation and provider claim', () => {
  const source = readFileSync(new URL('../db/repositories.js', import.meta.url), 'utf8');
  assert.match(source, /providerAvatarGroupId:\s*identity\.providerAvatarGroupId/);
  assert.match(source, /kind:\s*'avatar_group',\s*providerResourceId:\s*groupId/);
  assert.match(source, /kind:\s*'avatar_group',\s*providerResourceId:\s*current\.input\.sourceBinding\?\.providerAvatarGroupId/);
  assert.match(source, /avatarGroupId:\s*current\.input\?\.sourceBinding\?\.providerAvatarGroupId\s*\|\|\s*null/);
});

test('durable render failure codes survive Error property stripping and reject untrusted variants', () => {
  const sharedPreclaim = durableHeygenPreclaimMessage('ENTITLEMENT');
  const possible = durableProviderSubmissionPossibleMessage();
  assert.deepEqual(parseDurableRenderFailure(new Error(sharedPreclaim)), { kind: 'heygen-preclaim', failureCategory: 'ENTITLEMENT' });
  assert.deepEqual(parseDurableRenderFailure(new Error(possible)), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  for (const message of [
    `${sharedPreclaim}:extra`,
    'VIDEO_OS_HEYGEN_PRECLAIM_V1:MADE_UP',
    'video_os_provider_submission_possible_v1',
    '',
  ]) assert.equal(parseDurableRenderFailure(new Error(message)), null);
});
