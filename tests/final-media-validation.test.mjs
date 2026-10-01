import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import {
  FINAL_MEDIA_VALIDATION_LIMITS,
  inspectMedia,
  validateFinalMedia,
} from '../services/final-media-validation.js';
import { finalOutputPath } from '../lib/video-os-output-acceptance.js';

const job = Object.freeze({
  id: 'job-final-media-proof',
  accountId: 'account-final-media-proof',
  provider: 'heygen',
  format: 'vertical',
});

let workdir;
let validMedia;
let wrongDimensions;
let videoOnly;
let audioOnly;
let longMedia;
let streamDurationMismatch;
let multipleAudioStreams;

function makeMedia(output, {
  size = '320x240',
  duration = 0.8,
  videoDuration = duration,
  audioDuration = duration,
  fps = 5,
  video = true,
  audio = true,
  shortest = true,
} = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (video) args.push('-f', 'lavfi', '-i', `color=c=0x14213d:s=${size}:r=${fps}:d=${videoDuration}`);
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=8000:duration=${audioDuration}`);
  if (video) args.push('-map', '0:v:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) {
    const audioInput = video ? '1:a:0' : '0:a:0';
    args.push('-map', audioInput, '-c:a', 'aac', '-b:a', '32k');
  }
  if (video && audio && shortest) args.push('-shortest');
  args.push('-movflags', '+faststart', output);
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `fixture ffmpeg failed: ${String(result.stderr).slice(-500)}`);
}

function makeMultipleAudioMedia(output) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=5:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=8000:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart', output,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `multi-stream fixture ffmpeg failed: ${String(result.stderr).slice(-500)}`);
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
  workdir = await mkdtemp(join(tmpdir(), 'lux-final-media-validation-'));
  validMedia = join(workdir, 'valid-vertical.mp4');
  wrongDimensions = join(workdir, 'wrong-dimensions.mp4');
  videoOnly = join(workdir, 'video-only.mp4');
  audioOnly = join(workdir, 'audio-only.mp4');
  longMedia = join(workdir, 'too-long.mp4');
  streamDurationMismatch = join(workdir, 'stream-duration-mismatch.mp4');
  multipleAudioStreams = join(workdir, 'multiple-audio-streams.mp4');
  makeMedia(validMedia, { size: '1080x1920', duration: 1.2, fps: 5 });
  makeMedia(wrongDimensions, { size: '320x240', duration: 0.8, fps: 5 });
  makeMedia(videoOnly, { size: '320x240', duration: 0.8, fps: 5, audio: false });
  makeMedia(audioOnly, { duration: 0.8, video: false });
  makeMedia(longMedia, { size: '16x16', duration: 181, fps: 1 });
  makeMedia(streamDurationMismatch, {
    size: '320x240',
    videoDuration: 0.6,
    audioDuration: 3,
    shortest: false,
  });
  makeMultipleAudioMedia(multipleAudioStreams);
});

after(async () => {
  await rm(workdir, { recursive: true, force: true });
});

test('valid final media is fully decoded, hashed, and bound to canonical acceptance evidence', async () => {
  const expectedHash = createHash('sha256').update(readFileSync(validMedia)).digest('hex');
  const result = await validateFinalMedia(validMedia, { job, expectedDurationMs: 1_200 });

  assert.equal(result.sha256, expectedHash);
  assert.equal(result.bytes, readFileSync(validMedia).length);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.ok(result.durationMs > 0 && result.durationMs <= 1_700);
  assert.equal(result.acceptance.privatePathname, finalOutputPath(job.accountId, job.id, expectedHash));
  assert.deepEqual(result.acceptance.media, {
    fullDecode: true,
    videoStreams: 1,
    audioStreams: 1,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1080,
    height: 1920,
    durationMs: result.durationMs,
    expectedDurationMs: 1_200,
    durationToleranceMs: 500,
  });
  assert.deepEqual(result.acceptance.checks, {
    duration: true,
    dimensions: true,
    byteLimit: true,
  });
  assert.match(result.acceptance.validatorVersion, /^final-media-validator-v1\/ffmpeg-/);
  assert.ok(Number.isFinite(Date.parse(result.acceptance.validatedAt)));
});

test('inspectMedia decodes source media without applying final job dimensions', async () => {
  const result = await inspectMedia(wrongDimensions);
  assert.equal(result.fullDecode, true);
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.equal(result.videoStreams, 1);
  assert.equal(result.audioStreams, 1);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('final validation rejects missing audio and missing video streams', async () => {
  await rejectsWithCode(inspectMedia(videoOnly), 'AUDIO_STREAM_REQUIRED');
  await rejectsWithCode(inspectMedia(audioOnly), 'VIDEO_STREAM_REQUIRED');
  await rejectsWithCode(inspectMedia(multipleAudioStreams), 'STREAM_COUNT_UNSUPPORTED');
});

test('header-only, corrupt, and truncated MP4 candidates never pass a full decode', async () => {
  const headerOnly = join(workdir, 'header-only-secret-name.mp4');
  const corrupt = join(workdir, 'corrupt-secret-name.mp4');
  const truncated = join(workdir, 'truncated-secret-name.mp4');
  const validBytes = readFileSync(validMedia);
  await writeFile(headerOnly, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
  await writeFile(corrupt, Buffer.from('not media bytes'));
  await writeFile(truncated, validBytes.subarray(0, Math.floor(validBytes.length * 0.6)));

  for (const pathname of [headerOnly, corrupt, truncated]) {
    await assert.rejects(inspectMedia(pathname), (error) => {
      assert.equal(error.failureCategory, 'FINAL_MEDIA_VALIDATION');
      assert.doesNotMatch(error.message, /secret-name|lux-final-media-validation|\\|\//i);
      return true;
    });
  }
});

test('final validation enforces exact canonical dimensions', async () => {
  await rejectsWithCode(
    validateFinalMedia(wrongDimensions, { job: { ...job, format: 'vertical' }, expectedDurationMs: 800 }),
    'DIMENSIONS_MISMATCH',
  );
});

test('duration policy rejects source mismatches and media over 180 seconds', async () => {
  await rejectsWithCode(
    validateFinalMedia(validMedia, { job, expectedDurationMs: 4_000 }),
    'DURATION_MISMATCH',
  );
  await rejectsWithCode(inspectMedia(longMedia), 'DURATION_LIMIT');
  await rejectsWithCode(inspectMedia(streamDurationMismatch), 'STREAM_DURATION_MISMATCH');
});

test('duration tolerance is the greater of 500ms and five percent', async () => {
  const { durationMs } = await inspectMedia(validMedia);
  await validateFinalMedia(validMedia, { job, expectedDurationMs: durationMs + 500 });
  await rejectsWithCode(
    validateFinalMedia(validMedia, { job, expectedDurationMs: durationMs + 501 }),
    'DURATION_MISMATCH',
  );
});

test('byte limit is exactly 100 MiB and is enforced before decode', async () => {
  assert.equal(FINAL_MEDIA_VALIDATION_LIMITS.maxBytes, 100 * 1024 * 1024);
  const oversized = join(workdir, 'oversized.mp4');
  await writeFile(oversized, Buffer.from([0]));
  await truncate(oversized, FINAL_MEDIA_VALIDATION_LIMITS.maxBytes + 1);
  await rejectsWithCode(inspectMedia(oversized), 'BYTE_LIMIT');
});

test('final validation requires a finite positive source duration', async () => {
  await rejectsWithCode(validateFinalMedia(validMedia, { job }), 'EXPECTED_DURATION_REQUIRED');
  await rejectsWithCode(validateFinalMedia(validMedia, { job, expectedDurationMs: Number.NaN }), 'EXPECTED_DURATION_REQUIRED');
  await rejectsWithCode(validateFinalMedia(validMedia, { job, expectedDurationMs: 0 }), 'EXPECTED_DURATION_REQUIRED');
});

test('protocol inputs and local network playlists are denied without making a network request', async () => {
  await rejectsWithCode(inspectMedia('https://example.invalid/customer.mp4'), 'INPUT_PROTOCOL_DENIED');
  await rejectsWithCode(inspectMedia('file:///private/customer.mp4'), 'INPUT_PROTOCOL_DENIED');
  const localPlaylist = join(workdir, 'network-reference.mp4');
  await writeFile(localPlaylist, '#EXTM3U\n#EXTINF:1,\nhttps://example.invalid/customer-segment.ts\n#EXT-X-ENDLIST\n');
  await assert.rejects(inspectMedia(localPlaylist), (error) => {
    assert.equal(error.failureCategory, 'FINAL_MEDIA_VALIDATION');
    assert.ok(error.validationCode);
    return true;
  });
});

test('decodable but unsupported final codecs do not become browser-ready MP4', async () => {
  const output = join(workdir, 'unsupported-codec.mp4');
  const converted = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', validMedia, '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'copy', output], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(converted.status, 0, converted.stderr);
  await rejectsWithCode(validateFinalMedia(output, { job, expectedDurationMs: 800 }), 'CODEC_UNSUPPORTED');
});
