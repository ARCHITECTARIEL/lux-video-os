import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  persistRunpodStandardOutput,
  pollRunpodStandard,
  standardProviderMode,
  submitRunpodStandard,
} from '../services/sadtalker-runpod.js';

const portrait = Buffer.from('portrait-bytes');
const audio = Buffer.from('audio-bytes');

function blob(bytes) {
  return { stream: new Blob([bytes]).stream() };
}

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const env = {
  RUNPOD_API_KEY: 'test-runpod-key',
  VIDEO_OS_RUNPOD_ENDPOINT_ID: 'endpoint-test',
  VIDEO_OS_STANDARD_PROVIDER: 'runpod',
};

const resolved = {
  input: {
    jobId: 'job-runpod-test',
    correlationId: 'corr-runpod-test',
    portrait: { mimeType: 'image/png', bytes: portrait.length },
    drivenAudio: { mimeType: 'audio/wav', bytes: audio.length, durationMs: 1200 },
  },
  assets: {
    portrait: { privatePathname: 'video-os/uploads/account/portrait.png', sha256: crypto.createHash('sha256').update(portrait).digest('hex') },
    drivenAudio: { privatePathname: 'video-os/uploads/account/audio.wav', sha256: crypto.createHash('sha256').update(audio).digest('hex') },
  },
};

test('standardProviderMode remains simulation unless RunPod is explicitly selected', () => {
  assert.equal(standardProviderMode({}), 'simulation');
  assert.equal(standardProviderMode({ VIDEO_OS_STANDARD_PROVIDER: 'simulation' }), 'simulation');
  assert.equal(standardProviderMode(env), 'runpod');
  assert.throws(() => standardProviderMode({ VIDEO_OS_STANDARD_PROVIDER: 'unknown' }), { failureCategory: 'CONFIG_MISSING' });
});

test('submitRunpodStandard reads private sources and sends one bound asynchronous job', async () => {
  let observed;
  const result = await submitRunpodStandard(resolved, { format: 'vertical', title: 'RunPod proof' }, {
    env,
    getPrivateBlob: async (pathname) => pathname.endsWith('portrait.png') ? blob(portrait) : blob(audio),
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return response(200, { id: 'rp-job-1', status: 'IN_QUEUE' });
    },
  });

  assert.equal(result.providerJobId, 'rp-job-1');
  assert.equal(observed.url, 'https://api.runpod.ai/v2/endpoint-test/run');
  assert.equal(observed.options.headers.Authorization, 'Bearer test-runpod-key');
  assert.equal(observed.body.input.jobId, 'job-runpod-test');
  assert.equal(observed.body.input.portrait.base64, portrait.toString('base64'));
  assert.equal(observed.body.input.drivenAudio.base64, audio.toString('base64'));
  assert.equal(observed.body.input.portrait.sha256, resolved.assets.portrait.sha256);
});

test('submitRunpodStandard refuses an oversized combined request before provider submission', async () => {
  await assert.rejects(
    submitRunpodStandard(resolved, { format: 'vertical', title: 'RunPod proof' }, {
      env: { ...env, VIDEO_OS_RUNPOD_MAX_INPUT_BYTES: '4' },
      getPrivateBlob: async (pathname) => pathname.endsWith('portrait.png') ? blob(portrait) : blob(audio),
      fetchImpl: async () => { throw new Error('must not submit'); },
    }),
    { failureCategory: 'SOURCE_TOO_LARGE' },
  );
});

test('pollRunpodStandard maps queued and completed jobs and validates output identity', async () => {
  const queued = await pollRunpodStandard('rp-job-1', {
    env,
    fetchImpl: async () => response(200, { id: 'rp-job-1', status: 'IN_PROGRESS' }),
  });
  assert.deepEqual(queued, { ready: false, status: 'IN_PROGRESS' });

  const video = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const sha256 = crypto.createHash('sha256').update(video).digest('hex');
  const completed = await pollRunpodStandard('rp-job-1', {
    env: { ...env, VIDEO_OS_RUNPOD_ALLOW_SIMULATED_OUTPUT: 'true' },
    fetchImpl: async () => response(200, {
      id: 'rp-job-1',
      status: 'COMPLETED',
      output: { videoBase64: video.toString('base64'), bytes: video.length, sha256, mimeType: 'video/mp4', simulation: true, width: 512, height: 512 },
    }),
  });
  assert.equal(completed.ready, true);
  assert.equal(completed.output.sha256, sha256);

  await assert.rejects(
    pollRunpodStandard('rp-job-1', {
      env,
      fetchImpl: async () => response(200, {
        id: 'rp-job-1', status: 'COMPLETED',
        output: { videoBase64: video.toString('base64'), bytes: video.length, sha256, mimeType: 'video/mp4', simulation: true },
      }),
    }),
    { failureCategory: 'PROVIDER_REJECTED' },
  );
});

test('persistRunpodStandardOutput writes the verified MP4 to the private final namespace', async () => {
  const video = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const sha256 = crypto.createHash('sha256').update(video).digest('hex');
  let observed;
  const artifact = await persistRunpodStandardOutput({ id: 'job-1', accountId: 'account-1', title: 'Proof Video', format: 'vertical' }, {
    videoBase64: video.toString('base64'), bytes: video.length, sha256, mimeType: 'video/mp4', simulation: false, width: 512, height: 512,
  }, {
    env,
    putPrivateBlob: async (classification, pathname, body, options) => {
      observed = { classification, pathname, body, options };
      return { pathname };
    },
  });
  assert.match(observed.pathname, /^video-os\/finals\/account-1\/job-1-[a-f0-9]{64}\.mp4$/);
  assert.deepEqual(observed.body, video);
  assert.equal(artifact.adapter, 'standard-sadtalker-runpod');
  assert.equal(artifact.simulation, false);
});
