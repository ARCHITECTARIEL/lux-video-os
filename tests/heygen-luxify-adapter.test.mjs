import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLuxifyCinematicRequest,
  normalizeLuxifyStatusResponse,
  normalizeLuxifySubmitResponse,
  pollHeygenLuxify,
  submitHeygenLuxify,
} from '../services/heygen.js';

const providerEnv = Object.freeze({ HEYGEN_API_KEY: 'synthetic-luxify-key' });

function validRequest(overrides = {}) {
  return {
    prompt: 'A founder walks through a sunlit studio in one continuous shot.',
    eligibleLookIds: ['look_primary'],
    duration: 10,
    resolution: '1080p',
    aspectRatio: '16:9',
    title: 'LUXIFY founder scene',
    ...overrides,
  };
}

test('LUXIFY request builder emits the exact bounded Cinematic Avatar body', () => {
  assert.deepEqual(buildLuxifyCinematicRequest(validRequest({
    eligibleLookIds: ['look_primary', 'look_guest'],
  })), {
    type: 'cinematic_avatar',
    prompt: 'A founder walks through a sunlit studio in one continuous shot.',
    avatar_id: ['look_primary', 'look_guest'],
    aspect_ratio: '16:9',
    resolution: '1080p',
    duration: 10,
    title: 'LUXIFY founder scene',
  });

  assert.deepEqual(buildLuxifyCinematicRequest(validRequest({ title: undefined })), {
    type: 'cinematic_avatar',
    prompt: 'A founder walks through a sunlit studio in one continuous shot.',
    avatar_id: ['look_primary'],
    aspect_ratio: '16:9',
    resolution: '1080p',
    duration: 10,
  });
});

test('LUXIFY request builder rejects script, voice, provider, model, callback, and unknown fields', () => {
  for (const forbidden of [
    { script: 'Exact words must not cross this boundary.' },
    { voice: { voiceId: 'voice_1' } },
    { voiceId: 'voice_1' },
    { provider: 'seedance' },
    { model: 'seedance-2' },
    { callbackUrl: 'https://example.com/callback' },
    { references: [] },
  ]) {
    assert.throws(
      () => buildLuxifyCinematicRequest({ ...validRequest(), ...forbidden }),
      (error) => error.code === 'LUXIFY_REQUEST_INVALID'
        && error.failureCategory === 'VALIDATION'
        && !error.message.includes('Exact words'),
    );
  }
});

test('LUXIFY request builder requires one to three unique exact eligible look IDs', () => {
  for (const eligibleLookIds of [
    [],
    ['one', 'two', 'three', 'four'],
    ['look_1', 'look_1'],
    [' look_1'],
    ['look_1 '],
    ['look/1'],
    [1],
    'look_1',
  ]) {
    assert.throws(
      () => buildLuxifyCinematicRequest(validRequest({ eligibleLookIds })),
      { code: 'LUXIFY_REQUEST_INVALID', failureCategory: 'VALIDATION' },
    );
  }
});

test('LUXIFY request builder enforces prompt, duration, resolution, aspect ratio, and title bounds', () => {
  for (const overrides of [
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 'x'.repeat(1_501) },
    { prompt: 42 },
    { duration: 3 },
    { duration: 16 },
    { duration: 4.5 },
    { duration: '10' },
    { resolution: '4k' },
    { resolution: '720P' },
    { aspectRatio: '4:3' },
    { aspectRatio: 'landscape' },
    { title: '' },
    { title: 'x'.repeat(121) },
  ]) {
    assert.throws(
      () => buildLuxifyCinematicRequest(validRequest(overrides)),
      { code: 'LUXIFY_REQUEST_INVALID', failureCategory: 'VALIDATION' },
    );
  }

  assert.equal(buildLuxifyCinematicRequest(validRequest({ prompt: 'x'.repeat(1_500) })).prompt.length, 1_500);
  assert.equal(buildLuxifyCinematicRequest(validRequest({ duration: 4, resolution: '720p', aspectRatio: '9:16' })).duration, 4);
  assert.equal(buildLuxifyCinematicRequest(validRequest({ duration: 15, aspectRatio: '1:1' })).duration, 15);
});

test('LUXIFY submit receipt normalization accepts only the official data.video_id shape', () => {
  assert.deepEqual(
    normalizeLuxifySubmitResponse({ data: { video_id: 'video_123', status: 'pending', private_debug: 'discarded' } }),
    { providerJobId: 'video_123' },
  );

  for (const payload of [
    null,
    {},
    { video_id: 'video_123' },
    { data: { id: 'video_123' } },
    { data: { video_id: ' video_123' } },
    { data: { video_id: 'video/123' } },
  ]) {
    assert.throws(
      () => normalizeLuxifySubmitResponse(payload),
      (error) => error.code === 'LUXIFY_PROVIDER_RESPONSE_INVALID'
        && error.failureCategory === 'PROVIDER_RESPONSE'
        && !error.message.includes('private_debug'),
    );
  }
});

test('LUXIFY status normalization returns only safe bounded state', () => {
  assert.deepEqual(normalizeLuxifyStatusResponse({
    data: { status: 'pending', private_diagnostic: 'discarded' },
  }), {
    ready: false,
    status: 'pending',
    sourceUrl: null,
    failureCode: null,
  });

  assert.deepEqual(normalizeLuxifyStatusResponse({
    data: {
      status: 'completed',
      video_url: 'https://files.heygen.ai/luxify.mp4?token=provider-secret',
      private_diagnostic: 'discarded',
    },
  }), {
    ready: true,
    status: 'completed',
    sourceUrl: 'https://files.heygen.ai/luxify.mp4?token=provider-secret',
    failureCode: null,
  });

  assert.deepEqual(normalizeLuxifyStatusResponse({
    data: {
      status: 'failed',
      failure_code: 'moderation_rejected',
      failure_message: 'private provider explanation',
    },
  }), {
    ready: false,
    status: 'failed',
    sourceUrl: null,
    failureCode: 'moderation_rejected',
  });
});

test('LUXIFY status normalization rejects unknown states and unsafe completed media', () => {
  for (const payload of [
    null,
    {},
    { data: {} },
    { data: { status: 'ready', video_url: 'https://files.heygen.ai/video.mp4' } },
    { data: { status: 'completed' } },
    { data: { status: 'completed', video_url: 'http://files.heygen.ai/video.mp4' } },
    { data: { status: 'completed', video_url: 'https://files.heygen.ai/video.mp4 ' } },
    { data: { status: 'completed', video_url: 'https://user:pass@files.heygen.ai/video.mp4' } },
  ]) {
    assert.throws(
      () => normalizeLuxifyStatusResponse(payload),
      { code: 'LUXIFY_PROVIDER_RESPONSE_INVALID', failureCategory: 'PROVIDER_RESPONSE' },
    );
  }
});

test('LUXIFY submission sends one idempotent POST and returns only the provider job ID', async () => {
  let calls = 0;
  const result = await submitHeygenLuxify({
    idempotencyKey: 'job-luxify-123',
    ...validRequest(),
  }, {
    env: providerEnv,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.heygen.com/v3/videos');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Api-Key'], providerEnv.HEYGEN_API_KEY);
      assert.equal(options.headers['Idempotency-Key'], 'job-luxify-123');
      assert.deepEqual(JSON.parse(options.body), buildLuxifyCinematicRequest(validRequest()));
      return new Response(JSON.stringify({
        data: { video_id: 'video_luxify_123', status: 'pending', private_debug: 'discarded' },
      }), { status: 200 });
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { providerJobId: 'video_luxify_123' });
});

test('invalid LUXIFY input fails before configuration lookup or POST', async () => {
  let calls = 0;
  await assert.rejects(
    submitHeygenLuxify({
      idempotencyKey: 'job-luxify-invalid',
      ...validRequest(),
      script: 'This field is forbidden.',
    }, {
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not send');
      },
    }),
    { code: 'LUXIFY_REQUEST_INVALID', failureCategory: 'VALIDATION' },
  );
  assert.equal(calls, 0);
});

test('missing key and invalid timeout fail before a LUXIFY POST', async () => {
  for (const env of [
    {},
    { HEYGEN_API_KEY: 'synthetic-luxify-key', HEYGEN_TIMEOUT_MS: 'not-a-number' },
    { HEYGEN_API_KEY: 'synthetic-luxify-key', HEYGEN_TIMEOUT_MS: '0' },
  ]) {
    let calls = 0;
    await assert.rejects(
      submitHeygenLuxify({
        idempotencyKey: 'job-luxify-config',
        ...validRequest(),
      }, {
        env,
        fetchImpl: async () => {
          calls += 1;
          throw new Error('must not send');
        },
      }),
      (error) => ['CONFIG_MISSING', 'CONFIG_INVALID'].includes(error.failureCategory),
    );
    assert.equal(calls, 0);
  }
});

test('invalid LUXIFY provider job IDs fail before polling', async () => {
  let calls = 0;
  await assert.rejects(
    pollHeygenLuxify(' video/unsafe ', {
      env: providerEnv,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('must not send');
      },
    }),
    { code: 'LUXIFY_REQUEST_INVALID', failureCategory: 'VALIDATION' },
  );
  assert.equal(calls, 0);
});

test('every uncertain LUXIFY POST outcome is contained after one request and never retried', async (t) => {
  const privateDiagnostic = 'private-provider-diagnostic';
  const outcomes = {
    network: () => { throw new TypeError(privateDiagnostic); },
    timeout: () => { throw new DOMException(privateDiagnostic, 'TimeoutError'); },
    body_failure: () => ({ ok: true, status: 200, text: async () => { throw new Error(privateDiagnostic); } }),
    server_error: () => new Response(JSON.stringify({ error: { code: 'upstream_failed', message: privateDiagnostic } }), { status: 503 }),
    invalid_json: () => new Response(privateDiagnostic, { status: 200 }),
    missing_video_id: () => new Response(JSON.stringify({ data: { status: 'pending', privateDiagnostic } }), { status: 200 }),
  };

  for (const [name, outcome] of Object.entries(outcomes)) {
    await t.test(name, async () => {
      let calls = 0;
      await assert.rejects(
        submitHeygenLuxify({
          idempotencyKey: `job-luxify-${name}`,
          ...validRequest(),
        }, {
          env: providerEnv,
          fetchImpl: async (_url, options) => {
            calls += 1;
            assert.equal(options.method, 'POST');
            return outcome();
          },
        }),
        (error) => {
          assert.equal(error.failureCategory, name === 'server_error' ? 'PROVIDER_RETRYABLE' : 'PROVIDER_SUBMIT_UNKNOWN');
          if (name !== 'server_error') assert.equal(error.providerSubmissionPossible, true);
          assert.equal(error.message.includes(privateDiagnostic), false);
          assert.equal(error.message.includes(providerEnv.HEYGEN_API_KEY), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    });
  }
});

test('LUXIFY redirect response and transport failures stay sanitized and are never retried', async (t) => {
  const redirectTarget = 'https://redirect.example/private-path?token=redirect-secret';

  await t.test('POST redirect response', async () => {
    let calls = 0;
    await assert.rejects(
      submitHeygenLuxify({
        idempotencyKey: 'job-luxify-redirect',
        ...validRequest(),
      }, {
        env: providerEnv,
        fetchImpl: async (_url, options) => {
          calls += 1;
          assert.equal(options.redirect, 'error');
          return new Response(JSON.stringify({ error: { message: redirectTarget } }), {
            status: 302,
            headers: { Location: redirectTarget },
          });
        },
      }),
      (error) => error.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN'
        && error.providerSubmissionPossible === true
        && !error.message.includes(redirectTarget)
        && !error.message.includes('redirect-secret')
        && !error.message.includes(providerEnv.HEYGEN_API_KEY),
    );
    assert.equal(calls, 1);
  });

  await t.test('GET redirect transport failure', async () => {
    let calls = 0;
    await assert.rejects(
      pollHeygenLuxify('video_luxify_redirect', {
        env: providerEnv,
        fetchImpl: async (_url, options) => {
          calls += 1;
          assert.equal(options.redirect, 'error');
          throw new TypeError(`redirect blocked: ${redirectTarget}`);
        },
      }),
      (error) => error.failureCategory === 'PROVIDER_POLL'
        && !error.message.includes(redirectTarget)
        && !error.message.includes('redirect-secret')
        && !error.message.includes(providerEnv.HEYGEN_API_KEY),
    );
    assert.equal(calls, 1);
  });
});

test('LUXIFY polling uses the exact GET resource and logs only the media hostname', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    let calls = 0;
    const result = await pollHeygenLuxify('video_luxify_123', {
      env: providerEnv,
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, 'https://api.heygen.com/v3/videos/video_luxify_123');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['X-Api-Key'], providerEnv.HEYGEN_API_KEY);
        return new Response(JSON.stringify({
          data: {
            status: 'completed',
            video_url: 'https://files.heygen.ai/luxify.mp4?token=provider-secret',
            private_debug: 'do-not-log',
          },
        }), { status: 200 });
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.ready, true);
    assert.equal(result.status, 'completed');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /files\.heygen\.ai/);
    assert.equal(logs[0].includes('provider-secret'), false);
    assert.equal(logs[0].includes('do-not-log'), false);
    assert.equal(logs[0].includes(providerEnv.HEYGEN_API_KEY), false);
  } finally {
    console.log = originalLog;
  }
});

test('LUXIFY polling fails closed with sanitized provider failure data', async () => {
  await assert.rejects(
    pollHeygenLuxify('video_luxify_failed', {
      env: providerEnv,
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          status: 'failed',
          failure_code: 'moderation_rejected',
          failure_message: 'private provider explanation',
        },
      }), { status: 200 }),
    }),
    (error) => error.failureCategory === 'PROVIDER_REJECTED'
      && error.providerErrorCode === 'moderation_rejected'
      && !error.message.includes('private provider explanation'),
  );
});

test('LUXIFY polling sanitizes transport failures and never retries', async () => {
  let calls = 0;
  await assert.rejects(
    pollHeygenLuxify('video_luxify_network', {
      env: providerEnv,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('private network endpoint');
      },
    }),
    (error) => error.failureCategory === 'PROVIDER_POLL'
      && !error.message.includes('private network endpoint')
      && !error.message.includes(providerEnv.HEYGEN_API_KEY),
  );
  assert.equal(calls, 1);
});
