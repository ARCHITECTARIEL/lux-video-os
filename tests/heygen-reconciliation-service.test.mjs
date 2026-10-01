import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMockDeleteAuthorizationForTests,
  deleteResource,
  getResource,
  inspectMockDeleteRequestsForTests,
} from '../services/heygen-reconciliation.js';

const NOW = '2026-09-30T12:00:00.000Z';
const API_KEY = 'test-api-key-never-logged';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const getCases = [
  ['asset', 'asset-1', '/v3/assets/asset-1', { data: { id: 'asset-1', status: 'ready', url: 'https://public.secret.example/asset', mime_type: 'image/png', size_bytes: 42 } }],
  ['avatar_look', 'look-1', '/v3/avatars/looks/look-1', { data: { id: 'look-1', status: 'ready', group_id: 'group-1', preview_image_url: 'https://public.secret.example/look' } }],
  ['avatar_group', 'group-1', '/v3/avatars/group-1', { data: { id: 'group-1', status: 'ready', avatars: [{ id: 'look-1' }], preview_url: 'https://public.secret.example/group' } }],
  ['voice', 'voice-1', '/v3/voices/voice-1', { data: { voice_id: 'voice-1', status: 'ready', preview_audio_url: 'https://public.secret.example/voice' } }],
  ['video', 'video-1', '/v3/videos/video-1', { data: { id: 'video-1', status: 'completed', video_url: 'https://public.secret.example/video' } }],
];

test('getResource uses only fixed official paths and returns sanitized resource data', async (t) => {
  for (const [kind, id, path, body] of getCases) {
    await t.test(kind, async () => {
      let observed;
      const result = await getResource(kind, id, {
        apiKey: API_KEY,
        now: NOW,
        correlationId: `correlation-${kind}`,
        fetchImpl: async (url, options) => {
          observed = { url, options };
          return jsonResponse(200, body);
        },
      });
      assert.equal(observed.url, `https://api.heygen.com${path}`);
      assert.equal(observed.options.method, 'GET');
      assert.equal(observed.options.redirect, 'error');
      assert.equal(observed.options.headers['X-Api-Key'], API_KEY);
      assert.equal(result.outcome, 'PRESENT');
      assert.equal(result.kind, kind);
      assert.equal(result.providerResourceId, id);
      assert.equal(result.observedAt, NOW);
      assert.equal(result.correlationId, `correlation-${kind}`);
      assert.equal(result.publicUrlOutcome, 'NOT_OBSERVED');
      assert.equal(JSON.stringify(result).includes('public.secret.example'), false);
      assert.equal(JSON.stringify(result).includes(API_KEY), false);
      if (kind === 'avatar_group') {
        assert.deepEqual(result.resource.observedMemberProviderResourceIds, ['look-1']);
        assert.equal(result.resource.membershipComplete, false, 'an exact group GET does not prove complete provider membership');
        assert.equal(Object.isFrozen(result.resource.observedMemberProviderResourceIds), true);
        assert.throws(() => result.resource.observedMemberProviderResourceIds.push('look-2'), TypeError);
      }
    });
  }
});

test('getResource maps only the exact documented 404 code to API_ABSENT', async (t) => {
  const absentCodes = {
    asset: 'asset_not_found',
    avatar_look: 'not_found',
    avatar_group: 'avatar_not_found',
    voice: 'voice_not_found',
    video: 'not_found',
  };
  for (const [kind, code] of Object.entries(absentCodes)) {
    await t.test(kind, async () => {
      const result = await getResource(kind, `${kind}-1`, {
        apiKey: API_KEY,
        now: NOW,
        fetchImpl: async () => jsonResponse(404, { error: { code, message: 'private URL https://should-not-leak.example' } }),
      });
      assert.equal(result.outcome, 'API_ABSENT');
      assert.equal(result.providerCode, code);
      assert.equal(result.publicUrlOutcome, 'NOT_OBSERVED');
      assert.equal('urlDenialObserved' in result, false);
      assert.equal(JSON.stringify(result).includes('should-not-leak.example'), false);
    });
  }
});

test('getResource keeps wrong 404, auth, rate limit, provider, network, and timeout outcomes distinct and sanitized', async (t) => {
  const cases = [
    ['wrong 404', async () => jsonResponse(404, { error: { code: 'wrong_route', message: `secret ${API_KEY} https://raw.example` } }), 'AMBIGUOUS_NOT_FOUND'],
    ['auth', async () => jsonResponse(401, { error: { code: 'invalid_api_key', message: `secret ${API_KEY}` } }), 'PROVIDER_AUTHORIZATION_FAILURE'],
    ['policy', async () => jsonResponse(403, { error: { code: 'forbidden', message: 'private detail' } }), 'PROVIDER_AUTHORIZATION_FAILURE'],
    ['rate', async () => jsonResponse(429, { error: { code: 'rate_limited', message: 'private detail' } }), 'PROVIDER_RATE_LIMITED'],
    ['provider', async () => jsonResponse(503, { error: { code: 'unavailable', message: 'private detail' } }), 'PROVIDER_FAILURE'],
    ['network', async () => { throw new Error(`secret ${API_KEY} https://raw.example`); }, 'PROVIDER_NETWORK_FAILURE'],
    ['timeout', async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`secret ${API_KEY}`)), { once: true })), 'PROVIDER_TIMEOUT', 1],
  ];
  for (const [name, fetchImpl, code, timeoutMs] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        getResource('asset', 'asset-1', { apiKey: API_KEY, fetchImpl, timeoutMs }),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(error.message.includes('raw.example'), false);
          assert.equal('cause' in error, false);
          return true;
        },
      );
    });
  }
});

test('getResource timeout remains active after headers while the response body stalls', async () => {
  const stalledBody = new ReadableStream({ start() {} });
  await assert.rejects(
    getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      timeoutMs: 5,
      fetchImpl: async () => new Response(stalledBody, { status: 200 }),
    }),
    { code: 'PROVIDER_TIMEOUT' },
  );
});

test('getResource timeout does not depend on a fetch implementation honoring AbortSignal', async () => {
  await assert.rejects(
    getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      timeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }),
    { code: 'PROVIDER_TIMEOUT' },
  );
});

test('getResource sanitizes a response-body stream failure after headers', async () => {
  const failedBody = new ReadableStream({
    pull(controller) { controller.error(new Error(`secret ${API_KEY} https://raw.example`)); },
  });
  await assert.rejects(
    getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      fetchImpl: async () => new Response(failedBody, { status: 200 }),
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_NETWORK_FAILURE');
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(error.message.includes('raw.example'), false);
      return true;
    },
  );
});

test('getResource rejects ID/path injection and arbitrary host controls before fetch', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return jsonResponse(200, {}); };
  for (const id of ['.', '..', '../users/me', 'id/other', 'id?x=y', 'https://evil.example/id', 'id%2Fother']) {
    await assert.rejects(getResource('asset', id, { apiKey: API_KEY, fetchImpl }), { code: 'INVALID_PROVIDER_RESOURCE_ID' });
  }
  await assert.rejects(getResource('asset', 'asset-1', { apiKey: API_KEY, fetchImpl, baseUrl: 'https://evil.example' }), { code: 'INVALID_TRANSPORT_OPTIONS' });
  assert.equal(fetches, 0);
});

test('getResource rejects a mismatched resource and malformed or oversized responses without exposing bodies', async (t) => {
  await t.test('mismatched ID', async () => {
    await assert.rejects(getResource('voice', 'voice-1', {
      apiKey: API_KEY,
      fetchImpl: async () => jsonResponse(200, { data: { voice_id: 'voice-2', status: 'ready' } }),
    }), { code: 'PROVIDER_RESOURCE_MISMATCH' });
  });
  await t.test('malformed JSON', async () => {
    await assert.rejects(getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      fetchImpl: async () => new Response(`not-json ${API_KEY} https://raw.example`, { status: 200 }),
    }), (error) => {
      assert.equal(error.code, 'MALFORMED_PROVIDER_RESPONSE');
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(error.message.includes('raw.example'), false);
      return true;
    });
  });
  await t.test('oversized response', async () => {
    await assert.rejects(getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      fetchImpl: async () => new Response('x'.repeat(129 * 1024), { status: 200 }),
    }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });
  await t.test('oversized response does not await a hanging stream cancel', async () => {
    const oversized = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(129 * 1024)); },
      cancel() { return new Promise(() => {}); },
    });
    await assert.rejects(getResource('asset', 'asset-1', {
      apiKey: API_KEY,
      fetchImpl: async () => new Response(oversized, { status: 200 }),
    }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  });
});

test('getResource admits only normalized MIME tokens from asset metadata', async (t) => {
  for (const mime of [
    'https://raw.example/asset',
    'private provider note',
    'text/plain; url=https://raw.example',
    'IMAGE/PNG',
    ' image/png',
    'image/png\r\nsecret',
  ]) {
    await t.test(JSON.stringify(mime), async () => {
      const result = await getResource('asset', 'asset-1', {
        apiKey: API_KEY,
        fetchImpl: async () => jsonResponse(200, { data: { id: 'asset-1', status: 'ready', mime_type: mime } }),
      });
      assert.equal(result.resource.contentType, null);
      assert.equal(JSON.stringify(result).includes(mime), false);
    });
  }
  const valid = await getResource('asset', 'asset-1', {
    apiKey: API_KEY,
    fetchImpl: async () => jsonResponse(200, { data: { id: 'asset-1', status: 'ready', mime_type: 'audio/x-wav' } }),
  });
  assert.equal(valid.resource.contentType, 'audio/x-wav');
});

test('deleteResource is hard-disabled before any production transport or credential access', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must never run'); };
  try {
    await assert.rejects(deleteResource('asset', 'asset-1'), { code: 'DELETE_EXECUTION_DISABLED' });
    await assert.rejects(deleteResource('asset', 'asset-1', { apiKey: API_KEY }), { code: 'DELETE_EXECUTION_DISABLED' });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the in-memory test-only delete context exercises exact fixed DELETE paths without network', async (t) => {
  const cases = [
    ['asset', 'asset-1', '/v3/assets/{asset_id}', '/v3/assets/asset-1', { data: { id: 'asset-1' } }],
    ['avatar_look', 'look-1', '/v3/avatars/looks/{look_id}', '/v3/avatars/looks/look-1', { data: { id: 'look-1' } }],
    ['avatar_group', 'group-1', '/v3/avatars/{group_id}', '/v3/avatars/group-1', { data: { id: 'group-1' } }],
    ['voice', 'voice-1', '/v3/voices/{voice_id}', '/v3/voices/voice-1', { data: { voice_id: 'voice-1' } }],
    ['video', 'video-1', '/v3/videos/{video_id}', '/v3/videos/video-1', { data: { id: 'video-1', deleted: true } }],
  ];
  for (const [kind, id, pathTemplate, path, body] of cases) {
    await t.test(kind, async () => {
      const context = createMockDeleteAuthorizationForTests([{ status: 200, body }]);
      const result = await deleteResource(kind, id, { apiKey: API_KEY, now: NOW, mockAuthorizationContext: context });
      assert.equal(result.outcome, 'DELETE_ACKNOWLEDGED');
      assert.equal(result.providerResourceId, id);
      assert.deepEqual(inspectMockDeleteRequestsForTests(context), [{ method: 'DELETE', pathTemplate, path }]);
      assert.equal(JSON.stringify(inspectMockDeleteRequestsForTests(context)).includes(API_KEY), false);
    });
  }
});

test('DELETE 404 is held as unproven absence and never establishes prior ownership', async () => {
  const context = createMockDeleteAuthorizationForTests([{
    status: 404,
    body: { error: { code: 'asset_not_found', message: 'could be wrong account' } },
  }]);
  await assert.rejects(
    deleteResource('asset', 'asset-1', { apiKey: API_KEY, mockAuthorizationContext: context }),
    { code: 'DELETE_ABSENCE_UNPROVEN', providerHttpStatus: 404, providerErrorCode: 'asset_not_found' },
  );
  assert.equal(inspectMockDeleteRequestsForTests(context).length, 1);
});

test('mock deletion fails closed on an invalid acknowledgement and cannot accept a fetch callback', async () => {
  const context = createMockDeleteAuthorizationForTests([{ status: 200, body: { data: { id: 'other-asset' } } }]);
  await assert.rejects(
    deleteResource('asset', 'asset-1', { apiKey: API_KEY, mockAuthorizationContext: context }),
    { code: 'MALFORMED_PROVIDER_RESPONSE' },
  );
  let fetches = 0;
  await assert.rejects(deleteResource('asset', 'asset-1', {
    apiKey: API_KEY,
    mockAuthorizationContext: createMockDeleteAuthorizationForTests([{ status: 200, body: { data: { id: 'asset-1' } } }]),
    fetchImpl: async () => { fetches += 1; return jsonResponse(200, {}); },
  }), { code: 'INVALID_TRANSPORT_OPTIONS' });
  assert.equal(fetches, 0);
});
