import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { finalOutputPath } from '../lib/video-os-output-acceptance.js';
import { PRIVATE_BLOB_CLASSIFICATIONS } from '../lib/video-os-private-blob.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';
import { validateFinalMedia } from '../services/final-media-validation.js';
import { finishLuxifyMedia } from '../services/luxify-finisher.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY = '22222222-2222-4222-8222-222222222222';
const IDENTITY = '33333333-3333-4333-8333-333333333333';
const LOOK_BINDINGS = [Object.freeze({ identityId: IDENTITY, providerLookId: 'look_a' })];
const ELIGIBILITY_REVISION = 'luxify-look-eligibility-v1:canary:finisher-r1';
const QUOTE_ENV = { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
const QUOTE_SECRET = 'luxify-finisher-quote-secret-at-least-32-bytes';
const title = 'LUXIFY Generated Audio Proof';
const prompt = 'A cinematic provider clip with generated ambient audio.';
const quoteBinding = {
  accountId: 'account-luxify-finisher-proof',
  projectId: PROJECT,
  idempotencyKey: IDEMPOTENCY,
  title,
  prompt,
  lookBindings: LOOK_BINDINGS,
  eligibilityRevision: ELIGIBILITY_REVISION,
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 4,
};
const quoteToken = issueLuxifyQuote(quoteBinding, {
  secret: QUOTE_SECRET,
  env: QUOTE_ENV,
  now: Date.parse('2026-10-11T18:00:00.000Z'),
  nonce: 'luxify-finisher-nonce-123456789',
}).token;
const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(quoteToken, quoteBinding, {
  secret: QUOTE_SECRET,
  env: QUOTE_ENV,
  now: Date.parse('2026-10-11T18:00:00.000Z'),
}));

const job = Object.freeze({
  id: 'job-luxify-finisher-proof',
  accountId: 'account-luxify-finisher-proof',
  projectId: PROJECT,
  idempotencyKey: IDEMPOTENCY,
  provider: 'heygen',
  format: 'landscape',
  title,
  costCredits: 41,
  input: Object.freeze({
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title,
    prompt,
    lookIdentityIds: Object.freeze([IDENTITY]),
    resolution: '720p',
    aspectRatio: '16:9',
    durationSeconds: 4,
    lookBindings: Object.freeze(LOOK_BINDINGS),
    eligibleLookIds: Object.freeze(['look_a']),
    eligibilityRevision: ELIGIBILITY_REVISION,
    quoteProof,
    renderAuthorization: Object.freeze({
      version: 1,
      accountId: 'account-luxify-finisher-proof',
      tier: 'premium',
      entitlementKey: 'liveRendering',
      sourceType: 'admin_tester_grant',
      sourceId: null,
      jobId: 'job-luxify-finisher-proof',
    }),
  }),
});

let directory;
let validMedia;
let videoOnlyMedia;

function makeMedia(output, { audio = true } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1b263b:s=1280x720:r=2:d=4',
  ];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=8000:duration=4');
  args.push('-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '32k', '-shortest');
  args.push('-movflags', '+faststart', output);
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, `fixture ffmpeg failed: ${String(result.stderr).slice(-500)}`);
}

async function downloadFixture(fixture, _sourceUrl, target) {
  await copyFile(fixture, target);
  return (await stat(target)).size;
}

before(async () => {
  assert.ok(ffmpegPath, 'ffmpeg-static must provide its bundled binary');
  directory = await mkdtemp(join(tmpdir(), 'luxify-finisher-fixtures-'));
  validMedia = join(directory, 'valid.mp4');
  videoOnlyMedia = join(directory, 'video-only.mp4');
  makeMedia(validMedia);
  makeMedia(videoOnlyMedia, { audio: false });
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('LUXIFY validates then stores the exact provider bytes without replacing generated audio', async () => {
  const lifecycle = [];
  let stagedPath;
  let stored;
  let writeOptions;
  let classification;
  let requestedPath;
  const source = await readFile(validMedia);
  const sourceHash = createHash('sha256').update(source).digest('hex');

  const artifact = await finishLuxifyMedia(job, 'https://provider.invalid/luxify.mp4', {
    downloadProviderMedia: async (url, target) => {
      lifecycle.push('download');
      stagedPath = target;
      return downloadFixture(validMedia, url, target);
    },
    validateFinalMedia: async (...args) => {
      lifecycle.push('validate');
      return validateFinalMedia(...args);
    },
    putPrivateBlob: async (kind, pathname, body, options) => {
      lifecycle.push('store');
      classification = kind;
      requestedPath = pathname;
      writeOptions = options;
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      stored = Buffer.concat(chunks);
      return { pathname, created: true };
    },
  });

  assert.deepEqual(lifecycle, ['download', 'validate', 'store']);
  assert.deepEqual(stored, source, 'the provider MP4 and generated audio must remain byte-identical');
  assert.equal(classification, PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO);
  assert.equal(requestedPath, finalOutputPath(job.accountId, job.id, sourceHash));
  assert.deepEqual(writeOptions, { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: false });
  assert.equal(artifact.privatePathname, requestedPath);
  assert.equal(artifact.sha256, sourceHash);
  assert.equal(artifact.bytes, source.length);
  assert.equal(artifact.sourceBytes, source.length);
  assert.equal(artifact.sourceDurationMs, 4_000);
  assert.equal(artifact.width, 1280);
  assert.equal(artifact.height, 720);
  assert.equal(artifact.acceptance.media.audioCodec, 'aac');
  assert.equal(artifact.acceptance.renderMode, LUXIFY_RENDER_MODE);
  await assert.rejects(stat(stagedPath), { code: 'ENOENT' });
});

test('LUXIFY decode failure never reaches private storage and cleans temporary bytes', async () => {
  let stagedPath;
  let writes = 0;
  await assert.rejects(
    finishLuxifyMedia(job, 'https://provider.invalid/video-only.mp4', {
      downloadProviderMedia: async (url, target) => {
        stagedPath = target;
        return downloadFixture(videoOnlyMedia, url, target);
      },
      putPrivateBlob: async () => { writes += 1; },
    }),
    error => error.failureCategory === 'FINAL_MEDIA_VALIDATION' && error.validationCode === 'AUDIO_STREAM_REQUIRED',
  );
  assert.equal(writes, 0);
  await assert.rejects(stat(stagedPath), { code: 'ENOENT' });
});

test('an identical LUXIFY retry targets one immutable content-addressed object', async () => {
  const objects = new Map();
  const writes = [];
  const run = () => finishLuxifyMedia(job, 'https://provider.invalid/luxify.mp4', {
    downloadProviderMedia: (url, target) => downloadFixture(validMedia, url, target),
    putPrivateBlob: async (_kind, pathname, body, options) => {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const existing = objects.get(pathname);
      if (existing) assert.deepEqual(existing, bytes);
      else objects.set(pathname, bytes);
      writes.push({ pathname, options });
      return { pathname, created: !existing };
    },
  });

  const first = await run();
  const replay = await run();
  assert.equal(first.privatePathname, replay.privatePathname);
  assert.equal(first.sha256, replay.sha256);
  assert.equal(objects.size, 1);
  assert.deepEqual(writes.map(value => value.pathname), [first.privatePathname, first.privatePathname]);
  for (const write of writes) {
    assert.equal(write.options.addRandomSuffix, false);
    assert.equal(write.options.allowOverwrite, false);
  }
});

test('non-LUXIFY jobs fail before download or storage', async () => {
  let calls = 0;
  await assert.rejects(
    finishLuxifyMedia({ ...job, input: {} }, 'https://provider.invalid/not-luxify.mp4', {
      downloadProviderMedia: async () => { calls += 1; },
      putPrivateBlob: async () => { calls += 1; },
    }),
    error => error.code === 'LUXIFY_JOB_BINDING_INVALID' && error.failureCategory === 'FINAL_MEDIA_VALIDATION',
  );
  assert.equal(calls, 0);
});

test('malformed persisted LUXIFY jobs fail before provider download', async () => {
  for (const mutate of [
    value => { delete value.input.quoteProof; },
    value => { delete value.input.lookBindings; },
    value => { value.input.script = 'Presenter words must not enter LUXIFY.'; },
    value => { value.input.voice = { voiceId: 'voice_1' }; },
  ]) {
    const malformed = structuredClone(job);
    mutate(malformed);
    let calls = 0;
    await assert.rejects(
      finishLuxifyMedia(malformed, 'https://provider.invalid/malformed.mp4', {
        downloadProviderMedia: async () => { calls += 1; },
        putPrivateBlob: async () => { calls += 1; },
      }),
      error => error.code === 'LUXIFY_JOB_BINDING_INVALID' && error.failureCategory === 'FINAL_MEDIA_VALIDATION',
    );
    assert.equal(calls, 0);
  }
});
