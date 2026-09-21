import crypto from 'node:crypto';
import { getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';

const DEFAULT_API_ORIGIN = 'https://api.runpod.ai/v2';
// Base64 expands bytes by roughly 4/3. These raw-byte ceilings keep the JSON
// envelope below RunPod's bounded queue payload/result limits.
const DEFAULT_INPUT_LIMIT = 7_000_000;
const DEFAULT_OUTPUT_LIMIT = 7_000_000;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;
const TERMINAL_FAILURES = new Set(['FAILED', 'TIMED_OUT', 'CANCELLED']);
const ACTIVE_STATUSES = new Set(['IN_QUEUE', 'IN_PROGRESS']);

function failure(message, failureCategory, statusCode = 503) {
  return Object.assign(new Error(message), { failureCategory, statusCode });
}

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function positiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeName(value) {
  return String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';
}

function requireConfig(env) {
  const endpointId = String(env.VIDEO_OS_RUNPOD_ENDPOINT_ID || '').trim();
  const apiKey = String(env.RUNPOD_API_KEY || '').trim();
  const apiOrigin = String(env.VIDEO_OS_RUNPOD_API_ORIGIN || DEFAULT_API_ORIGIN).trim().replace(/\/+$/, '');
  if (!PROVIDER_ID_PATTERN.test(endpointId) || !apiKey || !apiOrigin.startsWith('https://')) {
    throw failure('RunPod Standard rendering is not configured.', 'CONFIG_MISSING');
  }
  return {
    apiKey,
    apiOrigin,
    endpointId,
    inputLimit: positiveInteger(env.VIDEO_OS_RUNPOD_MAX_INPUT_BYTES, DEFAULT_INPUT_LIMIT),
    outputLimit: positiveInteger(env.VIDEO_OS_RUNPOD_MAX_OUTPUT_BYTES, DEFAULT_OUTPUT_LIMIT),
    timeoutMs: positiveInteger(env.VIDEO_OS_RUNPOD_TIMEOUT_MS, 30_000),
    allowSimulatedOutput: enabled(env.VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT),
  };
}

async function responseJson(response, category) {
  let payload;
  try { payload = await response.json(); } catch { throw failure('RunPod returned an unreadable response.', category, 502); }
  if (response.ok) return payload;
  if (response.status === 429) throw failure('RunPod rate limit reached.', 'RATE_LIMIT', 429);
  if (response.status >= 500) throw failure('RunPod service is unavailable.', category, 502);
  throw failure('RunPod rejected the Standard render request.', 'PROVIDER_REJECTED', 502);
}

async function assetBytes(asset, getter) {
  const result = await getter(asset.privatePathname);
  if (!result?.stream) throw failure('Standard render source asset is unavailable.', 'PERSISTENCE', 410);
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

function assertAssetIdentity(bytes, asset, label) {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== Number(asset.bytes) || sha256 !== String(asset.sha256 || '').toLowerCase()) {
    throw failure(`${label} no longer matches its approved source identity.`, 'SOURCE_POLICY', 409);
  }
  return sha256;
}

function decodeVerifiedOutput(output, config) {
  if (!output || output.mimeType !== 'video/mp4' || typeof output.videoBase64 !== 'string') {
    throw failure('RunPod completed without a valid MP4 result.', 'PROVIDER_REJECTED', 502);
  }
  if (output.simulation === true && !config.allowSimulatedOutput) {
    throw failure('RunPod returned simulated output while real inference was required.', 'PROVIDER_REJECTED', 502);
  }
  if (output.videoBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(output.videoBase64)) {
    throw failure('RunPod output encoding was invalid.', 'PROVIDER_REJECTED', 502);
  }
  const bytes = Buffer.from(output.videoBase64, 'base64');
  if (bytes.toString('base64') !== output.videoBase64) throw failure('RunPod output encoding was invalid.', 'PROVIDER_REJECTED', 502);
  if (!bytes.length || bytes.length > config.outputLimit || Number(output.bytes) !== bytes.length) {
    throw failure('RunPod output size was invalid.', 'PROVIDER_REJECTED', 502);
  }
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw failure('RunPod output was not an MP4.', 'PROVIDER_REJECTED', 502);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== String(output.sha256 || '').toLowerCase()) {
    throw failure('RunPod output hash did not match its payload.', 'PROVIDER_REJECTED', 502);
  }
  return { ...output, bytes: bytes.length, sha256, videoBase64: bytes.toString('base64') };
}

export function standardProviderMode(env = process.env) {
  const mode = String(env.VIDEO_OS_STANDARD_PROVIDER || 'simulation').trim().toLowerCase();
  if (mode === 'simulation' || mode === 'runpod') return mode;
  throw failure(`Unsupported Standard provider mode: ${mode}`, 'CONFIG_MISSING');
}

export async function submitRunpodStandard(resolved, { format, title } = {}, dependencies = {}) {
  'use step';
  const env = dependencies.env || process.env;
  const config = requireConfig(env);
  const getter = dependencies.getPrivateBlob || getPrivateBlob;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const [portraitBytes, audioBytes] = await Promise.all([
    assetBytes(resolved.assets.portrait, getter),
    assetBytes(resolved.assets.drivenAudio, getter),
  ]);
  if (portraitBytes.length + audioBytes.length > config.inputLimit) {
    throw failure('Standard sources exceed the bounded RunPod request limit.', 'SOURCE_TOO_LARGE', 413);
  }
  const portraitSha256 = assertAssetIdentity(portraitBytes, { ...resolved.assets.portrait, bytes: resolved.input.portrait.bytes }, 'Portrait');
  const audioSha256 = assertAssetIdentity(audioBytes, { ...resolved.assets.drivenAudio, bytes: resolved.input.drivenAudio.bytes }, 'Narration');
  const body = {
    input: {
      schemaVersion: 1,
      jobId: resolved.input.jobId,
      correlationId: resolved.input.correlationId,
      format,
      title: String(title || 'video-os').slice(0, 120),
      portrait: { mimeType: resolved.input.portrait.mimeType, sha256: portraitSha256, base64: portraitBytes.toString('base64') },
      drivenAudio: { mimeType: resolved.input.drivenAudio.mimeType, sha256: audioSha256, durationMs: resolved.input.drivenAudio.durationMs, base64: audioBytes.toString('base64') },
    },
  };
  let response;
  try {
    response = await fetchImpl(`${config.apiOrigin}/${encodeURIComponent(config.endpointId)}/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw failure(`RunPod submission outcome is unknown: ${String(error?.message || error).slice(0, 160)}`, 'PROVIDER_SUBMIT_UNKNOWN', 502);
  }
  const payload = await responseJson(response, 'PROVIDER_SUBMIT_UNKNOWN');
  const providerJobId = String(payload.id || '').trim();
  if (!PROVIDER_ID_PATTERN.test(providerJobId)) throw failure('RunPod response did not include a valid job id.', 'PROVIDER_SUBMIT_UNKNOWN', 502);
  return { providerJobId };
}

export async function pollRunpodStandard(providerJobId, dependencies = {}) {
  'use step';
  if (!PROVIDER_ID_PATTERN.test(String(providerJobId || ''))) throw failure('RunPod job id is invalid.', 'VALIDATION', 400);
  const env = dependencies.env || process.env;
  const config = requireConfig(env);
  const fetchImpl = dependencies.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(`${config.apiOrigin}/${encodeURIComponent(config.endpointId)}/status/${encodeURIComponent(providerJobId)}`, {
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` },
    });
  } catch (error) {
    throw failure(`RunPod status check failed: ${String(error?.message || error).slice(0, 160)}`, 'PROVIDER_POLL', 502);
  }
  const payload = await responseJson(response, 'PROVIDER_POLL');
  const status = String(payload.status || '').trim().toUpperCase();
  if (ACTIVE_STATUSES.has(status)) return { ready: false, status };
  if (TERMINAL_FAILURES.has(status)) throw failure(`RunPod Standard render ended with ${status}.`, status === 'TIMED_OUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_REJECTED', 502);
  if (status !== 'COMPLETED') throw failure('RunPod returned an unknown job status.', 'PROVIDER_POLL', 502);
  return { ready: true, status, output: decodeVerifiedOutput(payload.output, config) };
}

export async function persistRunpodStandardOutput(job, output, dependencies = {}) {
  'use step';
  const writer = dependencies.putPrivateBlob || putPrivateBlob;
  const config = requireConfig(dependencies.env || process.env);
  const verified = decodeVerifiedOutput(output, config);
  const bytes = Buffer.from(verified.videoBase64, 'base64');
  const pathname = `video-os/finals/${safeName(job.accountId)}/${safeName(job.id)}-${verified.sha256}.mp4`;
  const blob = await writer(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, {
    contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true,
  });
  if (blob?.pathname !== pathname) throw failure('Private output storage returned a mismatched pathname.', 'FINAL_STORE', 502);
  return {
    privatePathname: pathname,
    bytes: verified.bytes,
    sha256: verified.sha256,
    width: Number(verified.width) || null,
    height: Number(verified.height) || null,
    durationMs: Number(verified.durationMs) || null,
    filename: `${safeName(job.title)}-${job.format}.mp4`,
    simulation: verified.simulation === true,
    adapter: 'standard-sadtalker-runpod',
  };
}
