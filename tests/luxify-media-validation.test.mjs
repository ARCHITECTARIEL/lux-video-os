import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  luxifyFormatForAspectRatio,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';
import { luxifyMediaExpectations, validateFinalMedia } from '../services/final-media-validation.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY = '22222222-2222-4222-8222-222222222222';
const IDENTITY = '33333333-3333-4333-8333-333333333333';
const LOOK_BINDINGS = [Object.freeze({ identityId: IDENTITY, providerLookId: 'look_a' })];
const ELIGIBILITY_REVISION = 'luxify-look-eligibility-v1:canary:media-r1';
const QUOTE_ENV = { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
const QUOTE_SECRET = 'luxify-media-quote-secret-at-least-32-bytes';
const QUOTE_NOW = Date.parse('2026-10-11T18:00:00.000Z');

let directory;
let valid720;
let videoOnly720;
let unsupportedCodec720;

function luxifyJob(overrides = {}) {
  const requested = {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: 'LUXIFY media validation proof',
    prompt: 'A cinematic validation scene with generated ambient audio.',
    lookIdentityIds: [IDENTITY],
    resolution: '720p',
    aspectRatio: '16:9',
    durationSeconds: 4,
    ...(overrides.input || {}),
  };
  const resolution = ['720p', '1080p'].includes(requested.resolution) ? requested.resolution : '720p';
  const aspectRatio = ['16:9', '9:16', '1:1'].includes(requested.aspectRatio) ? requested.aspectRatio : '16:9';
  const durationSeconds = Number.isInteger(requested.durationSeconds) && requested.durationSeconds >= 4 && requested.durationSeconds <= 15
    ? requested.durationSeconds : 4;
  const binding = {
    accountId: 'account-luxify-media-proof',
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: requested.title,
    prompt: requested.prompt,
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: ELIGIBILITY_REVISION,
    aspectRatio,
    resolution,
    durationSeconds,
  };
  const token = issueLuxifyQuote(binding, {
    secret: QUOTE_SECRET,
    env: QUOTE_ENV,
    now: QUOTE_NOW,
    nonce: 'luxify-media-nonce-123456789',
  }).token;
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, binding, { secret: QUOTE_SECRET, env: QUOTE_ENV, now: QUOTE_NOW }));
  const input = {
    ...requested,
    lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
    eligibleLookIds: ['look_a'],
    eligibilityRevision: ELIGIBILITY_REVISION,
    quoteProof,
    renderAuthorization: {
      version: 1,
      accountId: 'account-luxify-media-proof',
      tier: 'premium',
      entitlementKey: 'liveRendering',
      sourceType: 'admin_tester_grant',
      sourceId: null,
      jobId: 'job-luxify-media-proof',
    },
  };
  return {
    id: 'job-luxify-media-proof',
    accountId: 'account-luxify-media-proof',
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    provider: 'heygen',
    format: luxifyFormatForAspectRatio(aspectRatio),
    title: requested.title,
    costCredits: resolution === '720p' ? 41 : 97,
    input,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'input')),
  };
}

function makeMedia(output, { audio = true } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x14213d:s=1280x720:r=2:d=4',
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4');
  args.push('-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '32k', '-shortest');
  args.push('-movflags', '+faststart', output);
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, `fixture ffmpeg failed: ${String(result.stderr).slice(-500)}`);
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.failureCategory, 'FINAL_MEDIA_VALIDATION');
    assert.equal(error.validationCode, code);
    return true;
  });
}

before(async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static must provide its bundled binary');
  directory = await mkdtemp(join(tmpdir(), 'luxify-media-validation-'));
  valid720 = join(directory, 'valid-720p.mp4');
  videoOnly720 = join(directory, 'video-only-720p.mp4');
  unsupportedCodec720 = join(directory, 'unsupported-codec-720p.mp4');
  makeMedia(valid720);
  makeMedia(videoOnly720, { audio: false });
  const converted = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', valid720,
    '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'copy', unsupportedCodec720,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(converted.status, 0, `codec fixture ffmpeg failed: ${String(converted.stderr).slice(-500)}`);
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('LUXIFY dimension policy covers every supported resolution and aspect ratio', () => {
  const expected = {
    '720p': { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] },
    '1080p': { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] },
  };
  for (const [resolution, ratios] of Object.entries(expected)) {
    for (const [aspectRatio, dimensions] of Object.entries(ratios)) {
      const policy = luxifyMediaExpectations(luxifyJob({ input: { resolution, aspectRatio } }));
      assert.deepEqual(policy.expectedDimensions, dimensions);
      assert.equal(policy.expectedDurationMs, 4_000);
    }
  }
});

test('LUXIFY fully decodes H.264/AAC and derives duration authority from persisted input', async () => {
  const job = luxifyJob();
  const accepted = await validateFinalMedia(valid720, { job, expectedDurationMs: 12_000 });
  assert.equal(accepted.width, 1280);
  assert.equal(accepted.height, 720);
  assert.ok(Math.abs(accepted.durationMs - 4_000) <= 500);
  assert.equal(accepted.acceptance.renderMode, LUXIFY_RENDER_MODE);
  assert.equal(accepted.acceptance.providerCapability, LUXIFY_PROVIDER_CAPABILITY);
  assert.equal(accepted.acceptance.resolution, '720p');
  assert.equal(accepted.acceptance.aspectRatio, '16:9');
  assert.equal(accepted.acceptance.media.expectedDurationMs, 4_000);
  assert.equal(accepted.acceptance.media.videoStreams, 1);
  assert.equal(accepted.acceptance.media.audioStreams, 1);
  assert.equal(accepted.acceptance.media.videoCodec, 'h264');
  assert.equal(accepted.acceptance.media.audioCodec, 'aac');

  const revalidated = await validateFinalMedia(valid720, { job, expectedDurationMs: accepted.durationMs });
  assert.equal(revalidated.sha256, accepted.sha256);
  assert.equal(revalidated.acceptance.privatePathname, accepted.acceptance.privatePathname);
});

test('LUXIFY media policy rejects incomplete or inconsistent persisted bindings before decode', async () => {
  for (const [job, code] of [
    [luxifyJob({ input: { renderMode: 'luxify_cinematic_v0' } }), 'LUXIFY_JOB_BINDING_INVALID'],
    [luxifyJob({ input: { providerCapability: 'avatar' } }), 'LUXIFY_JOB_BINDING_INVALID'],
    [luxifyJob({ input: { durationSeconds: 3 } }), 'LUXIFY_JOB_BINDING_INVALID'],
    [luxifyJob({ input: { durationSeconds: 16 } }), 'LUXIFY_JOB_BINDING_INVALID'],
    [luxifyJob({ input: { resolution: '4k' } }), 'LUXIFY_JOB_BINDING_INVALID'],
    [luxifyJob({ format: 'vertical' }), 'LUXIFY_JOB_BINDING_INVALID'],
  ]) await rejectsWithCode(validateFinalMedia(valid720, { job }), code);
});

test('LUXIFY settlement binding rejects missing authority and Presenter fields before file access', async () => {
  const unavailable = join(directory, 'must-not-be-opened.mp4');
  for (const mutate of [
    job => { delete job.input.quoteProof; },
    job => { delete job.input.lookBindings; },
    job => { job.input.script = 'Presenter words are forbidden.'; },
    job => { job.input.voice = { voiceId: 'voice_1' }; },
  ]) {
    const job = structuredClone(luxifyJob());
    mutate(job);
    await rejectsWithCode(validateFinalMedia(unavailable, { job }), 'LUXIFY_JOB_BINDING_INVALID');
  }
});

test('LUXIFY rejects wrong dimensions and duration drift against persisted intent', async () => {
  await rejectsWithCode(
    validateFinalMedia(valid720, { job: luxifyJob({ input: { resolution: '1080p' } }) }),
    'DIMENSIONS_MISMATCH',
  );
  await rejectsWithCode(
    validateFinalMedia(valid720, { job: luxifyJob({ input: { durationSeconds: 10 } }) }),
    'DURATION_MISMATCH',
  );
});

test('LUXIFY rejects missing generated audio and unsupported video codecs', async () => {
  await rejectsWithCode(validateFinalMedia(videoOnly720, { job: luxifyJob() }), 'AUDIO_STREAM_REQUIRED');
  await rejectsWithCode(validateFinalMedia(unsupportedCodec720, { job: luxifyJob() }), 'CODEC_UNSUPPORTED');
});

test('LUXIFY support does not widen ordinary Presenter final dimensions', async () => {
  await rejectsWithCode(validateFinalMedia(valid720, {
    job: { id: 'presenter-job', accountId: 'presenter-account', provider: 'heygen', format: 'landscape', input: {} },
    expectedDurationMs: 4_000,
  }), 'DIMENSIONS_MISMATCH');
});
