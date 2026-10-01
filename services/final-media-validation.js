import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  OUTPUT_ACCEPTANCE_POLICY,
  OUTPUT_ACCEPTANCE_VERSION,
  finalOutputPath,
} from '../lib/video-os-output-acceptance.js';

const MAX_FINAL_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_MS = 180_000;
const DECODE_TIMEOUT_MS = 120_000;
const DECODE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const VALIDATOR_VERSION = 'final-media-validator-v1';
const DIMENSIONS = Object.freeze({
  landscape: Object.freeze([1920, 1080]),
  vertical: Object.freeze([1080, 1920]),
  square: Object.freeze([1080, 1080]),
});

let ffmpegVersionPromise;

function validationError(code, message) {
  return Object.assign(new Error(message), {
    statusCode: 422,
    failureCategory: 'FINAL_MEDIA_VALIDATION',
    validationCode: code,
  });
}

function localFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw validationError('INVALID_INPUT', 'Final media must be a local file.');
  }
  const candidate = filePath.trim();
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate);
  if (hasProtocol || candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    throw validationError('INPUT_PROTOCOL_DENIED', 'Final media must be a local file.');
  }
  return resolve(candidate);
}

function runBounded(args, { timeoutMs, outputLimitBytes }) {
  return new Promise((resolveProcess, rejectProcess) => {
    if (!ffmpegPath) {
      rejectProcess(validationError('FFMPEG_UNAVAILABLE', 'Final media validation is unavailable.'));
      return;
    }

    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const stop = () => {
      if (!child.killed) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const append = (stream, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes <= outputLimitBytes) stdout += chunk;
      } else {
        stderrBytes += bytes;
        if (stderrBytes <= outputLimitBytes) stderr += chunk;
      }
      if (stdoutBytes > outputLimitBytes || stderrBytes > outputLimitBytes) {
        outputExceeded = true;
        stop();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectProcess(validationError('FFMPEG_UNAVAILABLE', 'Final media validation is unavailable.'));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ code, signal, stdout, stderr, timedOut, outputExceeded });
    });
  });
}

async function ffmpegVersion() {
  if (!ffmpegVersionPromise) {
    ffmpegVersionPromise = runBounded(['-hide_banner', '-version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
      outputLimitBytes: 8 * 1024,
    }).then((result) => {
      if (result.timedOut || result.outputExceeded || result.code !== 0) {
        throw validationError('FFMPEG_UNAVAILABLE', 'Final media validation is unavailable.');
      }
      const match = /^ffmpeg version\s+([^\s]+)/m.exec(result.stdout);
      if (!match) throw validationError('FFMPEG_UNAVAILABLE', 'Final media validation is unavailable.');
      return `${VALIDATOR_VERSION}/ffmpeg-${match[1]}`;
    });
  }
  return ffmpegVersionPromise;
}

async function hashLocalFile(pathname) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(pathname)) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    throw validationError('INPUT_CHANGED', 'Final media changed during validation.');
  }
}

function inputStreamLines(stderr) {
  const inputSection = String(stderr).split(/\r?\nStream mapping:/, 1)[0];
  return inputSection.split(/\r?\n/).filter((line) => /^\s+Stream #\d+:\d+/.test(line));
}

function streamMetadata(stderr) {
  const lines = inputStreamLines(stderr);
  const videos = lines.filter((line) => /:\s*Video:\s*/.test(line));
  const audios = lines.filter((line) => /:\s*Audio:\s*/.test(line));
  const dimensions = videos.map((line) => {
    const candidates = [...line.matchAll(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?=[,\s\[])/g)];
    const match = candidates.find((candidate) => {
      const width = Number(candidate[1]);
      const height = Number(candidate[2]);
      return width >= 16 && width <= 16_384 && height >= 16 && height <= 16_384;
    });
    return match ? [Number(match[1]), Number(match[2])] : null;
  });
  return { videoStreams: videos.length, audioStreams: audios.length, dimensions,
    videoCodec: /Video:\s*([^\s,]+)/.exec(videos[0] || '')?.[1],
    audioCodec: /Audio:\s*([^\s,]+)/.exec(audios[0] || '')?.[1] };
}

function decodedProgress(stdout) {
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

function decodeArgs(pathname, streamType) {
  const isVideo = streamType === 'video';
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-stats_period', '5',
    '-progress', 'pipe:1',
    '-xerror',
    '-err_detect', 'explode',
    // Only the local file and the explicitly controlled stdout pipe are
    // permitted. Forcing the MOV/MP4 demuxer also prevents a local playlist
    // or manifest from auto-selecting HLS and fetching a referenced URL.
    '-protocol_whitelist', 'file,pipe',
    '-f', 'mov',
    '-i', pathname,
    '-map', isVideo ? '0:v' : '0:a',
    isVideo ? '-an' : '-vn',
    '-f', 'null',
    '-',
  ];
}

function assertDecodedProcess(decoded, streamType) {
  if (decoded.timedOut) throw validationError('DECODE_TIMEOUT', 'Final media decode timed out.');
  if (decoded.outputExceeded) throw validationError('DIAGNOSTIC_LIMIT', 'Final media diagnostics exceeded the safe limit.');
  if (decoded.code !== 0) throw validationError('DECODE_FAILED', 'Final media could not be fully decoded.');
  const progress = decodedProgress(decoded.stdout);
  if (!progress.completed) throw validationError('DECODE_INCOMPLETE', 'Final media decode did not complete.');
  if (streamType === 'video' && !progress.frames) {
    throw validationError('VIDEO_FRAMES_REQUIRED', 'Final media contains no decoded video frames.');
  }
  if (!Number.isFinite(progress.durationMs) || progress.durationMs <= 0) {
    throw validationError('DURATION_INVALID', 'Final media duration is invalid.');
  }
  return progress;
}

async function stableRegularFile(pathname) {
  let info;
  try {
    info = await lstat(pathname);
  } catch {
    throw validationError('INPUT_UNAVAILABLE', 'Final media is unavailable.');
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw validationError('INVALID_INPUT', 'Final media must be a local regular file.');
  }
  if (!Number.isSafeInteger(info.size) || info.size <= 0) {
    throw validationError('EMPTY_MEDIA', 'Final media is empty.');
  }
  if (info.size > MAX_FINAL_BYTES) {
    throw validationError('BYTE_LIMIT', 'Final media exceeds the 100 MiB limit.');
  }
  return info;
}

function assertStableFile(before, after) {
  if (!after.isFile() || after.isSymbolicLink()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) {
    throw validationError('INPUT_CHANGED', 'Final media changed during validation.');
  }
}

/**
 * Fully decodes a local final-media candidate with the bundled FFmpeg binary.
 * This intentionally performs no job-format check so callers can inspect a
 * downloaded provider source before composing the canonical final artifact.
 */
export async function inspectMedia(filePath) {
  'use step';
  const pathname = localFilePath(filePath);
  const before = await stableRegularFile(pathname);
  const [validatorVersion, sha256, videoDecode, audioDecode] = await Promise.all([
    ffmpegVersion(),
    hashLocalFile(pathname),
    runBounded(decodeArgs(pathname, 'video'), {
      timeoutMs: DECODE_TIMEOUT_MS,
      outputLimitBytes: DECODE_OUTPUT_LIMIT_BYTES,
    }),
    runBounded(decodeArgs(pathname, 'audio'), {
      timeoutMs: DECODE_TIMEOUT_MS,
      outputLimitBytes: DECODE_OUTPUT_LIMIT_BYTES,
    }),
  ]);

  let after;
  try {
    after = await lstat(pathname);
  } catch {
    throw validationError('INPUT_CHANGED', 'Final media changed during validation.');
  }
  assertStableFile(before, after);

  const streams = streamMetadata(videoDecode.stderr);
  if (!streams.videoStreams) throw validationError('VIDEO_STREAM_REQUIRED', 'Final media must contain a video stream.');
  if (!streams.audioStreams) throw validationError('AUDIO_STREAM_REQUIRED', 'Final media must contain an audio stream.');
  if (streams.videoStreams !== 1 || streams.audioStreams !== 1) {
    throw validationError('STREAM_COUNT_UNSUPPORTED', 'Final media must contain exactly one video and one audio stream.');
  }
  if (streams.dimensions.some((value) => !value)) {
    throw validationError('DIMENSIONS_UNAVAILABLE', 'Final media dimensions could not be verified.');
  }
  const videoProgress = assertDecodedProcess(videoDecode, 'video');
  const audioProgress = assertDecodedProcess(audioDecode, 'audio');
  const durationMs = Math.max(videoProgress.durationMs, audioProgress.durationMs);
  if (durationMs > MAX_DURATION_MS) {
    throw validationError('DURATION_LIMIT', 'Final media exceeds the 180 second limit.');
  }
  // A long audio stream must not hide a prematurely truncated video stream
  // (or vice versa). The tolerance absorbs codec frame/sample boundaries.
  const streamToleranceMs = Math.max(500, durationMs * 0.05);
  if (Math.abs(videoProgress.durationMs - audioProgress.durationMs) > streamToleranceMs) {
    throw validationError('STREAM_DURATION_MISMATCH', 'Final media audio and video durations do not match.');
  }

  const [width, height] = streams.dimensions[0];
  return {
    bytes: before.size,
    sha256,
    width,
    height,
    durationMs: Math.round(durationMs),
    videoDurationMs: Math.round(videoProgress.durationMs),
    audioDurationMs: Math.round(audioProgress.durationMs),
    videoStreams: streams.videoStreams,
    audioStreams: streams.audioStreams,
    videoCodec: streams.videoCodec,
    audioCodec: streams.audioCodec,
    fullDecode: true,
    validatorVersion,
  };
}

/**
 * Validates the canonical final artifact and creates persisted acceptance
 * evidence bound to the exact bytes and canonical private pathname.
 */
export async function validateFinalMedia(filePath, { job, expectedDurationMs } = {}) {
  'use step';
  if (!job || typeof job.id !== 'string' || !job.id.trim()
    || typeof job.accountId !== 'string' || !job.accountId.trim()
    || !['heygen', 'sadtalker'].includes(job.provider)) {
    throw validationError('JOB_BINDING_INVALID', 'Final media job binding is invalid.');
  }
  const expectedDimensions = DIMENSIONS[job.format];
  if (!expectedDimensions) throw validationError('FORMAT_INVALID', 'Final media format is invalid.');
  if (!Number.isFinite(expectedDurationMs) || expectedDurationMs <= 0) {
    throw validationError('EXPECTED_DURATION_REQUIRED', 'Expected media duration is required.');
  }

  const inspected = await inspectMedia(filePath);
  if (inspected.videoCodec !== 'h264' || inspected.audioCodec !== 'aac') {
    throw validationError('CODEC_UNSUPPORTED', 'Final media must use H.264 video and AAC audio.');
  }
  if (inspected.width !== expectedDimensions[0] || inspected.height !== expectedDimensions[1]) {
    throw validationError('DIMENSIONS_MISMATCH', 'Final media dimensions do not match the requested format.');
  }
  const toleranceMs = Math.max(500, expectedDurationMs * 0.05);
  if (Math.abs(inspected.durationMs - expectedDurationMs) > toleranceMs) {
    throw validationError('DURATION_MISMATCH', 'Final media duration does not match its source.');
  }

  const privatePathname = finalOutputPath(job.accountId, job.id, inspected.sha256);
  const acceptance = {
    version: OUTPUT_ACCEPTANCE_VERSION,
    policy: OUTPUT_ACCEPTANCE_POLICY,
    validatorVersion: inspected.validatorVersion,
    status: 'accepted',
    jobId: job.id,
    accountId: job.accountId,
    privatePathname,
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    validatedAt: new Date().toISOString(),
    media: {
      fullDecode: inspected.fullDecode,
      videoStreams: inspected.videoStreams,
      audioStreams: inspected.audioStreams,
      videoCodec: inspected.videoCodec,
      audioCodec: inspected.audioCodec,
      width: inspected.width,
      height: inspected.height,
      durationMs: inspected.durationMs,
      expectedDurationMs,
      durationToleranceMs: toleranceMs,
    },
    checks: {
      duration: true,
      dimensions: true,
      byteLimit: true,
    },
  };

  return {
    bytes: inspected.bytes,
    sha256: inspected.sha256,
    width: inspected.width,
    height: inspected.height,
    durationMs: inspected.durationMs,
    acceptance,
  };
}

export const FINAL_MEDIA_VALIDATION_LIMITS = Object.freeze({
  maxBytes: MAX_FINAL_BYTES,
  maxDurationMs: MAX_DURATION_MS,
  decodeTimeoutMs: DECODE_TIMEOUT_MS,
});
