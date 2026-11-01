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
  // Seedance 2.0 Fast via Runway (openapi.json: text_to_video / image_to_video
  // variant `seedance2_fast`; pricing.md: 720p 24 credits/s, 44 credit minimum).
  // Only the two 720p 16:9 / 9:16 ratios are allowed so the 720p rate applies.
  // `audio` is always sent as false (narration comes from HeyGen).
  seedance2_fast: Object.freeze({
    creditsPerSecond: 24,
    minimumCredits: 44,
    promptMax: 3500,
    fixedFields: Object.freeze({ audio: false }),
    modes: Object.freeze({
      text_to_video: Object.freeze({ ratios: Object.freeze(['1280:720', '720:1280']), promptTextRequired: true }),
      image_to_video: Object.freeze({ ratios: Object.freeze(['1280:720', '720:1280']), promptTextRequired: false }),
    }),
    minDuration: 4,
    maxDuration: 15,
  }),
});

const PROMPT_MAX = 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pinned API origin; RUNWAYML_BASE_URL / RUNWAYML_LOG in the env are ignored (QA L4).
export const RUNWAY_API_BASE_URL = 'https://api.dev.runwayml.com';
// Exact output hosts (QA L2). The only host shown in the docs
// (https://docs.dev.runwayml.com/assets/outputs.md) is this distribution.
export const RUNWAY_OUTPUT_HOSTS = Object.freeze(['dnznrvs05pmza.cloudfront.net']);
// Runway caps data URIs at 5 MB; only raster types are accepted (QA M3).
export const RUNWAY_MAX_DATA_URI_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
  'image/png': bytes => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': bytes => bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
});
// Fixed failure-code set (QA L5), from https://docs.dev.runwayml.com/errors/task-failures.md
const FAILURE_CODE_MAP = Object.freeze([
  [/^SAFETY\.INPUT(\.|$)/, 'SAFETY_INPUT'],
  [/^SAFETY\.OUTPUT(\.|$)/, 'SAFETY_OUTPUT'],
  [/^SAFETY(\.|$)/, 'SAFETY'],
  [/^INTERNAL\.BAD_OUTPUT(\.|$)/, 'BAD_OUTPUT'],
  [/^INPUT_PREPROCESSING\.SAFETY(\.|$)/, 'PREPROCESSING_SAFETY'],
  [/^INPUT_PREPROCESSING\.INTERNAL$/, 'PREPROCESSING_INTERNAL'],
  [/^ASSET\.INVALID$/, 'ASSET_INVALID'],
  [/^THIRD_PARTY\.UNAVAILABLE$/, 'THIRD_PARTY_UNAVAILABLE'],
  [/^INTERNAL$/, 'INTERNAL'],
]);

export function mapRunwayFailureCode(value) {
  if (value === null || value === undefined) return 'INTERNAL';
  const text = String(value);
  return FAILURE_CODE_MAP.find(([pattern]) => pattern.test(text))?.[1] || 'UNKNOWN';
}

function failure(message, code, statusCode, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, failureCategory: 'PROVIDER', provider: 'runway', ...extra });
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// Strict: only the exact string "true" enables Runway (no trimming).
export function runwayEnabled(env = process.env) {
  return env[RUNWAY_FEATURE_FLAG] === 'true';
}

export function runwayLimits(env = process.env) {
  return {
    maxDurationSeconds: boundedInteger(env.VIDEO_OS_RUNWAY_MAX_DURATION_SECONDS, 5, 2, 10),
    maxCreditsPerTask: boundedInteger(env.VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK, 60, 1, 120),
    waitTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS, 10 * 60_000, 30_000, 15 * 60_000),
    requestTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_REQUEST_TIMEOUT_MS, 60_000, 5_000, 120_000),
    downloadTimeoutMs: boundedInteger(env.VIDEO_OS_RUNWAY_DOWNLOAD_TIMEOUT_MS, 120_000, 5_000, 300_000),
    outputHosts: RUNWAY_OUTPUT_HOSTS,
  };
}

export function assertRunwayEnabled(env = process.env) {
  if (!runwayEnabled(env)) throw failure('Runway generation is not enabled.', 'RUNWAY_DISABLED', 503);
}

function modelSpec(model) {
  if (typeof model !== 'string' || !Object.hasOwn(RUNWAY_MODELS, model)) throw failure('Runway model is not allowed.', 'RUNWAY_MODEL_NOT_ALLOWED', 400);
  return RUNWAY_MODELS[model];
}

export function estimateRunwayCredits({ model, duration }) {
  const spec = modelSpec(model);
  return Math.max(spec.minimumCredits || 0, spec.creditsPerSecond * duration);
}

// Accepts only png/jpeg/webp base64 data URIs of <= 5 MB whose bytes match the
// declared type. Remote URLs (any scheme) and SVG are rejected (QA M3).
export function validateImageDataUri(value) {
  const invalid = () => failure('Runway prompt image must be a png, jpeg or webp data URI of 5 MB or less.', 'RUNWAY_IMAGE_INVALID', 400);
  if (typeof value !== 'string' || value.length > RUNWAY_MAX_DATA_URI_BYTES) throw invalid();
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid();
  const bytes = Buffer.from(match[2], 'base64');
  if (!IMAGE_TYPES[match[1]](bytes)) throw invalid();
  return value;
}

export function imageFileToDataUri(bytes) {
  const type = Object.keys(IMAGE_TYPES).find(name => IMAGE_TYPES[name](bytes));
  if (!type) throw failure('Image file must be png, jpeg or webp.', 'RUNWAY_IMAGE_INVALID', 400);
  return validateImageDataUri(`data:${type};base64,${bytes.toString('base64')}`);
}

// Validates and returns an exact SDK request body plus its credit estimate.
export function buildRunwayRequest(input, env = process.env) {
  const limits = runwayLimits(env);
  const { mode, model, promptText, promptImage, ratio, duration, seed } = input || {};
  const spec = modelSpec(model);
  if (typeof mode !== 'string' || !Object.hasOwn(spec.modes, mode)) throw failure('Runway mode is not allowed for this model.', 'RUNWAY_MODE_NOT_ALLOWED', 400);
  const modeSpec = spec.modes[mode];
  if (!modeSpec.ratios.includes(ratio)) throw failure('Runway ratio is not allowed for this model.', 'RUNWAY_RATIO_NOT_ALLOWED', 400);
  if (!Number.isSafeInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw failure('Runway duration is out of range for this model.', 'RUNWAY_DURATION_INVALID', 400);
  }
  if (duration > limits.maxDurationSeconds) throw failure('Runway duration exceeds the configured limit.', 'RUNWAY_DURATION_LIMIT', 422);
  if (promptText !== undefined || modeSpec.promptTextRequired) {
    if (typeof promptText !== 'string' || promptText.length < 1 || promptText.length > (spec.promptMax || PROMPT_MAX)) {
      throw failure('Runway prompt text is invalid.', 'RUNWAY_PROMPT_INVALID', 400);
    }
  }
  const body = { model, ratio, duration };
  if (promptText !== undefined) body.promptText = promptText;
  if (mode === 'image_to_video') body.promptImage = validateImageDataUri(promptImage);
  else if (promptImage !== undefined) throw failure('Runway prompt image is only valid for image_to_video.', 'RUNWAY_IMAGE_INVALID', 400);
  if (seed !== undefined) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) throw failure('Runway seed is invalid.', 'RUNWAY_SEED_INVALID', 400);
    body.seed = seed;
  }
  if (spec.fixedFields) Object.assign(body, spec.fixedFields);
  const credits = estimateRunwayCredits(body);
  if (credits > limits.maxCreditsPerTask) throw failure('Runway credit estimate exceeds the per-task limit.', 'RUNWAY_CREDIT_LIMIT', 422);
  return { mode, body, credits };
}

async function defaultClientFactory({ apiKey, timeout }) {
  const { default: RunwayML } = await import('@runwayml/sdk');
  // maxRetries 0: task creation is a non-idempotent paid POST (QA M1).
  return new RunwayML({ apiKey, timeout, maxRetries: 0, baseURL: RUNWAY_API_BASE_URL, logLevel: 'off' });
}

async function defaultSdkErrors() {
  const sdk = await import('@runwayml/sdk');
  return { TaskFailedError: sdk.TaskFailedError, TaskTimedOutError: sdk.TaskTimedOutError, AbortError: sdk.AbortError };
}

function errorName(error, Klass, name) {
  return (Klass && error instanceof Klass) || error?.constructor?.name === name || error?.name === name;
}

function allowedOutputUrl(value, hosts) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return hosts.includes(url.hostname.toLowerCase()) ? url : null;
}

async function downloadOutput(url, { fetchImpl, timeoutMs }) {
  const tooLarge = () => failure('Runway output is too large.', 'RUNWAY_OUTPUT_TOO_LARGE', 413);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw failure('Runway output download failed.', 'RUNWAY_OUTPUT_DOWNLOAD', 502);
  }
  if (!response?.ok || !response.body) throw failure('Runway output download failed.', 'RUNWAY_OUTPUT_DOWNLOAD', 502);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) throw tooLarge();
  // Stream with a running byte cap (QA L1).
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader ? response.body.getReader() : null;
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) { await reader.cancel().catch(() => {}); throw tooLarge(); }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } else {
      for await (const value of response.body) {
        total += value.byteLength;
        if (total > MAX_FINISHED_CUSTOMER_VIDEO_BYTES) { response.body.destroy?.(); throw tooLarge(); }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (error) {
    if (error.code === 'RUNWAY_OUTPUT_TOO_LARGE') throw error;
    throw failure('Runway output download failed.', 'RUNWAY_OUTPUT_DOWNLOAD', 502);
  }
  if (total === 0) throw failure('Runway output is empty.', 'RUNWAY_OUTPUT_EMPTY', 502);
  return Buffer.concat(chunks, total);
}

function assertJob(job) {
  if (!SAFE_ID.test(String(job?.id || '')) || !SAFE_ID.test(String(job?.accountId || ''))) {
    throw failure('Runway job identity is invalid.', 'RUNWAY_JOB_INVALID', 400);
  }
}

async function runwayClient(env, dependencies) {
  const apiKey = env[RUNWAY_SECRET_ENV];
  if (typeof apiKey !== 'string' || !apiKey) throw failure('Runway provider is not configured.', 'RUNWAY_NOT_CONFIGURED', 503);
  const limits = runwayLimits(env);
  return (dependencies.clientFactory || defaultClientFactory)({ apiKey, timeout: limits.requestTimeoutMs, maxRetries: 0, baseURL: RUNWAY_API_BASE_URL, logLevel: 'off' });
}

// Step 1 (QA M2): create exactly once (no retries) and hand the task id to
// `onTaskCreated` before any polling. Errors here carry `releaseCredits`:
// true only for a definite 4xx rejection; anything else is ambiguous.
export async function createRunwayTask(job, input, dependencies = {}) {
  const env = dependencies.env || process.env;
  assertRunwayEnabled(env);
  assertJob(job);
  const request = buildRunwayRequest(input, env);
  if (!Number.isSafeInteger(job.reservedCredits) || job.reservedCredits < request.credits) {
    throw failure('Reserved credits do not cover the Runway estimate.', 'RUNWAY_CREDITS_UNRESERVED', 402);
  }
  const client = await runwayClient(env, dependencies);
  const log = dependencies.log || (() => {});
  const resource = request.mode === 'text_to_video' ? client.textToVideo : client.imageToVideo;
  log({ event: 'runway.submit', jobId: job.id, model: request.body.model, duration: request.body.duration, credits: request.credits });
  let created;
  try {
    created = await resource.create(request.body, { maxRetries: 0 });
  } catch (error) {
    const status = Number(error?.status) || null;
    const definite = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409;
    log({ event: 'runway.create_error', jobId: job.id, status });
    throw failure('Runway task creation failed.', definite ? 'RUNWAY_CREATE_REJECTED' : 'RUNWAY_CREATE_UNKNOWN', 502, { releaseCredits: definite, unresolved: !definite, providerTaskId: null });
  }
  const taskId = String(created?.id || '');
  if (!TASK_ID.test(taskId)) throw failure('Runway returned an invalid task id.', 'RUNWAY_CREATE_UNKNOWN', 502, { releaseCredits: false, unresolved: true, providerTaskId: null });
  if (dependencies.onTaskCreated) {
    try {
      await dependencies.onTaskCreated({ taskId, model: request.body.model, credits: request.credits });
    } catch {
      // QA r2 Low 1: the task exists and is billable; never let a persistence
      // failure look like a failed create.
      log({ event: 'runway.persist_failed', jobId: job.id, taskId });
      throw failure('Runway task was created but its id could not be saved.', 'RUNWAY_TASK_ID_NOT_SAVED', 500, { providerTaskId: taskId, unresolved: true, releaseCredits: false });
    }
  }
  log({ event: 'runway.created', jobId: job.id, taskId });
  return { client, taskId, request };
}

// Step 2: poll an existing task id, download and store privately.
export async function awaitRunwayTask(job, { client, taskId, request }, dependencies = {}) {
  const env = dependencies.env || process.env;
  const limits = runwayLimits(env);
  const log = dependencies.log || (() => {});
  const { TaskFailedError, TaskTimedOutError, AbortError } = await (dependencies.sdkErrors || defaultSdkErrors)();
  const unresolved = (message, code, statusCode) => failure(message, code, statusCode, { providerTaskId: taskId, unresolved: true, releaseCredits: false });
  let task;
  try {
    task = await client.tasks.retrieve(taskId).waitForTaskOutput({ timeout: limits.waitTimeoutMs, abortSignal: dependencies.abortSignal });
  } catch (error) {
    if (errorName(error, TaskFailedError, 'TaskFailedError')) {
      const providerFailureCode = mapRunwayFailureCode(error?.taskDetails?.failureCode);
      log({ event: 'runway.failed', jobId: job.id, taskId, providerFailureCode });
      // Policy (QA r2 Low 2): Runway does not refund SAFETY.INPUT.* failures
      // (docs: errors/task-failures), so those credits are treated as spent and
      // are not released. Other failures are refunded by Runway and released.
      const spent = providerFailureCode === 'SAFETY_INPUT';
      throw failure('Runway task failed.', 'RUNWAY_TASK_FAILED', 502, { providerTaskId: taskId, providerFailureCode, unresolved: false, releaseCredits: !spent, creditsSpent: spent });
    }
    if (errorName(error, AbortError, 'AbortError') || dependencies.abortSignal?.aborted) {
      log({ event: 'runway.abort', jobId: job.id, taskId });
      try { await client.tasks.delete(taskId); } catch { log({ event: 'runway.cancel_failed', jobId: job.id, taskId }); }
      throw unresolved('Runway wait was aborted; task cancellation requested.', 'RUNWAY_ABORTED', 499);
    }
    if (errorName(error, TaskTimedOutError, 'TaskTimedOutError')) {
      log({ event: 'runway.timeout', jobId: job.id, taskId });
      throw unresolved('Runway task did not finish in time.', 'RUNWAY_TIMEOUT', 504);
    }
    log({ event: 'runway.poll_error', jobId: job.id, taskId, status: Number(error?.status) || null });
    throw unresolved('Runway task status is unknown.', 'RUNWAY_POLL_UNKNOWN', 502);
  }

  if (task?.status !== 'SUCCEEDED' || !Array.isArray(task.output) || task.output.length < 1) {
    throw unresolved('Runway task returned no output.', 'RUNWAY_OUTPUT_MISSING', 502);
  }
  const url = allowedOutputUrl(task.output[0], limits.outputHosts);
  if (!url) throw unresolved('Runway output URL is not allowed.', 'RUNWAY_OUTPUT_URL', 502);

  const bytes = await downloadOutput(url, { fetchImpl: dependencies.fetchImpl || fetch, timeoutMs: limits.downloadTimeoutMs })
    .catch(error => { throw Object.assign(error, { providerTaskId: taskId, unresolved: true, releaseCredits: false }); });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pathname = `video-os/finals/${job.accountId}/${job.id}-${sha256}.mp4`;
  const writer = dependencies.putPrivateBlob || putPrivateBlob;
  const blob = await writer(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, bytes, {
    contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: false,
  });
  if (blob?.pathname !== pathname) throw unresolved('Private output storage returned a mismatched pathname.', 'FINAL_STORE', 502);
  log({ event: 'runway.stored', jobId: job.id, taskId, bytes: bytes.length });
  return {
    privatePathname: pathname,
    bytes: bytes.length,
    sha256,
    providerTaskId: taskId,
    model: request.body.model,
    credits: request.credits,
    estimatedUsd: Number((request.credits * RUNWAY_USD_PER_CREDIT).toFixed(2)),
    adapter: 'runway-models',
  };
}

// Reconcile an already-created task (e.g. one left unresolved by an earlier
// run): never creates anything, only polls the given id, then downloads and
// stores like awaitRunwayTask.
export async function resumeRunwayTask(job, { taskId, input }, dependencies = {}) {
  const env = dependencies.env || process.env;
  assertRunwayEnabled(env);
  assertJob(job);
  if (!TASK_ID.test(String(taskId || ''))) throw failure('Invalid Runway task id.', 'RUNWAY_TASK_ID_INVALID', 400);
  const request = buildRunwayRequest(input, env);
  const client = await runwayClient(env, dependencies);
  return awaitRunwayTask(job, { client, taskId, request }, dependencies);
}

// Convenience entry point: create (id persisted via onTaskCreated), then await.
export async function generateRunwayVideo(job, input, dependencies = {}) {
  const created = await createRunwayTask(job, input, dependencies);
  return awaitRunwayTask(job, created, dependencies);
}
