import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import ffmpegPath from 'ffmpeg-static';

import { validateIdentityUpload } from '../lib/identity-upload.js';
import {
  DERIVATION_VERSION,
  ENROLLMENT_MEDIA_CONSENT_PURPOSE,
  ENROLLMENT_MEDIA_LIMITS,
  EnrollmentMediaError,
  prepareEnrollmentMedia,
} from '../services/enrollment-media.js';

let workdir;
let extractionRoot;
let baseMp4;
let validPayload;
let validMov;
let validWebm;
let videoOnly;
let audioOnly;
let silentMedia;
let oversizedDimensions;
let excessiveDuration;
let shortDuration;
let streamDurationMismatch;
let unsupportedCodec;
let excessiveFrameRate;
let excessivePixelArea;
let excessivePixelRate;
let longCompressedAudio;

function runFfmpeg(args, timeout = 90_000) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || `FFmpeg exited ${result.status}`);
}

function makeMp4(output, { duration = 5.2, size = '160x120', audioSource = `sine=frequency=440:sample_rate=48000:duration=${duration}`, rate = 5 } = {}) {
  runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
    '-f', 'lavfi', '-i', audioSource,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-f', 'mp4', output,
  ]);
}

function sha256(pathname) {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex');
}

function request(pathname, overrides = {}) {
  const sourceSha256 = overrides.expectedSha256 || sha256(pathname);
  return {
    filePath: pathname,
    expectedSha256: sourceSha256,
    consent: overrides.consent === undefined ? {
      granted: true,
      purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE,
      sourceSha256,
    } : overrides.consent,
    tempRoot: extractionRoot,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof EnrollmentMediaError);
    assert.equal(error.code, code);
    assert.equal(error.failureCategory, 'ENROLLMENT_MEDIA');
    assert.doesNotMatch(error.message, /lux-enrollment|\\|\//i);
    return true;
  });
}

async function largestTemporaryFile(root) {
  let largest = 0;
  try {
    for (const directory of await readdir(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const nested = path.join(root, directory.name);
      for (const entry of await readdir(nested, { withFileTypes: true })) {
        if (entry.isFile()) largest = Math.max(largest, (await stat(path.join(nested, entry.name))).size);
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return largest;
}

before(() => {
  assert.ok(ffmpegPath, 'ffmpeg-static must provide a bundled binary');
});

before(async () => {
  workdir = await mkdtemp(path.join(os.tmpdir(), 'lux-enrollment-test-'));
  extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'lux-enrollment-extract-'));
  baseMp4 = path.join(workdir, 'base.mp4');
  validPayload = path.join(workdir, 'phone-upload.payload');
  validMov = path.join(workdir, 'phone-upload.movdata');
  validWebm = path.join(workdir, 'phone-upload.webmdata');
  videoOnly = path.join(workdir, 'video-only.mp4');
  audioOnly = path.join(workdir, 'audio-only.mp4');
  silentMedia = path.join(workdir, 'silent.mp4');
  oversizedDimensions = path.join(workdir, 'oversized-dimensions.mp4');
  excessiveDuration = path.join(workdir, 'excessive-duration.mp4');
  shortDuration = path.join(workdir, 'short-duration.mp4');
  streamDurationMismatch = path.join(workdir, 'stream-duration-mismatch.mp4');
  unsupportedCodec = path.join(workdir, 'unsupported-codec.mp4');
  excessiveFrameRate = path.join(workdir, 'excessive-frame-rate.mp4');
  excessivePixelArea = path.join(workdir, 'excessive-pixel-area.mp4');
  excessivePixelRate = path.join(workdir, 'excessive-pixel-rate.mp4');
  longCompressedAudio = path.join(workdir, 'long-compressed-audio.webm');

  makeMp4(baseMp4);
  runFfmpeg(['-display_rotation', '90', '-i', baseMp4, '-map', '0', '-c', 'copy', '-f', 'mp4', validPayload]);
  runFfmpeg(['-i', baseMp4, '-map', '0', '-c', 'copy', '-f', 'mov', validMov]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=5.2',
    '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=5.2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libvpx-vp9', '-deadline', 'realtime',
    '-cpu-used', '8', '-b:v', '180k', '-c:a', 'libopus', '-shortest', '-f', 'webm', validWebm,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=5.2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-f', 'mp4', videoOnly,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5.2',
    '-c:a', 'aac', '-vn', '-f', 'mp4', audioOnly,
  ]);
  makeMp4(silentMedia, { audioSource: 'sine=frequency=440:sample_rate=48000:duration=5.2,volume=0.001' });
  makeMp4(oversizedDimensions, { size: '4100x16', rate: 1 });
  makeMp4(excessiveDuration, { duration: 60.5, size: '64x64', rate: 1 });
  makeMp4(shortDuration, { duration: 4 });
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=5.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mp4', streamDurationMismatch,
  ]);
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=5.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5.2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'mpeg4', '-q:v', '5',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mp4', unsupportedCodec,
  ]);
  makeMp4(excessiveFrameRate, { duration: 0.1, size: '64x64', rate: 121 });
  makeMp4(excessivePixelArea, { duration: 1.1, size: '3072x3072', rate: 1 });
  makeMp4(excessivePixelRate, { duration: 0.1, size: '3840x2160', rate: 61 });
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5:duration=5.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=120',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libvpx-vp9', '-deadline', 'realtime',
    '-cpu-used', '8', '-b:v', '80k', '-c:a', 'libopus', '-b:a', '12k',
    '-live', '1', '-f', 'webm', longCompressedAudio,
  ]);
});

after(async () => {
  await rm(workdir, { recursive: true, force: true });
  await rm(extractionRoot, { recursive: true, force: true });
});

test('real MP4 bytes with an unrelated extension produce compatible bounded enrollment audio', async () => {
  const result = await prepareEnrollmentMedia(request(validPayload));
  assert.equal(result.derivationVersion, DERIVATION_VERSION);
  assert.equal(result.audioMimeType, 'audio/wav');
  assert.equal(result.audioBytes, result.audioBuffer.length);
  assert.ok(result.audioBytes > 44 && result.audioBytes <= ENROLLMENT_MEDIA_LIMITS.maxAudioBytes);
  assert.equal(result.audioSha256, createHash('sha256').update(result.audioBuffer).digest('hex'));
  assert.equal(result.source.sha256, sha256(validPayload));
  assert.equal(result.source.container, 'mp4');
  assert.equal(result.source.mimeType, 'video/mp4');
  assert.equal(result.source.videoCodec, 'h264');
  assert.equal(result.source.audioCodec, 'aac');
  assert.equal(result.source.fullDecode, true);
  assert.equal(Math.abs(result.source.rotationDegrees), 90);
  assert.ok(result.durationMs >= ENROLLMENT_MEDIA_LIMITS.minDurationMs);
  assert.ok(result.audioAnalysis.rmsDbfs >= result.audioAnalysis.minimumRmsDbfs);
  assert.equal(result.audioAnalysis.speechOrIdentityClassified, false);

  const identityUpload = validateIdentityUpload({
    kind: 'voice',
    dataUrl: `data:audio/wav;base64,${result.audioBuffer.toString('base64')}`,
  });
  assert.equal(identityUpload.contentType, 'audio/wav');
  assert.equal(identityUpload.codec, 'pcm-16');
  assert.equal(identityUpload.channels, 1);
  assert.equal(identityUpload.sampleRate, 16_000);
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('real MOV and WebM containers are identified from bytes and fully decoded', async () => {
  const mov = await prepareEnrollmentMedia(request(validMov));
  assert.equal(mov.source.container, 'mov');
  assert.equal(mov.source.mimeType, 'video/quicktime');
  assert.equal(mov.source.videoCodec, 'h264');

  const webm = await prepareEnrollmentMedia(request(validWebm));
  assert.equal(webm.source.container, 'webm');
  assert.equal(webm.source.mimeType, 'video/webm');
  assert.equal(webm.source.videoCodec, 'vp9');
  assert.equal(webm.source.audioCodec, 'opus');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('consent is required and bound to the exact expected source hash before extraction', async () => {
  await rejectsWithCode(prepareEnrollmentMedia(request(validPayload, { consent: null })), 'EXTRACTION_CONSENT_REQUIRED');
  const expectedSha256 = sha256(validPayload);
  await rejectsWithCode(prepareEnrollmentMedia(request(validPayload, {
    expectedSha256,
    consent: { granted: true, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE, sourceSha256: '0'.repeat(64) },
  })), 'CONSENT_SOURCE_MISMATCH');
  const wrongSha = '0'.repeat(64);
  await rejectsWithCode(prepareEnrollmentMedia(request(validPayload, {
    expectedSha256: wrongSha,
    consent: { granted: true, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE, sourceSha256: wrongSha },
  })), 'SOURCE_HASH_MISMATCH');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('missing video, missing audio, and truncated bytes never produce enrollment audio', async () => {
  await assert.rejects(prepareEnrollmentMedia(request(audioOnly)), error => error instanceof EnrollmentMediaError);
  await rejectsWithCode(prepareEnrollmentMedia(request(videoOnly)), 'AUDIO_STREAM_REQUIRED');
  const malformed = path.join(workdir, 'malformed.payload');
  await writeFile(malformed, Buffer.from('not media bytes'));
  await assert.rejects(prepareEnrollmentMedia(request(malformed)), error => error instanceof EnrollmentMediaError);
  const truncated = path.join(workdir, 'truncated.payload');
  const bytes = await readFile(validPayload);
  await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  await assert.rejects(prepareEnrollmentMedia(request(truncated)), error => error instanceof EnrollmentMediaError);
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('near-silent extracted PCM is rejected by the explicit RMS threshold', async () => {
  await rejectsWithCode(prepareEnrollmentMedia(request(silentMedia)), 'AUDIO_NEAR_SILENT');
  assert.equal(ENROLLMENT_MEDIA_LIMITS.minimumAudioRmsDbfs, -50);
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('source byte, dimension, and duration limits fail closed', async () => {
  const oversized = path.join(workdir, 'oversized.bin');
  await writeFile(oversized, Buffer.from([0]));
  await truncate(oversized, ENROLLMENT_MEDIA_LIMITS.maxSourceBytes + 1);
  const arbitrarySha = 'a'.repeat(64);
  await rejectsWithCode(prepareEnrollmentMedia({
    filePath: oversized,
    expectedSha256: arbitrarySha,
    consent: { granted: true, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE, sourceSha256: arbitrarySha },
    tempRoot: extractionRoot,
  }), 'SOURCE_BYTE_LIMIT');
  await rejectsWithCode(prepareEnrollmentMedia(request(oversizedDimensions)), 'DIMENSION_LIMIT');
  await rejectsWithCode(prepareEnrollmentMedia(request(shortDuration)), 'DURATION_MINIMUM');
  await rejectsWithCode(prepareEnrollmentMedia(request(excessiveDuration)), 'DURATION_LIMIT');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('frame, decoded-pixel, and pixel-rate budgets reject hostile media before enrollment', async () => {
  await rejectsWithCode(prepareEnrollmentMedia(request(excessiveFrameRate)), 'FRAME_RATE_LIMIT');
  await rejectsWithCode(prepareEnrollmentMedia(request(excessivePixelArea)), 'PIXEL_AREA_LIMIT');
  await rejectsWithCode(prepareEnrollmentMedia(request(excessivePixelRate)), 'PIXEL_RATE_LIMIT');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('a real long compressed audio stream hits the during-write cap and leaves no temporary output', async () => {
  let monitoring = true;
  let largestObserved = 0;
  const monitor = (async () => {
    while (monitoring) {
      largestObserved = Math.max(largestObserved, await largestTemporaryFile(extractionRoot));
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  })();
  try {
    await rejectsWithCode(prepareEnrollmentMedia(request(longCompressedAudio)), 'STREAM_DURATION_MISMATCH');
  } finally {
    monitoring = false;
    await monitor;
  }
  assert.ok(largestObserved > 0, 'the real FFmpeg output must be observed while it is bounded');
  assert.ok(
    largestObserved <= ENROLLMENT_MEDIA_LIMITS.maxAudioWriteBytes + (64 * 1024),
    `${largestObserved} exceeded the FFmpeg write cap plus one bounded muxer chunk`,
  );
  assert.ok(largestObserved <= ENROLLMENT_MEDIA_LIMITS.maxAudioBytes, `${largestObserved} exceeded the stored-audio bound`);
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('one overall processing deadline bounds all FFmpeg passes', async () => {
  await rejectsWithCode(prepareEnrollmentMedia({ ...request(validPayload), timeoutMs: 1 }), 'FFMPEG_TIMEOUT');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('unsupported codecs and mismatched stream durations are never normalized into valid enrollment sources', async () => {
  await rejectsWithCode(prepareEnrollmentMedia(request(unsupportedCodec)), 'VIDEO_CODEC_UNSUPPORTED');
  await rejectsWithCode(prepareEnrollmentMedia(request(streamDurationMismatch)), 'STREAM_DURATION_MISMATCH');
  assert.deepEqual(await readdir(extractionRoot), []);
});

test('protocol paths are rejected without invoking FFmpeg', async () => {
  const sourceSha256 = 'b'.repeat(64);
  await rejectsWithCode(prepareEnrollmentMedia({
    filePath: 'https://example.invalid/phone.mp4',
    expectedSha256: sourceSha256,
    consent: { granted: true, purpose: ENROLLMENT_MEDIA_CONSENT_PURPOSE, sourceSha256 },
  }), 'INPUT_PROTOCOL_DENIED');
});
