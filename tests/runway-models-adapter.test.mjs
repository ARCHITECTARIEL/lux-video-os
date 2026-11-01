import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  RUNWAY_API_BASE_URL,
  RUNWAY_MODELS,
  RUNWAY_OUTPUT_HOSTS,
  buildRunwayRequest,
  createRunwayTask,
  resumeRunwayTask,
  estimateRunwayCredits,
  generateRunwayVideo,
  imageFileToDataUri,
  mapRunwayFailureCode,
  runwayEnabled,
  runwayLimits,
} from '../services/runway-models.js';

const SECRET = 'key_test_SHOULD_NEVER_APPEAR_0000';
const ENV = Object.freeze({ VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: SECRET });
const JOB = Object.freeze({ id: 'job-1', accountId: 'acct-1', reservedCredits: 60 });
const T2V = Object.freeze({ mode: 'text_to_video', model: 'gen4.5', promptText: 'A calm sunrise', ratio: '1280:720', duration: 5 });
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const VIDEO = Buffer.from('fake-mp4-bytes');
const OUTPUT_URL = 'https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=abc';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;

class TaskFailedError extends Error { constructor(d) { super('failed'); this.taskDetails = d; } }
class TaskTimedOutError extends Error { constructor(d) { super('timeout'); this.taskDetails = d; } }
class AbortError extends Error {}

function body(bytes, chunk = bytes.length) {
  let offset = 0;
  return { getReader: () => ({ read: async () => { if (offset >= bytes.length) return { done: true }; const value = bytes.subarray(offset, offset + chunk); offset += chunk; return { done: false, value: new Uint8Array(value) }; }, cancel: async () => {} }) };
}

function harness({ waitImpl, createImpl, fetchImpl } = {}) {
  const calls = { factory: [], create: [], retrieve: [], wait: [], del: [], put: [], fetch: [], logs: [], order: [] };
  const resource = name => ({
    create: async (requestBody, options) => { calls.order.push('create'); calls.create.push({ name, body: requestBody, options }); return (createImpl || (async () => ({ id: TASK_ID })))(); },
  });
  const deps = {
    env: ENV,
    clientFactory: async options => { calls.factory.push(options); return {
      textToVideo: resource('textToVideo'), imageToVideo: resource('imageToVideo'),
      tasks: {
        retrieve: id => { calls.order.push('retrieve'); calls.retrieve.push(id); return { waitForTaskOutput: async options => { calls.wait.push(options); return (waitImpl || (async () => ({ id: TASK_ID, status: 'SUCCEEDED', output: [OUTPUT_URL] })))(); } }; },
        delete: async id => { calls.del.push(id); },
      },
    }; },
    sdkErrors: async () => ({ TaskFailedError, TaskTimedOutError, AbortError }),
    fetchImpl: fetchImpl || (async (url, options) => { calls.fetch.push({ url: String(url), options }); return { ok: true, headers: new Map(), body: body(VIDEO) }; }),
    putPrivateBlob: async (classification, pathname, data, options) => { calls.put.push({ classification, pathname, data, options }); return { pathname }; },
    onTaskCreated: async info => { calls.order.push('saved'); calls.saved = info; },
    log: entry => calls.logs.push(entry),
  };
  return { calls, deps };
}

test('flag is off by default and only the exact string "true" enables it (no trimming)', () => {
  assert.equal(runwayEnabled({}), false);
  for (const value of ['1', 'TRUE', 'yes', ' true', 'true ', ' true ', '', true]) assert.equal(runwayEnabled({ VIDEO_OS_RUNWAY_ENABLED: value }), false);
  assert.equal(runwayEnabled({ VIDEO_OS_RUNWAY_ENABLED: 'true' }), true);
});

test('flag off: 503 and the client is never constructed', async () => {
  for (const env of [{}, { RUNWAYML_API_SECRET: SECRET }, { VIDEO_OS_RUNWAY_ENABLED: ' true ', RUNWAYML_API_SECRET: SECRET }]) {
    const { calls, deps } = harness();
    await assert.rejects(generateRunwayVideo(JOB, T2V, { ...deps, env }), error => error.statusCode === 503 && error.code === 'RUNWAY_DISABLED');
    assert.equal(calls.factory.length + calls.create.length + calls.put.length, 0);
  }
});

test('flag on but secret missing: 503 without constructing the client', async () => {
  const { calls, deps } = harness();
  await assert.rejects(generateRunwayVideo(JOB, T2V, { ...deps, env: { VIDEO_OS_RUNWAY_ENABLED: 'true' } }), error => error.statusCode === 503 && error.code === 'RUNWAY_NOT_CONFIGURED');
  assert.equal(calls.factory.length, 0);
});

test('M1/L4: client and create use maxRetries 0, pinned baseURL and logLevel off; RUNWAYML_BASE_URL ignored', async () => {
  const { calls, deps } = harness();
  await generateRunwayVideo(JOB, T2V, { ...deps, env: { ...ENV, RUNWAYML_BASE_URL: 'http://127.0.0.1:9', RUNWAYML_LOG: 'debug' } });
  assert.equal(calls.factory[0].maxRetries, 0);
  assert.equal(calls.factory[0].baseURL, RUNWAY_API_BASE_URL);
  assert.equal(calls.factory[0].logLevel, 'off');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].options.maxRetries, 0);
});

test('M1: a create 5xx is never retried and is ambiguous (no release)', async () => {
  const { calls, deps } = harness({ createImpl: async () => { throw Object.assign(new Error(`500 ${SECRET}`), { status: 500 }); } });
  const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
  assert.equal(error.code, 'RUNWAY_CREATE_UNKNOWN');
  assert.equal(error.releaseCredits, false);
  assert.equal(error.unresolved, true);
  assert.equal(calls.create.length, 1);
  const rejected = harness({ createImpl: async () => { throw Object.assign(new Error('400'), { status: 400 }); } });
  const definite = await generateRunwayVideo(JOB, T2V, rejected.deps).catch(e => e);
  assert.equal(definite.code, 'RUNWAY_CREATE_REJECTED');
  assert.equal(definite.releaseCredits, true);
});

test('M2: task id is saved before polling starts', async () => {
  const { calls, deps } = harness();
  const result = await generateRunwayVideo(JOB, T2V, deps);
  assert.deepEqual(calls.order, ['create', 'saved', 'retrieve']);
  assert.equal(calls.saved.taskId, TASK_ID);
  assert.equal(calls.retrieve[0], TASK_ID);
  assert.equal(result.providerTaskId, TASK_ID);
});

test('resumeRunwayTask polls an existing id and never creates', async () => {
  const { calls, deps } = harness();
  const result = await resumeRunwayTask(JOB, { taskId: TASK_ID, input: T2V }, deps);
  assert.equal(calls.create.length, 0);
  assert.deepEqual(calls.retrieve, [TASK_ID]);
  assert.equal(result.providerTaskId, TASK_ID);
  await assert.rejects(resumeRunwayTask(JOB, { taskId: 'nope', input: T2V }, deps), { code: 'RUNWAY_TASK_ID_INVALID' });
  await assert.rejects(resumeRunwayTask(JOB, { taskId: TASK_ID, input: T2V }, { ...deps, env: { ...ENV, VIDEO_OS_RUNWAY_ENABLED: 'false' } }), { statusCode: 503 });
});

test('M2: createRunwayTask returns the id without polling', async () => {
  const { calls, deps } = harness();
  const created = await createRunwayTask(JOB, T2V, deps);
  assert.equal(created.taskId, TASK_ID);
  assert.equal(calls.retrieve.length, 0);
});

test('success: download is streamed and stored in the private immutable path', async () => {
  const { calls, deps } = harness();
  const result = await generateRunwayVideo(JOB, T2V, deps);
  assert.deepEqual(calls.create[0].body, { model: 'gen4.5', ratio: '1280:720', duration: 5, promptText: 'A calm sunrise' });
  assert.equal(calls.wait[0].timeout, 600000);
  assert.equal(calls.fetch[0].options.redirect, 'error');
  const sha = createHash('sha256').update(VIDEO).digest('hex');
  assert.equal(calls.put[0].classification, 'finished-customer-video');
  assert.equal(calls.put[0].pathname, `video-os/finals/acct-1/job-1-${sha}.mp4`);
  assert.equal(calls.put[0].options.allowOverwrite, false);
  assert.equal(result.credits, 60);
  assert.equal(result.estimatedUsd, 0.6);
  assert.ok(!JSON.stringify(result).includes('cloudfront'));
});

test('stored pathname mismatch is rejected (kills F21)', async () => {
  const { deps } = harness();
  await assert.rejects(generateRunwayVideo(JOB, T2V, { ...deps, putPrivateBlob: async () => ({ pathname: 'video-os/finals/other.mp4' }) }), { code: 'FINAL_STORE' });
});

test('r2 Low 1: a failure saving the task id is unresolved with the id and does not poll', async () => {
  const { calls, deps } = harness();
  const error = await generateRunwayVideo(JOB, T2V, { ...deps, onTaskCreated: async () => { throw new Error('ENOSPC'); } }).catch(e => e);
  assert.equal(error.code, 'RUNWAY_TASK_ID_NOT_SAVED');
  assert.equal(error.unresolved, true);
  assert.equal(error.releaseCredits, false);
  assert.equal(error.providerTaskId, TASK_ID);
  assert.equal(calls.retrieve.length, 0);
});

test('r2 Low 2: non-safety-input failures release credits; SAFETY.INPUT does not', async () => {
  for (const [code, release] of [['INTERNAL.BAD_OUTPUT.CODE01', true], ['SAFETY.OUTPUT.VIDEO', true], ['ASSET.INVALID', true], ['SAFETY.INPUT.IMAGE', false]]) {
    const { deps } = harness({ waitImpl: async () => { throw new TaskFailedError({ status: 'FAILED', failureCode: code }); } });
    const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
    assert.equal(error.releaseCredits, release, code);
    assert.equal(error.creditsSpent, !release, code);
  }
});

test('task failure maps to 502, does not release SAFETY.INPUT, and the failure code is from a fixed set (L5)', async () => {
  const { calls, deps } = harness({ waitImpl: async () => { throw new TaskFailedError({ status: 'FAILED', failure: `bad ${SECRET}`, failureCode: 'SAFETY.INPUT.TEXT' }); } });
  const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
  assert.equal(error.code, 'RUNWAY_TASK_FAILED');
  assert.equal(error.providerFailureCode, 'SAFETY_INPUT');
  assert.equal(error.releaseCredits, false);
  assert.equal(error.providerTaskId, TASK_ID);
  assert.equal(calls.put.length, 0);
  assert.equal(mapRunwayFailureCode('INTERNAL.BAD_OUTPUT.01'), 'BAD_OUTPUT');
  assert.equal(mapRunwayFailureCode('ASSET.INVALID'), 'ASSET_INVALID');
  assert.equal(mapRunwayFailureCode('THIRD_PARTY.UNAVAILABLE'), 'THIRD_PARTY_UNAVAILABLE');
  assert.equal(mapRunwayFailureCode(null), 'INTERNAL');
  assert.equal(mapRunwayFailureCode(`<script>${SECRET}`), 'UNKNOWN');
});

test('M2: timeout is unresolved with the task id and no release', async () => {
  const { calls, deps } = harness({ waitImpl: async () => { throw new TaskTimedOutError({ status: 'RUNNING' }); } });
  const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
  assert.equal(error.code, 'RUNWAY_TIMEOUT');
  assert.equal(error.statusCode, 504);
  assert.equal(error.providerTaskId, TASK_ID);
  assert.equal(error.unresolved, true);
  assert.equal(error.releaseCredits, false);
  assert.equal(calls.del.length, 0);
  assert.equal(calls.put.length, 0);
});

test('M2: abort cancels the task and is unresolved', async () => {
  const controller = new AbortController();
  const { calls, deps } = harness({ waitImpl: async () => { controller.abort(); throw new AbortError('aborted'); } });
  const error = await generateRunwayVideo(JOB, T2V, { ...deps, abortSignal: controller.signal }).catch(e => e);
  assert.equal(error.code, 'RUNWAY_ABORTED');
  assert.equal(error.providerTaskId, TASK_ID);
  assert.equal(error.releaseCredits, false);
  assert.deepEqual(calls.del, [TASK_ID]);
});

test('M2: a polling network error is unresolved, not a failure', async () => {
  const { deps } = harness({ waitImpl: async () => { throw Object.assign(new Error('ECONNRESET'), { status: undefined }); } });
  const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
  assert.equal(error.code, 'RUNWAY_POLL_UNKNOWN');
  assert.equal(error.unresolved, true);
  assert.equal(error.releaseCredits, false);
});

test('wait timeout is bounded by env clamps', () => {
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS: '999999999' }).waitTimeoutMs, 900000);
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS: '1' }).waitTimeoutMs, 30000);
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: '100000' }).maxCreditsPerTask, 120);
});

test('no secret leakage in errors or logs', async () => {
  const leaky = new Error(`401 Unauthorized Bearer ${SECRET}`);
  for (const impl of [{ waitImpl: async () => { throw leaky; } }, { createImpl: async () => { throw leaky; } }, { waitImpl: async () => { throw new TaskFailedError({ failure: SECRET, failureCode: SECRET }); } }]) {
    const { calls, deps } = harness(impl);
    const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
    const serialized = JSON.stringify({ message: error.message, stack: error.stack, ...error }) + JSON.stringify(calls.logs);
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!serialized.includes('Bearer'));
  }
});

test('L3: prototype keys for model/mode give a coded 400', () => {
  for (const model of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => buildRunwayRequest({ ...T2V, model }, ENV), error => error.code === 'RUNWAY_MODEL_NOT_ALLOWED' && error.statusCode === 400);
  }
  for (const mode of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => buildRunwayRequest({ ...T2V, mode }, ENV), error => error.code === 'RUNWAY_MODE_NOT_ALLOWED' && error.statusCode === 400);
  }
});

test('guardrails: model/ratio/duration/prompt allowlists from docs', () => {
  assert.throws(() => buildRunwayRequest({ ...T2V, model: 'veo3.1' }, ENV), { code: 'RUNWAY_MODEL_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, model: 'gen4_turbo' }, ENV), { code: 'RUNWAY_MODE_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, ratio: '960:960' }, ENV), { code: 'RUNWAY_RATIO_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 1 }, ENV), { code: 'RUNWAY_DURATION_INVALID' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 5.5 }, ENV), { code: 'RUNWAY_DURATION_INVALID' });
  assert.throws(() => buildRunwayRequest({ ...T2V, promptText: 'x'.repeat(1001) }, ENV), { code: 'RUNWAY_PROMPT_INVALID' });
  assert.equal(estimateRunwayCredits({ model: 'gen4.5', duration: 10 }), 120);
  assert.equal(estimateRunwayCredits({ model: 'gen4_turbo', duration: 10 }), 50);
  assert.deepEqual(Object.keys(RUNWAY_MODELS).sort(), ['gen4.5', 'gen4_turbo', 'seedance2_fast']);
  assert.equal(estimateRunwayCredits({ model: 'seedance2_fast', duration: 4 }), 96);
  assert.equal(estimateRunwayCredits({ model: 'seedance2_fast', duration: 1 }), 44);
  const seed = buildRunwayRequest({ mode: 'text_to_video', model: 'seedance2_fast', promptText: 'x', ratio: '1280:720', duration: 4 }, { ...ENV, VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: '100' });
  assert.deepEqual(seed.body, { model: 'seedance2_fast', ratio: '1280:720', duration: 4, promptText: 'x', audio: false });
  assert.throws(() => buildRunwayRequest({ mode: 'text_to_video', model: 'seedance2_fast', promptText: 'x', ratio: '1920:1080', duration: 4 }, ENV), { code: 'RUNWAY_RATIO_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ mode: 'text_to_video', model: 'seedance2_fast', promptText: 'x', ratio: '1280:720', duration: 3 }, ENV), { code: 'RUNWAY_DURATION_INVALID' });
});

test('M3: image inputs accept only png/jpeg/webp data URIs <= 5 MB', () => {
  const i2v = promptImage => buildRunwayRequest({ mode: 'image_to_video', model: 'gen4_turbo', promptImage, ratio: '960:960', duration: 5 }, ENV);
  assert.equal(i2v(PNG_URI).body.promptImage, PNG_URI);
  for (const bad of [
    'https://example.com/a.jpg', 'https://169.254.169.254/x', 'https://localhost/a.png', 'https://user:pw@x/a.png',
    'https://acct.private.blob.vercel-storage.com/a.png?token=x', 'https://', 'http://x/a.png', 'file:///etc/passwd',
    'data:image/svg+xml,<svg/>', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}`,
    `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64')}`,
    undefined, 42,
  ]) {
    assert.throws(() => i2v(bad), { code: 'RUNWAY_IMAGE_INVALID' }, String(bad).slice(0, 60));
  }
  assert.throws(() => buildRunwayRequest({ ...T2V, promptImage: PNG_URI }, ENV), { code: 'RUNWAY_IMAGE_INVALID' });
  assert.equal(imageFileToDataUri(PNG), PNG_URI);
  assert.throws(() => imageFileToDataUri(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { code: 'RUNWAY_IMAGE_INVALID' });
});

test('image_to_video routes to imageToVideo with the data URI', async () => {
  const { calls, deps } = harness();
  await generateRunwayVideo({ ...JOB, reservedCredits: 25 }, { mode: 'image_to_video', model: 'gen4_turbo', promptImage: PNG_URI, ratio: '960:960', duration: 5 }, deps);
  assert.equal(calls.create[0].name, 'imageToVideo');
  assert.equal(calls.create[0].body.promptImage, PNG_URI);
});

test('guardrails: duration cap, credit cap and reservation block before any client call', async () => {
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 6 }, ENV), { code: 'RUNWAY_DURATION_LIMIT' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 10 }, { ...ENV, VIDEO_OS_RUNWAY_MAX_DURATION_SECONDS: '10', VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: '100' }), { code: 'RUNWAY_CREDIT_LIMIT' });
  const { calls, deps } = harness();
  await assert.rejects(generateRunwayVideo({ ...JOB, reservedCredits: 59 }, T2V, deps), { code: 'RUNWAY_CREDITS_UNRESERVED', statusCode: 402 });
  await assert.rejects(generateRunwayVideo({ ...JOB, id: '../x' }, T2V, deps), { code: 'RUNWAY_JOB_INVALID' });
  assert.equal(calls.factory.length, 0);
});

test('L2: output host list is pinned exactly', async () => {
  assert.deepEqual(RUNWAY_OUTPUT_HOSTS, ['dnznrvs05pmza.cloudfront.net']);
  for (const url of ['https://attacker-dist.cloudfront.net/o.mp4', 'http://dnznrvs05pmza.cloudfront.net/o.mp4', 'https://evil.example.com/o.mp4',
    'https://user:pw@dnznrvs05pmza.cloudfront.net/o.mp4', 'https://dnznrvs05pmza.cloudfront.net.evil.com/o.mp4', 'https://dnznrvs05pmza.cloudfront.net:8443/o.mp4']) {
    const { calls, deps } = harness({ waitImpl: async () => ({ status: 'SUCCEEDED', output: [url] }) });
    const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
    assert.equal(error.code, 'RUNWAY_OUTPUT_URL', url);
    assert.equal(error.providerTaskId, TASK_ID);
    assert.equal(calls.fetch.length + calls.put.length, 0);
  }
  assert.deepEqual(runwayLimits({ VIDEO_OS_RUNWAY_OUTPUT_HOST_SUFFIXES: 'cloudfront.net' }).outputHosts, RUNWAY_OUTPUT_HOSTS);
});

test('L1: streamed download stops at the running byte cap without buffering it all', async () => {
  let pulled = 0;
  const chunk = new Uint8Array(8 * 1024 * 1024);
  const endless = { getReader: () => ({ read: async () => { pulled += chunk.byteLength; return { done: false, value: chunk }; }, cancel: async () => {} }) };
  const { calls, deps } = harness({ fetchImpl: async () => ({ ok: true, headers: new Map(), body: endless }) });
  await assert.rejects(generateRunwayVideo(JOB, T2V, deps), { code: 'RUNWAY_OUTPUT_TOO_LARGE' });
  assert.ok(pulled <= 100 * 1024 * 1024 + chunk.byteLength, `pulled ${pulled}`);
  assert.equal(calls.put.length, 0);
  const declared = harness({ fetchImpl: async () => ({ ok: true, headers: new Map([['content-length', String(200 * 1024 * 1024)]]), body: body(VIDEO) }) });
  await assert.rejects(generateRunwayVideo(JOB, T2V, declared.deps), { code: 'RUNWAY_OUTPUT_TOO_LARGE' });
  const bad = harness({ fetchImpl: async () => ({ ok: false, headers: new Map() }) });
  await assert.rejects(generateRunwayVideo(JOB, T2V, bad.deps), { code: 'RUNWAY_OUTPUT_DOWNLOAD' });
});

test('non-SUCCEEDED or empty output is never stored', async () => {
  for (const task of [{ status: 'RUNNING', output: [OUTPUT_URL] }, { status: 'SUCCEEDED', output: [] }, { status: 'SUCCEEDED' }]) {
    const { calls, deps } = harness({ waitImpl: async () => task });
    await assert.rejects(generateRunwayVideo(JOB, T2V, deps), { code: 'RUNWAY_OUTPUT_MISSING' });
    assert.equal(calls.put.length, 0);
  }
});

test('module does not statically import the SDK and has no hard-coded keys', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../services/runway-models.js', import.meta.url), 'utf8');
  assert.ok(!/^import .*@runwayml\/sdk/m.test(source));
  assert.ok(!/key_[A-Za-z0-9]{8,}/.test(source));
  assert.match(source, /maxRetries: 0, baseURL: RUNWAY_API_BASE_URL, logLevel: 'off'/);
});

test('installed SDK exposes the surface the adapter relies on (offline, no request)', async () => {
  const sdk = await import('@runwayml/sdk');
  for (const name of ['TaskFailedError', 'TaskTimedOutError', 'AbortError']) assert.equal(typeof sdk[name], 'function');
  const client = new sdk.default({ apiKey: 'offline-dummy', maxRetries: 0, baseURL: RUNWAY_API_BASE_URL, logLevel: 'off' });
  assert.equal(client.baseURL, RUNWAY_API_BASE_URL);
  assert.equal(client.maxRetries, 0);
  for (const fn of [client.textToVideo.create, client.imageToVideo.create, client.tasks.retrieve, client.tasks.delete]) assert.equal(typeof fn, 'function');
});
