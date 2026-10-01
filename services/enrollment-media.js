import defaultFfmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DERIVATION_VERSION = 'enrollment-media-audio-v1';
export const ENROLLMENT_MEDIA_CONSENT_PURPOSE = 'identity-voice-enrollment';
export const ENROLLMENT_MEDIA_LIMITS = Object.freeze({
  maxSourceBytes: 100 * 1024 * 1024,
  minDurationMs: 5_000,
  maxDurationMs: 60_000,
  maxDimension: 4_096,
  maxPixelArea: 4_096 * 2_160,
  maxFrameRate: 120,
  maxPixelRate: 3_840 * 2_160 * 60,
  maxDecodedFrames: 7_200,
  maxAudioBytes: 3_000_000,
  // 60.5 seconds of mono 16 kHz 16-bit PCM. The half-second margin
  // accommodates resampler delay without allowing an overlong source to
  // expand until it fills the function's temporary filesystem.
  maxAudioWriteBytes: 1_936_000,
  maxAudioWriteDurationMs: 61_000,
  audioSampleRate: 16_000,
  audioChannels: 1,
  audioBitsPerSample: 16,
  minimumAudioRmsDbfs: -50,
  overallTimeoutMs: 90_000,
  maximumOverallTimeoutMs: 120_000,
  diagnosticBytes: 128 * 1024,
  ffmpegMaxAllocationBytes: 256 * 1024 * 1024,
  supportedContainers: Object.freeze(['mp4', 'mov', 'webm']),
  supportedVideoCodecs: Object.freeze({
    mp4: Object.freeze(['h264', 'hevc']),
    mov: Object.freeze(['h264', 'hevc']),
    webm: Object.freeze(['vp8', 'vp9']),
  }),
  webmAudioCodec: 'opus',
});

export class EnrollmentMediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnrollmentMediaError';
    this.code = code;
    this.statusCode = 422;
    this.failureCategory = 'ENROLLMENT_MEDIA';
  }
}

function fail(code, message) {
  throw new EnrollmentMediaError(code, message);
}

function localFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    fail('INVALID_INPUT', 'Enrollment source must be a local file.');
  }
  const candidate = filePath.trim();
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate);
  if (hasProtocol || candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    fail('INPUT_PROTOCOL_DENIED', 'Enrollment source must be a local file.');
  }
  return resolve(candidate);
}

function normalizeExpectedSha256(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail('EXPECTED_SHA256_REQUIRED', 'An exact source SHA-256 is required.');
  return normalized;
}

function assertConsent(consent, expectedSha256) {
  if (!consent || consent.granted !== true || consent.purpose !== ENROLLMENT_MEDIA_CONSENT_PURPOSE) {
    fail('EXTRACTION_CONSENT_REQUIRED', 'Explicit voice-extraction consent is required.');
  }
  const consentSha256 = String(consent.sourceSha256 || '').toLowerCase();
  if (consentSha256 !== expectedSha256) {
    fail('CONSENT_SOURCE_MISMATCH', 'Voice-extraction consent does not match the source bytes.');
  }
}

async function stableRegularFile(pathname) {
  let info;
  try { info = await lstat(pathname); } catch { fail('INPUT_UNAVAILABLE', 'Enrollment source is unavailable.'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('INVALID_INPUT', 'Enrollment source must be a local regular file.');
  if (!Number.isSafeInteger(info.size) || info.size <= 0) fail('EMPTY_MEDIA', 'Enrollment source is empty.');
  if (info.size > ENROLLMENT_MEDIA_LIMITS.maxSourceBytes) fail('SOURCE_BYTE_LIMIT', 'Enrollment source exceeds the 100 MiB limit.');
  return info;
}

function assertStableFile(before, after) {
  if (!after.isFile() || after.isSymbolicLink()
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    fail('SOURCE_CHANGED', 'Enrollment source changed during processing.');
  }
}

async function hashFile(pathname) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(pathname)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    fail('SOURCE_CHANGED', 'Enrollment source changed during processing.');
  }
}

function boundedTimeout(value) {
  if (value === undefined) return ENROLLMENT_MEDIA_LIMITS.overallTimeoutMs;
  if (!Number.isFinite(value) || value <= 0 || value > ENROLLMENT_MEDIA_LIMITS.maximumOverallTimeoutMs) {
    fail('INVALID_TIMEOUT', 'Enrollment media timeout is outside the supported bound.');
  }
  return Math.floor(value);
}

function remainingTimeout(deadlineAt) {
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) fail('FFMPEG_TIMEOUT', 'Enrollment media processing timed out.');
  return remaining;
}

function runFfmpeg(binary, args, timeoutMs) {
  return new Promise((resolveProcess, rejectProcess) => {
    if (!binary) {
      rejectProcess(new EnrollmentMediaError('FFMPEG_UNAVAILABLE', 'Enrollment media processing is unavailable.'));
      return;
    }
    const child = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let diagnosticsExceeded = false;
    let settled = false;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGKILL'); } catch { /* close/error remains authoritative */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const append = (stream, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes <= ENROLLMENT_MEDIA_LIMITS.diagnosticBytes) stdout += chunk;
      } else {
        stderrBytes += bytes;
        if (stderrBytes <= ENROLLMENT_MEDIA_LIMITS.diagnosticBytes) stderr += chunk;
      }
      if (stdoutBytes > ENROLLMENT_MEDIA_LIMITS.diagnosticBytes || stderrBytes > ENROLLMENT_MEDIA_LIMITS.diagnosticBytes) {
        diagnosticsExceeded = true;
        stop();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectProcess(new EnrollmentMediaError('FFMPEG_UNAVAILABLE', 'Enrollment media processing is unavailable.'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code, signal, stdout, stderr, timedOut, diagnosticsExceeded });
    });
  });
}

function commonInputArgs(pathname) {
  return [
    '-hide_banner', '-nostdin', '-nostats', '-stats_period', '5',
    '-progress', 'pipe:1', '-xerror', '-err_detect', 'explode',
    '-max_alloc', String(ENROLLMENT_MEDIA_LIMITS.ffmpegMaxAllocationBytes),
    '-protocol_whitelist', 'file,pipe', '-noautorotate', '-i', pathname,
  ];
}

function progressMetadata(stdout) {
  let frames = 0;
  let durationMs = 0;
  let completed = false;
  for (const line of String(stdout).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === 'frame') frames = Math.max(frames, Number.parseInt(value, 10) || 0);
    if (key === 'out_time_us') durationMs = Math.max(durationMs, (Number(value) || 0) / 1000);
    if (key === 'progress' && value === 'end') completed = true;
  }
  return { frames, durationMs, completed };
}

function assertProcess(result, operation) {
  if (result.timedOut) fail('FFMPEG_TIMEOUT', `${operation} timed out.`);
  if (result.diagnosticsExceeded) fail('FFMPEG_DIAGNOSTIC_LIMIT', `${operation} diagnostics exceeded the safe limit.`);
  if (result.code !== 0) fail(operation === 'Video decode' ? 'VIDEO_DECODE_FAILED' : 'AUDIO_EXTRACTION_FAILED', `${operation} did not complete.`);
  const progress = progressMetadata(result.stdout);
  if (!progress.completed || !Number.isFinite(progress.durationMs) || progress.durationMs <= 0) {
    fail(operation === 'Video decode' ? 'VIDEO_DECODE_INCOMPLETE' : 'AUDIO_EXTRACTION_INCOMPLETE', `${operation} did not fully process the source.`);
  }
  return progress;
}

function assertInspectionProcess(result) {
  if (result.timedOut) fail('FFMPEG_TIMEOUT', 'Media inspection timed out.');
  if (result.diagnosticsExceeded) fail('FFMPEG_DIAGNOSTIC_LIMIT', 'Media inspection diagnostics exceeded the safe limit.');
  if (result.code !== 0) {
    if (/Stream map ['"]?0:v:0['"]? matches no streams/i.test(result.stderr)) {
      fail('VIDEO_STREAM_REQUIRED', 'Enrollment source must contain video.');
    }
    fail('MEDIA_INSPECTION_FAILED', 'Enrollment source could not be inspected.');
  }
}

function inputStreamMetadata(stderr) {
  const inputSection = String(stderr).split(/\r?\nStream mapping:/, 1)[0];
  const lines = inputSection.split(/\r?\n/);
  const streamLines = lines.filter(line => /^\s+Stream #\d+:\d+/.test(line));
  const videos = streamLines.filter(line => /:\s*Video:\s*/.test(line));
  const audios = streamLines.filter(line => /:\s*Audio:\s*/.test(line));
  const dimensions = [...(videos[0] || '').matchAll(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[,\s\[])/g)]
    .map(match => [Number(match[1]), Number(match[2])])
    .find(([width, height]) => width >= 16 && height >= 16 && width <= 16_384 && height <= 16_384);
  const inputFormat = /^Input #0,\s*(.+?),\s*from\s/m.exec(inputSection)?.[1]?.toLowerCase();
  const rotationMatch = /rotation of\s+(-?\d+(?:\.\d+)?)\s+degrees/i.exec(inputSection)
    || /\brotate\s*:\s*(-?\d+(?:\.\d+)?)/i.exec(inputSection);
  const frameRateMatch = /(?:^|[,\s])(\d+(?:\.\d+)?)\s+fps(?:[,\s]|$)/i.exec(videos[0] || '');
  const durationMatch = /\bDuration:\s*(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(inputSection);
  const declaredDurationMs = durationMatch
    ? ((Number(durationMatch[1]) * 3_600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])) * 1_000
    : undefined;
  return {
    inputFormat,
    videoStreams: videos.length,
    audioStreams: audios.length,
    width: dimensions?.[0],
    height: dimensions?.[1],
    videoCodec: /Video:\s*([^\s,]+)/.exec(videos[0] || '')?.[1]?.toLowerCase(),
    audioCodec: /Audio:\s*([^\s,]+)/.exec(audios[0] || '')?.[1]?.toLowerCase(),
    frameRate: frameRateMatch ? Number(frameRateMatch[1]) : undefined,
    declaredDurationMs,
    rotationDegrees: rotationMatch ? Number(rotationMatch[1]) : 0,
  };
}

async function prefixBytes(pathname, maximum = 4096) {
  let handle;
  try {
    handle = await open(pathname, 'r');
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    fail('SOURCE_CHANGED', 'Enrollment source changed during processing.');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function mp4Brand(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'ftyp' && size >= 12 && offset + size <= buffer.length) {
      return buffer.subarray(offset + 8, offset + 12).toString('ascii');
    }
    if (size < 8 || offset + size > buffer.length) break;
    offset += size;
  }
  return null;
}

function webmDocType(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return null;
  for (let offset = 4; offset + 3 < buffer.length; offset += 1) {
    if (buffer[offset] !== 0x42 || buffer[offset + 1] !== 0x82) continue;
    const first = buffer[offset + 2];
    let lengthBytes = 1;
    let mask = 0x80;
    while (lengthBytes <= 8 && !(first & mask)) { lengthBytes += 1; mask >>= 1; }
    if (lengthBytes > 8 || offset + 2 + lengthBytes > buffer.length) return null;
    let length = first & (mask - 1);
    for (let index = 1; index < lengthBytes; index += 1) length = (length * 256) + buffer[offset + 2 + index];
    const start = offset + 2 + lengthBytes;
    if (length < 1 || length > 16 || start + length > buffer.length) return null;
    return buffer.subarray(start, start + length).toString('ascii').toLowerCase();
  }
  return null;
}

function detectContainer(buffer, inputFormat) {
  if (inputFormat?.includes('mov') && inputFormat.includes('mp4')) {
    const brand = mp4Brand(buffer);
    if (brand === 'qt  ') return { container: 'mov', mimeType: 'video/quicktime', brand };
    if (brand && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/i.test(brand)) {
      return { container: 'mp4', mimeType: 'video/mp4', brand };
    }
  }
  if (inputFormat?.includes('matroska') && inputFormat.includes('webm') && webmDocType(buffer) === 'webm') {
    return { container: 'webm', mimeType: 'video/webm', brand: 'webm' };
  }
  fail('CONTAINER_UNSUPPORTED', 'Use a valid MP4, MOV, or WebM video.');
}

function assertSourceContract(streams, container) {
  if (streams.videoStreams < 1) fail('VIDEO_STREAM_REQUIRED', 'Enrollment source must contain video.');
  if (streams.audioStreams < 1) fail('AUDIO_STREAM_REQUIRED', 'Enrollment source must contain audio.');
  if (streams.videoStreams !== 1 || streams.audioStreams !== 1) fail('STREAM_COUNT_UNSUPPORTED', 'Enrollment source must contain exactly one video and one audio stream.');
  if (!streams.width || !streams.height) fail('DIMENSIONS_UNAVAILABLE', 'Enrollment source dimensions could not be verified.');
  if (streams.width > ENROLLMENT_MEDIA_LIMITS.maxDimension || streams.height > ENROLLMENT_MEDIA_LIMITS.maxDimension) {
    fail('DIMENSION_LIMIT', 'Enrollment source dimensions exceed 4096 pixels.');
  }
  const pixelArea = streams.width * streams.height;
  if (!Number.isSafeInteger(pixelArea) || pixelArea > ENROLLMENT_MEDIA_LIMITS.maxPixelArea) {
    fail('PIXEL_AREA_LIMIT', 'Enrollment source decoded pixel area is unsupported.');
  }
  if (!Number.isFinite(streams.frameRate) || streams.frameRate <= 0) {
    fail('FRAME_RATE_UNAVAILABLE', 'Enrollment source frame rate could not be verified.');
  }
  if (streams.frameRate > ENROLLMENT_MEDIA_LIMITS.maxFrameRate) {
    fail('FRAME_RATE_LIMIT', 'Enrollment source frame rate is unsupported.');
  }
  if (pixelArea * streams.frameRate > ENROLLMENT_MEDIA_LIMITS.maxPixelRate) {
    fail('PIXEL_RATE_LIMIT', 'Enrollment source decoded pixel rate is unsupported.');
  }
  if (Number.isFinite(streams.declaredDurationMs) && streams.declaredDurationMs > ENROLLMENT_MEDIA_LIMITS.maxDurationMs) {
    fail('DURATION_LIMIT', 'Enrollment source exceeds 60 seconds.');
  }
  if (!ENROLLMENT_MEDIA_LIMITS.supportedVideoCodecs[container].includes(streams.videoCodec)) {
    fail('VIDEO_CODEC_UNSUPPORTED', 'Enrollment source video codec is unsupported.');
  }
  if (container === 'webm' && streams.audioCodec !== ENROLLMENT_MEDIA_LIMITS.webmAudioCodec) {
    fail('AUDIO_CODEC_UNSUPPORTED', 'WebM enrollment source must use Opus audio.');
  }
}

function assertDecodedVideoBudget(progress, streams) {
  if (progress.durationMs < ENROLLMENT_MEDIA_LIMITS.minDurationMs) {
    fail('DURATION_MINIMUM', 'Enrollment source must be at least 5 seconds.');
  }
  if (progress.durationMs > ENROLLMENT_MEDIA_LIMITS.maxDurationMs) {
    fail('DURATION_LIMIT', 'Enrollment source exceeds 60 seconds.');
  }
  if (progress.frames > ENROLLMENT_MEDIA_LIMITS.maxDecodedFrames) {
    fail('FRAME_COUNT_LIMIT', 'Enrollment source contains too many decoded video frames.');
  }
  const decodedFrameRate = progress.frames / (progress.durationMs / 1_000);
  if (!Number.isFinite(decodedFrameRate) || decodedFrameRate > ENROLLMENT_MEDIA_LIMITS.maxFrameRate * 1.01) {
    fail('FRAME_RATE_LIMIT', 'Enrollment source decoded frame rate is unsupported.');
  }
  if ((streams.width * streams.height * decodedFrameRate) > ENROLLMENT_MEDIA_LIMITS.maxPixelRate * 1.01) {
    fail('PIXEL_RATE_LIMIT', 'Enrollment source decoded pixel rate is unsupported.');
  }
}

function wavMetadata(buffer) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
    || buffer.readUInt32LE(4) + 8 !== buffer.length) fail('AUDIO_OUTPUT_INVALID', 'Extracted audio is not a complete WAV file.');
  let offset = 12;
  let format;
  let dataOffset;
  let dataBytes;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) fail('AUDIO_OUTPUT_INVALID', 'Extracted WAV structure is invalid.');
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12), bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') { dataOffset = start; dataBytes = size; }
    offset = start + size + (size % 2);
  }
  if (!format || !dataOffset || !dataBytes || format.encoding !== 1
    || format.channels !== ENROLLMENT_MEDIA_LIMITS.audioChannels
    || format.sampleRate !== ENROLLMENT_MEDIA_LIMITS.audioSampleRate
    || format.bitsPerSample !== ENROLLMENT_MEDIA_LIMITS.audioBitsPerSample
    || format.byteRate !== 32_000 || format.blockAlign !== 2 || dataBytes % 2) {
    fail('AUDIO_OUTPUT_INVALID', 'Extracted audio does not match the mono 16 kHz 16-bit PCM contract.');
  }
  return { ...format, dataOffset, dataBytes, durationMs: (dataBytes / format.byteRate) * 1000 };
}

function audioEnergy(buffer, metadata) {
  const samples = metadata.dataBytes / 2;
  let sum = 0;
  for (let offset = metadata.dataOffset; offset < metadata.dataOffset + metadata.dataBytes; offset += 2) sum += buffer.readInt16LE(offset);
  const mean = sum / samples;
  let squared = 0;
  for (let offset = metadata.dataOffset; offset < metadata.dataOffset + metadata.dataBytes; offset += 2) {
    const centered = buffer.readInt16LE(offset) - mean;
    squared += centered * centered;
  }
  const normalizedRms = Math.sqrt(squared / samples) / 32768;
  const rmsDbfs = normalizedRms > 0 ? 20 * Math.log10(normalizedRms) : Number.NEGATIVE_INFINITY;
  if (rmsDbfs < ENROLLMENT_MEDIA_LIMITS.minimumAudioRmsDbfs) {
    fail('AUDIO_NEAR_SILENT', 'Extracted audio signal is below the enrollment energy threshold.');
  }
  return { rmsDbfs };
}

function publicConnectionlessVersion() {
  return `${DERIVATION_VERSION}/ffmpeg-static`;
}

/**
 * Pure local media derivation. ffmpegPath/tempRoot/timeoutMs are trusted server
 * injection points for tests and runtime packaging, never request fields.
 */
export async function prepareEnrollmentMedia({ filePath, expectedSha256, consent, ffmpegPath = defaultFfmpegPath, tempRoot = tmpdir(), timeoutMs } = {}) {
  const pathname = localFilePath(filePath);
  const expected = normalizeExpectedSha256(expectedSha256);
  assertConsent(consent, expected);
  const timeout = boundedTimeout(timeoutMs);
  const deadlineAt = Date.now() + timeout;
  const before = await stableRegularFile(pathname);
  const initialSha256 = await hashFile(pathname);
  if (initialSha256 !== expected) fail('SOURCE_HASH_MISMATCH', 'Enrollment source does not match its expected SHA-256.');

  const inspection = await runFfmpeg(ffmpegPath, [
    ...commonInputArgs(pathname), '-map', '0:v:0', '-frames:v', '0', '-an', '-f', 'null', '-',
  ], remainingTimeout(deadlineAt));
  assertInspectionProcess(inspection);
  const streams = inputStreamMetadata(inspection.stderr);
  const container = detectContainer(await prefixBytes(pathname), streams.inputFormat);
  assertSourceContract(streams, container.container);

  const videoDecode = await runFfmpeg(ffmpegPath, [
    ...commonInputArgs(pathname), '-map', '0:v:0', '-an', '-threads', '1', '-f', 'null', '-',
  ], remainingTimeout(deadlineAt));
  const videoProgress = assertProcess(videoDecode, 'Video decode');
  if (!videoProgress.frames) fail('VIDEO_FRAMES_REQUIRED', 'Enrollment source contains no decoded video frames.');
  assertDecodedVideoBudget(videoProgress, streams);

  let temporaryDirectory;
  try { temporaryDirectory = await mkdtemp(join(resolve(tempRoot), 'lux-enrollment-media-')); } catch {
    fail('TEMPORARY_STORAGE_UNAVAILABLE', 'Enrollment audio workspace is unavailable.');
  }
  let audioBuffer;
  let audioProgress;
  try {
    const audioPath = join(temporaryDirectory, 'voice.wav');
    const extraction = await runFfmpeg(ffmpegPath, [
      ...commonInputArgs(pathname), '-map', '0:a:0', '-vn', '-threads', '1',
      '-t', String(ENROLLMENT_MEDIA_LIMITS.maxAudioWriteDurationMs / 1_000),
      '-ac', String(ENROLLMENT_MEDIA_LIMITS.audioChannels),
      '-ar', String(ENROLLMENT_MEDIA_LIMITS.audioSampleRate),
      '-c:a', 'pcm_s16le', '-fs', String(ENROLLMENT_MEDIA_LIMITS.maxAudioWriteBytes),
      '-f', 'wav', '-n', audioPath,
    ], remainingTimeout(deadlineAt));
    audioProgress = assertProcess(extraction, 'Audio extraction');
    let audioInfo;
    try { audioInfo = await lstat(audioPath); } catch { fail('AUDIO_OUTPUT_INVALID', 'Extracted audio is unavailable.'); }
    if (!audioInfo.isFile() || audioInfo.isSymbolicLink() || audioInfo.size <= 0
      || audioInfo.size > ENROLLMENT_MEDIA_LIMITS.maxAudioBytes) {
      fail('AUDIO_BYTE_LIMIT', 'Extracted audio exceeds the 3 MB enrollment limit.');
    }
    try { audioBuffer = await readFile(audioPath); } catch { fail('AUDIO_OUTPUT_INVALID', 'Extracted audio is unavailable.'); }
  } finally {
    try { await rm(temporaryDirectory, { recursive: true, force: true }); } catch {
      fail('TEMPORARY_CLEANUP_FAILED', 'Enrollment audio workspace could not be cleaned.');
    }
  }

  remainingTimeout(deadlineAt);
  const wav = wavMetadata(audioBuffer);
  const energy = audioEnergy(audioBuffer, wav);
  const videoDurationMs = videoProgress.durationMs;
  const audioDurationMs = wav.durationMs;
  const durationMs = Math.max(videoDurationMs, audioDurationMs);
  const durationToleranceMs = Math.max(750, durationMs * 0.05);
  if (Math.abs(videoDurationMs - audioDurationMs) > durationToleranceMs
    || Math.abs(audioProgress.durationMs - audioDurationMs) > durationToleranceMs) {
    fail('STREAM_DURATION_MISMATCH', 'Enrollment source audio and video durations do not match.');
  }
  if (videoDurationMs < ENROLLMENT_MEDIA_LIMITS.minDurationMs || audioDurationMs < ENROLLMENT_MEDIA_LIMITS.minDurationMs) {
    fail('DURATION_MINIMUM', 'Enrollment source must be at least 5 seconds.');
  }
  if (videoDurationMs > ENROLLMENT_MEDIA_LIMITS.maxDurationMs || audioDurationMs > ENROLLMENT_MEDIA_LIMITS.maxDurationMs) {
    fail('DURATION_LIMIT', 'Enrollment source exceeds 60 seconds.');
  }

  let after;
  try { after = await lstat(pathname); } catch { fail('SOURCE_CHANGED', 'Enrollment source changed during processing.'); }
  assertStableFile(before, after);
  if (await hashFile(pathname) !== expected) fail('SOURCE_CHANGED', 'Enrollment source changed during processing.');
  remainingTimeout(deadlineAt);

  const audioSha256 = createHash('sha256').update(audioBuffer).digest('hex');
  return {
    audioBuffer,
    audioSha256,
    audioBytes: audioBuffer.length,
    audioMimeType: 'audio/wav',
    durationMs: Math.round(audioDurationMs),
    audioAnalysis: {
      rmsDbfs: Number(energy.rmsDbfs.toFixed(2)),
      minimumRmsDbfs: ENROLLMENT_MEDIA_LIMITS.minimumAudioRmsDbfs,
      speechOrIdentityClassified: false,
    },
    source: {
      sha256: expected,
      bytes: before.size,
      durationMs: Math.round(durationMs),
      videoDurationMs: Math.round(videoDurationMs),
      audioDurationMs: Math.round(audioDurationMs),
      width: streams.width,
      height: streams.height,
      rotationDegrees: streams.rotationDegrees,
      container: container.container,
      mimeType: container.mimeType,
      containerBrand: container.brand,
      videoCodec: streams.videoCodec,
      audioCodec: streams.audioCodec,
      videoStreams: streams.videoStreams,
      audioStreams: streams.audioStreams,
      fullDecode: true,
      inspectionVersion: publicConnectionlessVersion(),
    },
    derivationVersion: DERIVATION_VERSION,
  };
}
