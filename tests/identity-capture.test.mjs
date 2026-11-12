import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  INSPECT_VIDEO_TIMEOUT_MS,
  PHOTO_CAPTURE_LIMITS,
  UNREADABLE_VIDEO_LENGTH_MESSAGE,
  cameraAccessMessage,
  formatDurationSeconds,
  inspectVideoFile,
  isUsableDuration,
  portraitCameraConstraintAttempts,
  recordingWallClockSeconds,
  resolveVideoDuration,
  selectSnapshotEncoding,
  snapshotLayout,
  validateVideoFile,
  videoLengthError,
} from '../public/identity-capture.js';

const limits = Object.freeze({
  maximumSizeInBytes: 100 * 1024 * 1024,
  minimumDurationSeconds: 5,
  maximumDurationSeconds: 60,
  maximumDimensionPx: 4096,
  allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
});

function controllableVideo(width = 640, height = 480) {
  return {
    preload: '',
    muted: false,
    playsInline: false,
    src: '',
    duration: Number.NaN,
    videoWidth: width,
    videoHeight: height,
    currentTime: 0,
    onloadedmetadata: null,
    onerror: null,
    ondurationchange: null,
    ontimeupdate: null,
    onseeked: null,
    load() {},
    removeAttribute() { this.src = ''; },
  };
}

function inspectionDouble(video, { wallClockDurationSeconds = null } = {}) {
  let timeoutFn = null;
  let timeoutMs = null;
  let revoked = 0;
  return {
    wallClockDurationSeconds,
    createVideo: () => video,
    createObjectURL: () => 'blob:fixture',
    revokeObjectURL: () => { revoked += 1; },
    scheduleTimeout(fn, ms) { timeoutFn = fn; timeoutMs = ms; return 7; },
    cancelTimeout() {},
    timeoutMsSeen: () => timeoutMs,
    revoked: () => revoked,
    expire: () => timeoutFn(),
  };
}

function videoFile(overrides = {}) {
  return { name: 'clip.webm', type: 'video/webm', size: 2_000, lastModified: 1, ...overrides };
}

test('duration helpers treat Infinity, NaN, and zero as unreadable and keep a positive wall clock', () => {
  for (const duration of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    assert.equal(isUsableDuration(duration), false);
    assert.equal(videoLengthError(duration), UNREADABLE_VIDEO_LENGTH_MESSAGE);
    assert.deepEqual(resolveVideoDuration({ metadataDuration: duration, wallClockDuration: 8.5 }), {
      duration: 8.5,
      source: 'wall-clock',
    });
  }
  assert.deepEqual(resolveVideoDuration({ metadataDuration: 12, wallClockDuration: 3 }), { duration: 12, source: 'metadata' });
  assert.deepEqual(resolveVideoDuration({ metadataDuration: Number.POSITIVE_INFINITY, wallClockDuration: 0 }), {
    duration: null,
    source: 'unreadable',
  });
  assert.equal(videoLengthError(12), null);
  assert.equal(videoLengthError(5), null);
  assert.equal(videoLengthError(60), null);
  assert.equal(videoLengthError(4.96), 'This video is 4.9 seconds. Record at least 5 seconds.');
  assert.equal(videoLengthError(3.2), 'This video is 3.2 seconds. Record at least 5 seconds.');
  assert.equal(videoLengthError(72.4), 'This video is 72.4 seconds. Keep it under 60 seconds.');
  assert.equal(videoLengthError(60.04), 'This video is 60.1 seconds. Keep it under 60 seconds.');
  assert.equal(formatDurationSeconds(4), '4.0');
});

test('recording wall-clock duration excludes paused time', () => {
  assert.equal(recordingWallClockSeconds({ startedAt: 1_000, stoppedAt: 11_000, pausedMs: 4_000 }), 6);
  assert.equal(recordingWallClockSeconds({ startedAt: 0, stoppedAt: 5_000, pausedMs: 0 }), 5);
  assert.equal(recordingWallClockSeconds({ startedAt: 0, stoppedAt: 4_000, pausedMs: 4_000 }), null);
  assert.equal(recordingWallClockSeconds({ startedAt: 20, stoppedAt: 10, pausedMs: 0 }), null);
  assert.equal(recordingWallClockSeconds({}), null);
});

test('camera denial and a missing camera use different plain messages', () => {
  assert.equal(cameraAccessMessage({ name: 'NotAllowedError' }, 'photo'), 'Camera access was denied. Choose a portrait instead.');
  assert.equal(cameraAccessMessage({ name: 'NotFoundError' }, 'photo'), 'No camera was found. Choose a portrait instead.');
  assert.equal(cameraAccessMessage({ name: 'NotReadableError' }, 'photo'), 'The camera could not be started. Choose a portrait instead.');
  assert.match(cameraAccessMessage({ name: 'NotAllowedError' }, 'video'), /Camera or microphone access was denied/);
  assert.match(cameraAccessMessage({ name: 'NotFoundError' }, 'video'), /No camera or microphone was found/);
  assert.match(cameraAccessMessage({ name: 'SecurityError' }, 'video'), /was denied/);
  assert.match(cameraAccessMessage({ name: 'AbortError' }, 'video'), /was not granted/);
});

test('portrait snapshot layout stays inside 512 to 8192 pixels and the camera request is video only', () => {
  const hd = snapshotLayout(1280, 720);
  assert.equal(hd.canvasWidth, 1280);
  assert.equal(hd.canvasHeight, 720);
  const small = snapshotLayout(320, 240);
  assert.ok(Math.min(small.canvasWidth, small.canvasHeight) >= PHOTO_CAPTURE_LIMITS.minSide);
  assert.ok(Math.max(small.canvasWidth, small.canvasHeight) <= PHOTO_CAPTURE_LIMITS.maxSide);
  const large = snapshotLayout(9000, 6000);
  assert.ok(large.canvasWidth <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.ok(large.canvasHeight <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.ok(Math.min(large.canvasWidth, large.canvasHeight) >= PHOTO_CAPTURE_LIMITS.minSide);
  const extreme = snapshotLayout(20_000, 100);
  assert.ok(extreme.canvasWidth >= PHOTO_CAPTURE_LIMITS.minSide && extreme.canvasWidth <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.ok(extreme.canvasHeight >= PHOTO_CAPTURE_LIMITS.minSide && extreme.canvasHeight <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.equal(snapshotLayout(0, 720), null);
  for (const attempt of portraitCameraConstraintAttempts()) {
    assert.equal(attempt.audio, false);
    assert.deepEqual(attempt.video.facingMode, { ideal: 'user' });
  }
  const [preferred, fallback] = portraitCameraConstraintAttempts();
  assert.equal(preferred.video.width.min, 1280);
  assert.equal(preferred.video.height.min, 720);
  assert.ok(preferred.video.width.ideal >= 1280);
  assert.ok(preferred.video.height.ideal >= 720);
  assert.equal(fallback.video.width.ideal, 1280);
  assert.equal(fallback.video.height.ideal, 720);
  assert.equal(fallback.video.width.min, undefined);
});

test('JPEG quality steps down, then the frame shrinks, until the photo is 3 MB or smaller', async () => {
  const stepped = await selectSnapshotEncoding({
    sourceWidth: 1280,
    sourceHeight: 720,
    measure: ({ quality }) => (quality > 0.7 ? 4_000_000 : 1_500_000),
  });
  assert.equal(stepped.ok, true);
  assert.equal(stepped.quality, 0.68);
  assert.equal(stepped.canvasWidth, 1280);
  assert.equal(stepped.canvasHeight, 720);
  assert.equal(stepped.bytes, 1_500_000);

  const shrunk = await selectSnapshotEncoding({
    sourceWidth: 4096,
    sourceHeight: 4096,
    measure: ({ canvasWidth, canvasHeight, quality }) => Math.ceil(canvasWidth * canvasHeight * quality),
  });
  assert.equal(shrunk.ok, true);
  assert.ok(shrunk.bytes > 0 && shrunk.bytes <= PHOTO_CAPTURE_LIMITS.maxBytes);
  assert.ok(shrunk.canvasWidth >= PHOTO_CAPTURE_LIMITS.minSide && shrunk.canvasWidth <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.ok(shrunk.canvasHeight >= PHOTO_CAPTURE_LIMITS.minSide && shrunk.canvasHeight <= PHOTO_CAPTURE_LIMITS.maxSide);
  assert.ok(shrunk.attempts.length < 40);

  const impossible = await selectSnapshotEncoding({
    sourceWidth: 512,
    sourceHeight: 512,
    measure: () => 9_000_000,
  });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.reason, 'too-large');
  assert.equal((await selectSnapshotEncoding({ sourceWidth: 1, sourceHeight: 400, measure: () => 1 })).reason, 'unreadable-frame');
});

test('inspectVideoFile reads a finite metadata duration without seeking', async () => {
  const video = controllableVideo(1280, 720);
  const options = inspectionDouble(video);
  const pending = inspectVideoFile(videoFile(), options);
  video.duration = 12.5;
  video.onloadedmetadata();
  const result = await pending;
  assert.equal(result.duration, 12.5);
  assert.equal(result.durationSource, 'metadata');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
  assert.equal(video.currentTime, 0);
  assert.equal(options.timeoutMsSeen(), INSPECT_VIDEO_TIMEOUT_MS);
  assert.equal(options.revoked(), 1);
});

test('inspectVideoFile seeks when metadata duration is Infinity, NaN, or zero', async () => {
  for (const initial of [Number.POSITIVE_INFINITY, Number.NaN, 0]) {
    const video = controllableVideo();
    const options = inspectionDouble(video, { wallClockDurationSeconds: 40 });
    const pending = inspectVideoFile(videoFile(), options);
    video.duration = initial;
    video.onloadedmetadata();
    assert.ok(video.currentTime > 1e10);
    video.duration = 8;
    video.ondurationchange();
    assert.equal(video.currentTime, 0);
    video.onseeked();
    const result = await pending;
    assert.equal(result.duration, 8);
    assert.equal(result.durationSource, 'seek');
    assert.equal(options.revoked(), 1);
  }
});

test('inspectVideoFile uses the recording wall clock when the seek never yields a finite duration', async () => {
  const video = controllableVideo();
  const options = inspectionDouble(video, { wallClockDurationSeconds: 9.25 });
  const pending = inspectVideoFile(videoFile(), options);
  video.duration = Number.POSITIVE_INFINITY;
  video.onloadedmetadata();
  options.expire();
  const result = await pending;
  assert.equal(result.duration, 9.25);
  assert.equal(result.durationSource, 'wall-clock');
});

test('inspectVideoFile distinguishes an unreadable length from a file that never loads', async () => {
  const unread = controllableVideo();
  const unreadOptions = inspectionDouble(unread);
  const unreadPending = inspectVideoFile(videoFile(), unreadOptions);
  unread.duration = 0;
  unread.onloadedmetadata();
  unreadOptions.expire();
  await assert.rejects(unreadPending, error => error.message === UNREADABLE_VIDEO_LENGTH_MESSAGE);

  const stalled = controllableVideo();
  const stalledOptions = inspectionDouble(stalled, { wallClockDurationSeconds: 8 });
  const stalledPending = inspectVideoFile(videoFile(), stalledOptions);
  stalledOptions.expire();
  await assert.rejects(stalledPending, /The video took too long to read/);
});

test('validateVideoFile accepts in-range durations and names too-short, too-long, and unreadable videos', async () => {
  async function validateWith(duration, extra = {}, file = videoFile()) {
    const video = controllableVideo();
    video.load = () => {
      video.duration = duration;
      video.onloadedmetadata?.();
    };
    return validateVideoFile(file, limits, inspectionDouble(video, extra));
  }

  const finite = await validateWith(12);
  assert.equal(finite.duration, 12);
  assert.equal((await validateWith(5)).duration, 5);
  assert.equal((await validateWith(60)).duration, 60);
  assert.equal((await validateWith(12, { wallClockDurationSeconds: 2 })).durationSource, 'metadata');

  await assert.rejects(validateWith(3.2), error => error.message === 'This video is 3.2 seconds. Record at least 5 seconds.');
  await assert.rejects(validateWith(72), error => error.message === 'This video is 72.0 seconds. Keep it under 60 seconds.');
  await assert.rejects(validateWith(4), error => error.message === 'This video is 4.0 seconds. Record at least 5 seconds.');
  await assert.rejects(validateVideoFile(videoFile({ type: 'image/jpeg' }), limits, {}), /MP4, MOV, or WebM/);
  await assert.rejects(validateVideoFile(videoFile({ size: 0 }), limits, {}), /empty/);
  await assert.rejects(validateVideoFile(videoFile({ size: limits.maximumSizeInBytes + 1 }), limits, {}), /100 MiB/);

  const video = controllableVideo();
  video.load = () => {
    video.duration = Number.POSITIVE_INFINITY;
    video.onloadedmetadata?.();
  };
  const options = inspectionDouble(video, { wallClockDurationSeconds: 8 });
  const pending = validateVideoFile(videoFile(), limits, options);
  options.expire();
  assert.equal((await pending).duration, 8);

  const shortClock = controllableVideo();
  shortClock.load = () => {
    shortClock.duration = Number.NaN;
    shortClock.onloadedmetadata?.();
  };
  const shortOptions = inspectionDouble(shortClock, { wallClockDurationSeconds: 3 });
  const shortPending = validateVideoFile(videoFile(), limits, shortOptions);
  shortOptions.expire();
  await assert.rejects(shortPending, error => error.message === 'This video is 3.0 seconds. Record at least 5 seconds.');

  const longClock = controllableVideo();
  longClock.load = () => {
    longClock.duration = 0;
    longClock.onloadedmetadata?.();
  };
  const longOptions = inspectionDouble(longClock, { wallClockDurationSeconds: 90 });
  const longPending = validateVideoFile(videoFile(), limits, longOptions);
  longOptions.expire();
  await assert.rejects(longPending, error => error.message === 'This video is 90.0 seconds. Keep it under 60 seconds.');
});

test('the identity wizard keeps the camera fallback, duration helper, and previous-file suffix', async () => {
  const [html, client] = await Promise.all([
    readFile(new URL('../public/identity.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/identity.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="photo-capture-button"/);
  assert.match(html, /id="photo-capture-input"[^>]+accept="image\/jpeg,image\/png"[^>]+capture="user"/);
  assert.match(html, /id="photo-shutter"/);
  assert.match(html, /id="photo-retake"/);
  assert.match(html, /id="photo-use"/);
  assert.match(html, />Capture</);
  assert.match(html, />Use photo</);
  assert.match(client, /from '\.\/identity-capture\.js'/);
  assert.match(client, /stopPhotoCamera\(\)/);
  assert.match(client, /portraitCameraConstraintAttempts\(\)/);
  assert.match(client, /wallClockDurationSeconds/);
  assert.match(client, /Your previous valid video was kept\./);
  assert.match(client, /Your previous valid photo was kept\./);
  const capture = await readFile(new URL('../public/identity-capture.js', import.meta.url), 'utf8');
  assert.match(capture, /audio: false/);
});
