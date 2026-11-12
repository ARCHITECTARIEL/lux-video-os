export const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
export const INSPECT_VIDEO_TIMEOUT_MS = 12_000;
export const UNREADABLE_VIDEO_LENGTH_MESSAGE = 'We couldn\'t read this video\'s length. Try recording again or upload an MP4.';
export const VIDEO_METADATA_ERROR_MESSAGE = 'This browser could not read the video metadata. Try MP4, MOV, or WebM.';
export const VIDEO_READ_TIMEOUT_MESSAGE = 'The video took too long to read. Try a shorter MP4 or WebM file.';

export const PHOTO_CAPTURE_LIMITS = Object.freeze({
  minSide: 512,
  maxSide: 8192,
  maxBytes: 3_000_000,
  idealWidth: 1280,
  idealHeight: 720,
  jpegQualities: Object.freeze([0.92, 0.84, 0.76, 0.68, 0.6, 0.5, 0.4]),
});

// Phone portraits are often far above 3 MB. Cap the long side near 2048,
// keep the short side at least 512, then step JPEG quality before shrinking.
export const PHOTO_DOWNSCALE_LIMITS = Object.freeze({
  minSide: 512,
  maxSide: 2048,
  maxBytes: 3_000_000,
  jpegQualities: Object.freeze([0.9, 0.8, 0.7, 0.6]),
});

const SEEK_TO_END_SECONDS = 1e101;

export function isUsableDuration(duration) {
  return Number.isFinite(duration) && duration > 0;
}

export function metadataDurationNeedsSeek(duration) {
  return !isUsableDuration(duration);
}

export function resolveVideoDuration({ metadataDuration = null, wallClockDuration = null } = {}) {
  if (isUsableDuration(metadataDuration)) return { duration: metadataDuration, source: 'metadata' };
  if (isUsableDuration(wallClockDuration)) return { duration: wallClockDuration, source: 'wall-clock' };
  return { duration: null, source: 'unreadable' };
}

export function formatDurationSeconds(duration, { minimumDurationSeconds = null, maximumDurationSeconds = null } = {}) {
  if (!Number.isFinite(duration)) return '';
  let shown = Math.round(duration * 10) / 10;
  if (minimumDurationSeconds != null && duration < minimumDurationSeconds && shown >= minimumDurationSeconds) {
    shown = Math.floor(duration * 10) / 10;
  }
  if (maximumDurationSeconds != null && duration > maximumDurationSeconds && shown <= maximumDurationSeconds) {
    shown = Math.ceil(duration * 10) / 10;
  }
  return shown.toFixed(1);
}

export function videoLengthError(duration, { minimumDurationSeconds = 5, maximumDurationSeconds = 60 } = {}) {
  if (!isUsableDuration(duration)) return UNREADABLE_VIDEO_LENGTH_MESSAGE;
  if (duration < minimumDurationSeconds) {
    const shown = formatDurationSeconds(duration, { minimumDurationSeconds, maximumDurationSeconds });
    return `This video is ${shown} seconds. Record at least ${minimumDurationSeconds} seconds.`;
  }
  if (duration > maximumDurationSeconds) {
    const shown = formatDurationSeconds(duration, { minimumDurationSeconds, maximumDurationSeconds });
    return `This video is ${shown} seconds. Keep it under ${maximumDurationSeconds} seconds.`;
  }
  return null;
}

export function recordingWallClockSeconds({ startedAt, stoppedAt, pausedMs = 0 } = {}) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(stoppedAt)) return null;
  const paused = Number.isFinite(pausedMs) && pausedMs > 0 ? pausedMs : 0;
  const elapsed = stoppedAt - startedAt - paused;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  return elapsed / 1000;
}

export function cameraAccessMessage(error, medium = 'video') {
  const name = String(error?.name || '');
  const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
  const missing = name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError';
  if (medium === 'photo') {
    if (denied) return 'Camera access was denied. Choose a portrait instead.';
    if (missing) return 'No camera was found. Choose a portrait instead.';
    return 'The camera could not be started. Choose a portrait instead.';
  }
  if (denied) return 'Camera or microphone access was denied. Use your phone camera or choose an existing video.';
  if (missing) return 'No camera or microphone was found. Use your phone camera or choose an existing video.';
  if (name === 'NotReadableError') return 'The camera or microphone could not be started. Use your phone camera or choose an existing video.';
  return 'Camera or microphone access was not granted. Use your phone camera or choose an existing video.';
}

export function portraitCameraConstraintAttempts(limits = PHOTO_CAPTURE_LIMITS) {
  return [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { min: limits.idealWidth, ideal: Math.max(limits.idealWidth, 1920) },
        height: { min: limits.idealHeight, ideal: Math.max(limits.idealHeight, 1080) },
      },
    },
    {
      audio: false,
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: limits.idealWidth },
        height: { ideal: limits.idealHeight },
      },
    },
  ];
}

function finiteSide(value) {
  const side = Number(value);
  return Number.isFinite(side) ? side : null;
}

export function snapshotLayout(sourceWidth, sourceHeight, limits = PHOTO_CAPTURE_LIMITS) {
  const sw = finiteSide(sourceWidth);
  const sh = finiteSide(sourceHeight);
  if (sw == null || sh == null || sw < 2 || sh < 2) return null;
  const { minSide, maxSide } = limits;
  let scale = 1;
  if (Math.min(sw, sh) < minSide) scale = minSide / Math.min(sw, sh);
  if (Math.max(sw, sh) * scale > maxSide) scale = maxSide / Math.max(sw, sh);
  let drawWidth = Math.min(maxSide, Math.max(1, Math.round(sw * scale)));
  let drawHeight = Math.min(maxSide, Math.max(1, Math.round(sh * scale)));
  let canvasWidth = drawWidth;
  let canvasHeight = drawHeight;
  if (canvasWidth < minSide || canvasHeight < minSide) {
    canvasWidth = Math.min(maxSide, Math.max(drawWidth, minSide));
    canvasHeight = Math.min(maxSide, Math.max(drawHeight, minSide));
  }
  drawWidth = Math.min(drawWidth, canvasWidth);
  drawHeight = Math.min(drawHeight, canvasHeight);
  return {
    canvasWidth,
    canvasHeight,
    drawWidth,
    drawHeight,
    offsetX: Math.max(0, Math.floor((canvasWidth - drawWidth) / 2)),
    offsetY: Math.max(0, Math.floor((canvasHeight - drawHeight) / 2)),
    scale,
  };
}

export function shrinkSnapshotLayout(layout, limits = PHOTO_CAPTURE_LIMITS, factor = 0.85) {
  if (!layout || !Number.isFinite(factor) || factor <= 0 || factor >= 1) return null;
  const canvasWidth = Math.max(limits.minSide, Math.round(layout.canvasWidth * factor));
  const canvasHeight = Math.max(limits.minSide, Math.round(layout.canvasHeight * factor));
  if (canvasWidth === layout.canvasWidth && canvasHeight === layout.canvasHeight) return null;
  const aspect = layout.drawWidth / layout.drawHeight;
  let drawWidth = canvasWidth;
  let drawHeight = Math.max(1, Math.round(drawWidth / aspect));
  if (drawHeight > canvasHeight) {
    drawHeight = canvasHeight;
    drawWidth = Math.max(1, Math.round(drawHeight * aspect));
  }
  drawWidth = Math.min(canvasWidth, drawWidth);
  drawHeight = Math.min(canvasHeight, drawHeight);
  return {
    canvasWidth,
    canvasHeight,
    drawWidth,
    drawHeight,
    offsetX: Math.max(0, Math.floor((canvasWidth - drawWidth) / 2)),
    offsetY: Math.max(0, Math.floor((canvasHeight - drawHeight) / 2)),
    scale: layout.scale * (drawWidth / layout.drawWidth),
  };
}

export function nextSnapshotLayout(layout, bytes, limits = PHOTO_CAPTURE_LIMITS) {
  const ratio = Number.isFinite(bytes) && bytes > 0 ? limits.maxBytes / bytes : 0.85 ** 2;
  const factor = Math.min(0.9, Math.max(0.5, Math.sqrt(Math.max(ratio, 0.01)) * 0.9));
  return shrinkSnapshotLayout(layout, limits, factor);
}

export function planPhotoDownscale({ sourceWidth, sourceHeight, measure, limits = PHOTO_DOWNSCALE_LIMITS } = {}) {
  return selectSnapshotEncoding({ sourceWidth, sourceHeight, measure, limits });
}

export function signedOutNotice(session) {
  if (!session || session.signedIn !== false) return '';
  return String(session.error || '').trim();
}

export async function selectSnapshotEncoding({ sourceWidth, sourceHeight, measure, limits = PHOTO_CAPTURE_LIMITS } = {}) {
  let layout = snapshotLayout(sourceWidth, sourceHeight, limits);
  if (!layout) return { ok: false, reason: 'unreadable-frame', attempts: [] };
  const attempts = [];
  for (let pass = 0; pass < 24; pass += 1) {
    let smallestBytes = Infinity;
    for (const quality of limits.jpegQualities) {
      const bytes = await measure({ ...layout, quality });
      const attempt = { ...layout, quality, bytes };
      attempts.push(attempt);
      if (Number.isFinite(bytes) && bytes > 0) smallestBytes = Math.min(smallestBytes, bytes);
      if (Number.isFinite(bytes) && bytes > 0 && bytes <= limits.maxBytes) {
        return { ok: true, ...attempt, attempts };
      }
    }
    const next = nextSnapshotLayout(layout, smallestBytes, limits);
    if (!next) return { ok: false, reason: 'too-large', attempts };
    layout = next;
  }
  return { ok: false, reason: 'too-large', attempts };
}

function defaultCreateVideo() {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  return video;
}

export function inspectVideoFile(file, {
  wallClockDurationSeconds = null,
  timeoutMs = INSPECT_VIDEO_TIMEOUT_MS,
  createObjectURL = blob => URL.createObjectURL(blob),
  revokeObjectURL = url => URL.revokeObjectURL(url),
  createVideo = defaultCreateVideo,
  scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  cancelTimeout = id => clearTimeout(id),
} = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = createObjectURL(file);
    } catch {
      reject(new Error(VIDEO_METADATA_ERROR_MESSAGE));
      return;
    }
    const video = createVideo();
    video.preload = 'metadata';
    let settled = false;
    let phase = 'metadata';
    let metadataSeen = false;
    let resolvedDuration = null;
    let resolvedSource = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.ondurationchange = null;
      video.ontimeupdate = null;
      video.onseeked = null;
      try { video.removeAttribute?.('src'); } catch { /* the element is being discarded */ }
      try { video.load?.(); } catch { /* already detached */ }
      try { revokeObjectURL(url); } catch { /* the object URL was already released */ }
      if (error) reject(error);
      else resolve(value);
    };
    const succeed = (duration, source) => {
      resolvedDuration = duration;
      resolvedSource = source;
      finish(null, {
        duration,
        width: video.videoWidth,
        height: video.videoHeight,
        durationSource: source,
      });
    };
    const timer = scheduleTimeout(() => {
      if (isUsableDuration(resolvedDuration)) {
        succeed(resolvedDuration, resolvedSource || 'metadata');
        return;
      }
      const fallback = resolveVideoDuration({ wallClockDuration: wallClockDurationSeconds });
      if (metadataSeen && fallback.duration != null && video.videoWidth && video.videoHeight) {
        succeed(fallback.duration, fallback.source);
        return;
      }
      finish(new Error(metadataSeen ? UNREADABLE_VIDEO_LENGTH_MESSAGE : VIDEO_READ_TIMEOUT_MESSAGE));
    }, timeoutMs);

    const onSeekSignal = () => {
      if (settled) return;
      const duration = video.duration;
      if (phase === 'seeking') {
        if (!isUsableDuration(duration)) return;
        resolvedDuration = duration;
        resolvedSource = 'seek';
        phase = 'resetting';
        try {
          video.currentTime = 0;
        } catch {
          succeed(duration, 'seek');
        }
        return;
      }
      if (phase === 'resetting') succeed(resolvedDuration, 'seek');
    };

    video.onloadedmetadata = () => {
      if (settled) return;
      metadataSeen = true;
      const duration = video.duration;
      if (isUsableDuration(duration)) {
        succeed(duration, 'metadata');
        return;
      }
      phase = 'seeking';
      video.ondurationchange = onSeekSignal;
      video.ontimeupdate = onSeekSignal;
      video.onseeked = onSeekSignal;
      try {
        video.currentTime = SEEK_TO_END_SECONDS;
      } catch {
        const fallback = resolveVideoDuration({ wallClockDuration: wallClockDurationSeconds });
        if (fallback.duration != null && video.videoWidth && video.videoHeight) succeed(fallback.duration, fallback.source);
      }
    };
    video.onerror = () => {
      if (settled) return;
      if (isUsableDuration(resolvedDuration) && video.videoWidth && video.videoHeight) {
        succeed(resolvedDuration, resolvedSource || 'seek');
        return;
      }
      const fallback = resolveVideoDuration({ wallClockDuration: wallClockDurationSeconds });
      if ((phase === 'seeking' || phase === 'resetting') && fallback.duration != null && video.videoWidth && video.videoHeight) {
        succeed(fallback.duration, fallback.source);
        return;
      }
      finish(new Error(VIDEO_METADATA_ERROR_MESSAGE));
    };
    video.src = url;
    try { video.load?.(); } catch { /* load is optional for the injected test double */ }
  });
}

export async function validateVideoFile(file, limits, options = {}) {
  if (!file) throw new Error('Record or choose your phone video first.');
  const type = String(file.type || '').toLowerCase();
  const allowed = (limits?.allowedContentTypes || []).map(item => String(item).toLowerCase());
  if (!allowed.includes(type) || !VIDEO_TYPES.has(type)) throw new Error('Use an MP4, MOV, or WebM phone video.');
  if (!file.size) throw new Error('The selected video is empty.');
  const maximumSize = Math.min(
    Number(limits.maximumSizeInBytes),
    Number(options.absoluteMaximumSizeInBytes ?? limits.maximumSizeInBytes),
  );
  if (file.size > maximumSize) throw new Error('The phone video must be 100 MiB or smaller.');
  const metadata = await inspectVideoFile(file, options);
  const lengthError = videoLengthError(metadata.duration, limits);
  if (lengthError) throw new Error(lengthError);
  if (!metadata.width || !metadata.height || metadata.width > limits.maximumDimensionPx || metadata.height > limits.maximumDimensionPx) {
    throw new Error(`Use a video no larger than ${limits.maximumDimensionPx} pixels on either side.`);
  }
  return metadata;
}
