// Runway Models adapter (server-side only). OFF by default.
//
// Docs (read 2026-11-01):
//  - https://docs.dev.runwayml.com/llms.txt
//  - https://docs.dev.runwayml.com/ai-context.md   (SDK, task lifecycle, RUNWAYML_API_SECRET)
//  - https://docs.dev.runwayml.com/api.md / openapi.json (per-model fields)
//  - https://docs.dev.runwayml.com/guides/pricing.md (credits, $0.01/credit)
//  - https://docs.dev.runwayml.com/assets/outputs.md (output URLs are ephemeral; store them)
//
// Flag VIDEO_OS_RUNWAY_ENABLED must be exactly "true". When it is off every
// entry point throws a 503 error and never imports or constructs the SDK client.
// The secret is read from RUNWAYML_API_SECRET at call time and is never logged,
// returned or included in errors.
import { createHash } from 'node:crypto';

import { MAX_FINISHED_CUSTOMER_VIDEO_BYTES, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';

export const RUNWAY_FEATURE_FLAG = 'VIDEO_OS_RUNWAY_ENABLED';
export const RUNWAY_SECRET_ENV = 'RUNWAYML_API_SECRET';
export const RUNWAY_USD_PER_CREDIT = 0.01;

// Only the models/fields below were confirmed in openapi.json. Anything else is rejected.
export const RUNWAY_MODELS = Object.freeze({
  'gen4.5': Object.freeze({
    creditsPerSecond: 12,
    modes: Object.freeze({
      text_to_video: Object.freeze({ ratios: Object.freeze(['1280:720', '720:1280']), promptTextRequired: true }),
      image_to_video: Object.freeze({ ratios: Object.freeze(['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672']), promptTextRequired: true }),
    }),
    minDuration: 2,
    maxDuration: 10,
  }),
  gen4_turbo: Object.freeze({
    creditsPerSecond: 5,
    modes: Object.freeze({
      image_to_video: Object.freeze({ ratios: Object.freeze(['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672']), promptTextRequired: false }),
    }),
    minDuration: 2,
    maxDuration: 10,
  }),
});

const PROMPT_MAX = 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^[0-9a-f-]{8,64}$/i;

function failure(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode, failureCategory: 'PROVIDER', provider: 'runway' });
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function runwayEnabled(env = process.env) {
  return String(env[RUNWAY_FEATURE_FLAG] ?? '').trim() === 'true';
}

export function runwayLimits(env = process.env) {
  return {
    maxDurationSeconds: boundedInteger(env.VIDEO_OS_RUNWAY_MAX_DURATION_SECONDS, 5, 2, 10),
    maxCreditsPerTask: boundedInteger(env.VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK, 60, 1, 120),
    waitTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS, 10 * 60_000, 30_000, 15 * 60_000),
    requestTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_REQUEST_TIMEOUT_MS, 60_000, 5_000, 120_000),
    downloadTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_DOWNLOAD_TIMEOUT_MS, 120_000, 5_000, 300_000),
    outputHostSuffixes: String(env.VIDEO_OS_RUNWAY_OUTPUT_HOST_SUFFIXES || 'cloudfront.net')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  };
}

export function assertRunwayEnabled(env = process.env) {
  if (!runwayEnabled(env)) throw failure('Runway generation is not enabled.', 'RUNWAY_DISABLED', 503);
}

export function estimateRunwayCredits({ model, duration }) {
  const spec = RUNWAY_MODELS[model];
  if (!spec) throw failure('Runway model is not allowed.', 'RUNWAY_MODEL_NOT_ALLOWED', 400);
  return spec.creditsPerSecond * duration;
}

// Validates and returns an exact SDK request body plus its credit estimate.
export function buildRunwayRequest(input, env = process.env) {
  const limits = runwayLimits(env);
  const { mode, model, promptText, promptImage, ratio, duration, seed } = input || {};
  const spec = RUNWAY_MODELS[model];
  if (!spec) throw failure('Runway model is not allowed.', 'RUNWAY_MODEL_NOT_ALLOWED', 400);
  const modeSpec = spec.modes[mode];
  if (!modeSpec) throw failure('Runway mode is not allowed for this model.', 'RUNWAY_MODE_NOT_ALLOWED', 400);
  if (!modeSpec.ratios.includes(ratio)) throw failure('Runway ratio is not allowed for this model.', 'RUNWAY_RATIO_NOT_ALLOWED', 400);
  if (!Number.isSafeInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw failure('Runway duration is out of range for this model.', 'RUNWAY_DURATION_INVALID', 400);
  }
  if (duration > limits.maxDurationSeconds) throw failure('Runway duration exceeds the configured limit.', 'RUNWAY_DURATION_LIMIT', 422);
  if (promptText !== undefined || modeSpec.promptTextRequired) {
    if (typeof promptText !== 'string' || promptText.length < 1 || promptText.length > PROMPT_MAX) {
      throw failure('Runway prompt text is invalid.', 'RUNWAY_PROMPT_INVALID', 400);
    }
  }
  const body = { model, ratio, duration };
  if (promptText !== undefined) body.promptText = promptText;
  if (mode === 'image_to_video') {
    if (typeof promptImage !== 'string' || !/^(https:\/\/|data:image\/)/.test(promptImage)) {
      throw failure('Runway prompt image must be an HTTPS URL or image data URI.', 'RUNWAY_IMAGE_INVALID', 400);
    }
    body.promptImage = promptImage;
  }
  if (seed !== undefined) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) throw failure('Runway seed is invalid.', 'RUNWAY_SEED_INVALID', 400);
    body.seed = seed;
  }
  const credits = estimateRunwayCredits(body);
  if (credits > limits.maxCreditsPerTask) throw failure('Runway credit estimate exceeds the per-task limit.', 'RUNWAY_CREDIT_LIMIT', 422);
  return { mode, body, credits };
}

async function defaultClientFactory({ apiKey, timeout }) {
  const { default: RunwayML } = await import('@runwayml/sdk');
  return new RunwayML({ apiKey, timeout, maxRetries: 2 });
}

async function defaultSdkErrors() {
  const sdk = await import('@runwayml/sdk');
  return { TaskFailedError: sdk.TaskFailedError, TaskTimedOutError: sdk.TaskTimedOutError };
}

function errorName(error, Klass, name) {
  return (Klass && error instanceof Klass) || error?.constructor?.name === name || error?.name === name;
}

function allowedOutputUrl(value, suffixes) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  return suffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`)) ? url : null;
}

async function downloadOutput(url, { fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw failure('Runway output download failed.', 'RUNWAY_OUTPUT_DOWNLOAD', 502);
  }
  if (!response?.ok) throw failure('Runway output download failed.', 'RUNWAY_OUTPUT_DOWNLOAD', 502);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw failure('Runway output is too large.', 'RUNWAY_OUTPUT_TOO_LARGE', 413);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw failure('Runway output is empty.', 'RUNWAY_OUTPUT_EMPTY', 502);
  if (bytes.length > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw failure('Runway output is too large.', 'RUNWAY_OUTPUT_TOO_LARGE', 413);
  return bytes;
}

// Entry point: submit, wait (bounded), download, store privately.
// `job` = { id, accountId, reservedCredits }. `reservedCredits` must already be
// reserved by the caller's credit ledger and cover the provider estimate.
export async function generateRunwayVideo(job, input, dependencies = {}) {
  const env = dependencies.env || process.env;
  assertRunwayEnabled(env);
  if (!SAFE_ID.test(String(job?.id || '')) || !SAFE_ID.test(String(job?.accountId || ''))) {
    throw failure('Runway job identity is invalid.', 'RUNWAY_JOB_INVALID', 400);
  }
  const request = buildRunwayRequest(input, env);
  if (!Number.isSafeInteger(job.reservedCredits) || job.reservedCredits < request.credits) {
    throw failure('Reserved credits do not cover the Runway estimate.', 'RUNWAY_CREDITS_UNRESERVED', 402);
  }
  const apiKey = String(env[RUNWAY_SECRET_ENV] || '');
  if (!apiKey) throw failure('Runway provider is not configured.', 'RUNWAY_NOT_CONFIGURED', 503);

  const limits = runwayLimits(env);
  const log = dependencies.log || (() => {});
  const client = await (dependencies.clientFactory || defaultClientFactory)({ apiKey, timeout: limits.requestTimeoutMs });
  const { TaskFailedError, TaskTimedOutError } = await (dependencies.sdkErrors || defaultSdkErrors)();
  const resource = request.mode === 'text_to_video' ? client.textToVideo : client.imageToVideo;

  log({ event: 'runway.submit', jobId: job.id, model: request.body.model, duration: request.body.duration, credits: request.credits });
  let task;
  try {
    task = await resource.create(request.body).waitForTaskOutput({ timeout: limits.waitTimeoutMs, abortSignal: dependencies.abortSignal });
  } catch (error) {
    if (errorName(error, TaskTimedOutError, 'TaskTimedOutError')) {
      log({ event: 'runway.timeout', jobId: job.id });
      throw failure('Runway task did not finish in time.', 'RUNWAY_TIMEOUT', 504);
    }
    if (errorName(error, TaskFailedError, 'TaskFailedError')) {
      const failureCode = typeof error?.taskDetails?.failureCode === 'string' ? error.taskDetails.failureCode.slice(0, 64) : null;
      log({ event: 'runway.failed', jobId: job.id, failureCode });
      throw Object.assign(failure('Runway task failed.', 'RUNWAY_TASK_FAILED', 502), { providerFailureCode: failureCode });
    }
    log({ event: 'runway.error', jobId: job.id, status: Number(error?.status) || null });
    throw failure('Runway request failed.', 'RUNWAY_REQUEST_FAILED', 502);
  }

  if (task?.status !== 'SUCCEEDED' || !Array.isArray(task.output) || task.output.length < 1) {
    throw failure('Runway task returned no output.', 'RUNWAY_OUTPUT_MISSING', 502);
  }
  const url = allowedOutputUrl(task.output[0], limits.outputHostSuffixes);
  if (!url) throw failure('Runway output URL is not allowed.', 'RUNWAY_OUTPUT_URL', 502);

  const bytes = await downloadOutput(url, { fetchImpl: dependencies.fetchImpl || fetch, timeoutMs: limits.downloadTimeoutMs });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pathname = `video-os/finals/${job.accountId}/${job.id}-${sha256}.mp4`;
  const writer = dependencies.putPrivateBlob || putPrivateBlob;
  const blob = await writer(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, {
    contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: false,
  });
  if (blob?.pathname !== pathname) throw failure('Private output storage returned a mismatched pathname.', 'FINAL_STORE', 502);
  log({ event: 'runway.stored', jobId: job.id, bytes: bytes.length });
  return {
    privatePathname: pathname,
    bytes: bytes.length,
    sha256,
    providerTaskId: TASK_ID.test(String(task.id || '')) ? task.id : null,
    model: request.body.model,
    credits: request.credits,
    estimatedUsd: Number((request.credits * RUNWAY_USD_PER_CREDIT).toFixed(2)),
    adapter: 'runway-models',
  };
}
