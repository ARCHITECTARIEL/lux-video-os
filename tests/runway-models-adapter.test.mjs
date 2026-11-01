import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  RUNWAY_MODELS,
  buildRunwayRequest,
  estimateRunwayCredits,
  generateRunwayVideo,
  runwayEnabled,
  runwayLimits,
} from '../services/runway-models.js';

const SECRET = 'key_test_SHOULD_NEVER_APPEAR_0000';
const ENV = Object.freeze({ VIDEO_OS_RUNWAY_ENABLED: 'true', RUNWAYML_API_SECRET: SECRET });
const JOB = Object.freeze({ id: 'job-1', accountId: 'acct-1', reservedCredits: 60 });
const T2V = Object.freeze({ mode: 'text_to_video', model: 'gen4.5', promptText: 'A calm sunrise', ratio: '1280:720', duration: 5 });
const VIDEO = Buffer.from('fake-mp4-bytes');
const OUTPUT_URL = 'https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=abc';

class TaskFailedError extends Error { constructor(d) { super('failed'); this.taskDetails = d; } }
class TaskTimedOutError extends Error { constructor(d) { super('timeout'); this.taskDetails = d; } }

function harness({ waitImpl, fetchImpl } = {}) {
  const calls = { factory: [], create: [], wait: [], put: [], fetch: [], logs: [] };
  const resource = name => ({
    create(body) {
      calls.create.push({ name, body });
      return { waitForTaskOutput: async options => { calls.wait.push(options); return (waitImpl || (async () => ({ id: '11111111-2222-3333-4444-555555555555', status: 'SUCCEEDED', output: [OUTPUT_URL] })))(); } };
    },
  });
  const deps = {
    env: ENV,
    clientFactory: async options => { calls.factory.push(options); return { textToVideo: resource('textToVideo'), imageToVideo: resource('imageToVideo') }; },
    sdkErrors: async () => ({ TaskFailedError, TaskTimedOutError }),
    fetchImpl: fetchImpl || (async (url, options) => { calls.fetch.push({ url: String(url), options }); return { ok: true, headers: new Map(), arrayBuffer: async () => VIDEO }; }),
    putPrivateBlob: async (classification, pathname, body, options) => { calls.put.push({ classification, pathname, body, options }); return { pathname }; },
    log: entry => calls.logs.push(entry),
  };
  return { calls, deps };
}

test('flag is off by default and only exact "true" enables it', () => {
  assert.equal(runwayEnabled({}), false);
  for (const value of ['1', 'TRUE', 'yes', ' false', '']) assert.equal(runwayEnabled({ VIDEO_OS_RUNWAY_ENABLED: value }), false);
  assert.equal(runwayEnabled({ VIDEO_OS_RUNWAY_ENABLED: 'true' }), true);
});

test('flag off: 503 and the client is never constructed', async () => {
  for (const env of [{}, { RUNWAYML_API_SECRET: SECRET }, { VIDEO_OS_RUNWAY_ENABLED: 'false', RUNWAYML_API_SECRET: SECRET }]) {
    const { calls, deps } = harness();
    await assert.rejects(generateRunwayVideo(JOB, T2V, { ...deps, env }), error => error.statusCode === 503 && error.code === 'RUNWAY_DISABLED');
    assert.equal(calls.factory.length, 0);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.put.length, 0);
  }
});

test('flag on but secret missing: 503 without constructing the client', async () => {
  const { calls, deps } = harness();
  await assert.rejects(generateRunwayVideo(JOB, T2V, { ...deps, env: { VIDEO_OS_RUNWAY_ENABLED: 'true' } }), error => error.statusCode === 503 && error.code === 'RUNWAY_NOT_CONFIGURED');
  assert.equal(calls.factory.length, 0);
});

test('success: submit-and-wait with timeout, download, private immutable store', async () => {
  const { calls, deps } = harness();
  const result = await generateRunwayVideo(JOB, T2V, deps);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].name, 'textToVideo');
  assert.deepEqual(calls.create[0].body, { model: 'gen4.5', ratio: '1280:720', duration: 5, promptText: 'A calm sunrise' });
  assert.equal(calls.wait[0].timeout, 600000);
  assert.equal(calls.factory[0].apiKey, SECRET);
  assert.equal(calls.fetch[0].options.redirect, 'error');
  const sha = createHash('sha256').update(VIDEO).digest('hex');
  assert.equal(calls.put[0].classification, 'finished-customer-video');
  assert.equal(calls.put[0].pathname, `video-os/finals/acct-1/job-1-${sha}.mp4`);
  assert.equal(calls.put[0].options.allowOverwrite, false);
  assert.equal(result.privatePathname, calls.put[0].pathname);
  assert.equal(result.credits, 60);
  assert.equal(result.estimatedUsd, 0.6);
  assert.ok(!JSON.stringify(result).includes('cloudfront'), 'ephemeral provider URL must not be returned');
});

test('image_to_video routes to imageToVideo with promptImage', async () => {
  const { calls, deps } = harness();
  await generateRunwayVideo({ ...JOB, reservedCredits: 25 }, { mode: 'image_to_video', model: 'gen4_turbo', promptImage: 'https://example.com/a.jpg', ratio: '960:960', duration: 5 }, deps);
  assert.equal(calls.create[0].name, 'imageToVideo');
  assert.deepEqual(calls.create[0].body, { model: 'gen4_turbo', ratio: '960:960', duration: 5, promptImage: 'https://example.com/a.jpg' });
});

test('task failure maps to 502 and nothing is stored', async () => {
  const { calls, deps } = harness({ waitImpl: async () => { throw new TaskFailedError({ status: 'FAILED', failure: `bad ${SECRET}`, failureCode: 'SAFETY.INPUT' }); } });
  await assert.rejects(generateRunwayVideo(JOB, T2V, deps), error => error.code === 'RUNWAY_TASK_FAILED' && error.statusCode === 502 && error.providerFailureCode === 'SAFETY.INPUT');
  assert.equal(calls.put.length, 0);
});

test('timeout maps to 504 and nothing is stored', async () => {
  const { calls, deps } = harness({ waitImpl: async () => { throw new TaskTimedOutError({ status: 'RUNNING' }); } });
  await assert.rejects(generateRunwayVideo(JOB, T2V, deps), error => error.code === 'RUNWAY_TIMEOUT' && error.statusCode === 504);
  assert.equal(calls.put.length, 0);
});

test('wait timeout is bounded by env clamps', () => {
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS: '999999999' }).waitTimeoutMs, 900000);
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_WAIT_TIMEOUT_MS: '1' }).waitTimeoutMs, 30000);
  assert.equal(runwayLimits({ VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: '100000' }).maxCreditsPerTask, 120);
});

test('no secret leakage in errors or logs', async () => {
  const leaky = new Error(`401 Unauthorized Bearer ${SECRET}`);
  for (const waitImpl of [async () => { throw leaky; }, async () => { throw new TaskFailedError({ failure: SECRET, failureCode: 'X' }); }]) {
    const { calls, deps } = harness({ waitImpl });
    const error = await generateRunwayVideo(JOB, T2V, deps).catch(e => e);
    const serialized = JSON.stringify({ message: error.message, stack: error.stack, ...error }) + JSON.stringify(calls.logs);
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!serialized.includes('Bearer'));
  }
  const { calls, deps } = harness();
  const result = await generateRunwayVideo(JOB, T2V, deps);
  assert.ok(!JSON.stringify(calls.logs).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('guardrails: model/ratio/duration/prompt allowlists from docs', () => {
  assert.throws(() => buildRunwayRequest({ ...T2V, model: 'veo3.1' }, ENV), { code: 'RUNWAY_MODEL_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, model: 'gen4_turbo' }, ENV), { code: 'RUNWAY_MODE_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, ratio: '960:960' }, ENV), { code: 'RUNWAY_RATIO_NOT_ALLOWED' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 1 }, ENV), { code: 'RUNWAY_DURATION_INVALID' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 5.5 }, ENV), { code: 'RUNWAY_DURATION_INVALID' });
  assert.throws(() => buildRunwayRequest({ ...T2V, promptText: 'x'.repeat(1001) }, ENV), { code: 'RUNWAY_PROMPT_INVALID' });
  assert.throws(() => buildRunwayRequest({ mode: 'image_to_video', model: 'gen4.5', promptText: 'x', ratio: '1280:720', duration: 5, promptImage: 'http://x/a.jpg' }, ENV), { code: 'RUNWAY_IMAGE_INVALID' });
  assert.equal(estimateRunwayCredits({ model: 'gen4.5', duration: 10 }), 120);
  assert.equal(estimateRunwayCredits({ model: 'gen4_turbo', duration: 10 }), 50);
  assert.deepEqual(Object.keys(RUNWAY_MODELS).sort(), ['gen4.5', 'gen4_turbo']);
});

test('guardrails: duration cap, credit cap and reservation block before any client call', async () => {
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 6 }, ENV), { code: 'RUNWAY_DURATION_LIMIT' });
  assert.throws(() => buildRunwayRequest({ ...T2V, duration: 10 }, { ...ENV, VIDEO_OS_RUNWAY_MAX_DURATION_SECONDS: '10', VIDEO_OS_RUNWAY_MAX_CREDITS_PER_TASK: '100' }), { code: 'RUNWAY_CREDIT_LIMIT' });
  const { calls, deps } = harness();
  await assert.rejects(generateRunwayVideo({ ...JOB, reservedCredits: 59 }, T2V, deps), { code: 'RUNWAY_CREDITS_UNRESERVED', statusCode: 402 });
  await assert.rejects(generateRunwayVideo({ ...JOB, id: '../x' }, T2V, deps), { code: 'RUNWAY_JOB_INVALID' });
  assert.equal(calls.factory.length, 0);
});

test('output URL allowlist and download failures never store', async () => {
  for (const url of ['http://dnznrvs05pmza.cloudfront.net/o.mp4', 'https://evil.example.com/o.mp4', 'https://user:pw@x.cloudfront.net/o.mp4']) {
    const { calls, deps } = harness({ waitImpl: async () => ({ status: 'SUCCEEDED', output: [url] }) });
    await assert.rejects(generateRunwayVideo(JOB, T2V, deps), { code: 'RUNWAY_OUTPUT_URL' });
    assert.equal(calls.fetch.length + calls.put.length, 0);
  }
  const bad = harness({ fetchImpl: async () => ({ ok: false, headers: new Map() }) });
  await assert.rejects(generateRunwayVideo(JOB, T2V, bad.deps), { code: 'RUNWAY_OUTPUT_DOWNLOAD' });
  const big = harness({ fetchImpl: async () => ({ ok: true, headers: new Map([['content-length', String(200 * 1024 * 1024)]]), arrayBuffer: async () => VIDEO }) });
  await assert.rejects(generateRunwayVideo(JOB, T2V, big.deps), { code: 'RUNWAY_OUTPUT_TOO_LARGE' });
  assert.equal(bad.calls.put.length + big.calls.put.length, 0);
});

test('module does not statically import the SDK', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../services/runway-models.js', import.meta.url), 'utf8');
  assert.ok(!/^import .*@runwayml\/sdk/m.test(source));
  assert.ok(!/key_[A-Za-z0-9]{8,}/.test(source), 'no hard-coded keys');
});

test('installed SDK exposes the surface the adapter relies on (offline, no request)', async () => {
  const sdk = await import('@runwayml/sdk');
  assert.equal(typeof sdk.TaskFailedError, 'function');
  assert.equal(typeof sdk.TaskTimedOutError, 'function');
  const client = new sdk.default({ apiKey: 'offline-dummy', maxRetries: 0 });
  assert.equal(typeof client.textToVideo.create, 'function');
  assert.equal(typeof client.imageToVideo.create, 'function');
});
