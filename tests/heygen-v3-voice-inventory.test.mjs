import assert from 'node:assert/strict';
import test from 'node:test';

import { FEATURED_CAST } from '../lib/video-os-featured-cast.js';
import {
  assertTalentRateLimit,
  assertTalentSelectionsAvailable,
  loadTalentInventory,
  presenterVoiceInventoryUrls,
  talentMinuteLimit,
} from '../api/video-os/talent.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function voice(item, type = 'private') {
  return {
    voice_id: item.voiceId,
    name: item.label,
    language: 'English',
    gender: item.gender,
    support_pause: true,
    support_locale: false,
    type,
    default_engine: 'starfish',
    available_engines: ['starfish'],
  };
}

function look(item) {
  return {
    id: item.avatarId,
    name: item.label,
    status: 'completed',
    preview_image_url: `https://media.example/${item.key}.jpg`,
    supported_api_engines: ['avatar_iv'],
  };
}

function consentedLook(item) {
  return { ...look(item), group_id: `group-${item.key}`, avatar_type: 'digital_twin' };
}

function acceptedGroup(url) {
  const groupId = url.pathname.split('/').pop();
  return response({ data: { id: groupId, status: 'completed', consent_status: 'accepted' } });
}

async function loadWithVoicePayload(payload) {
  return loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value) => {
      const url = new URL(value);
      if (url.pathname === '/v3/voices') return response(payload);
      if (url.searchParams.get('ownership') === 'private') {
        return response({ data: FEATURED_CAST.map(look), has_more: false, next_token: null });
      }
      return response({ data: [], has_more: false, next_token: null });
    },
  });
}

function assertVoiceInventoryUnavailable(result) {
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert(result.talent.voices.every((item) => item.providerReady === false && item.active === false));
}

test('Presenter voice defaults use only the official v3 private inventory URL', () => {
  const urls = presenterVoiceInventoryUrls({});
  assert.equal(urls.length, 1);
  assert.deepEqual(urls.map((value) => {
    const url = new URL(value);
    return {
      origin: url.origin,
      path: url.pathname,
      type: url.searchParams.get('type'),
      limit: url.searchParams.get('limit'),
      token: url.searchParams.get('token'),
    };
  }), [
    { origin: 'https://api.heygen.com', path: '/v3/voices', type: 'private', limit: '100', token: null },
  ]);

  assert.throws(
    () => presenterVoiceInventoryUrls({ HEYGEN_VOICES_URL: 'https://api.heygen.com/v2/voices?type=private' }),
    /v3 voice inventory/i,
  );
  assert.throws(
    () => presenterVoiceInventoryUrls({ HEYGEN_VOICES_URL: 'https://example.test/v3/voices?type=private' }),
    /provider API origin/i,
  );
  assert.throws(
    () => presenterVoiceInventoryUrls({ HEYGEN_VOICES_URL: 'https://api.heygen.com/v3/voices?type=private&token=stale' }),
    /cursor token/i,
  );
  assert.throws(
    () => presenterVoiceInventoryUrls({ HEYGEN_VOICES_URL: 'https://api.heygen.com/v3/voices?limit=20' }),
    /private voices/i,
  );

  const secret = 'must-not-appear';
  assert.throws(
    () => presenterVoiceInventoryUrls({
      HEYGEN_VOICES_URL: `https://api.heygen.com/v3/voices?type=private&api_key=${secret}`,
    }),
    (error) => {
      assert.match(error.message, /query was invalid/i);
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );

  const [override] = presenterVoiceInventoryUrls({
    HEYGEN_VOICES_URL: 'https://api.heygen.com/v3/voices?type=private&limit=20',
  });
  assert.equal(override, 'https://api.heygen.com/v3/voices?type=private&limit=20');
});

test('public voice configuration is rejected and load returns a sanitized degraded inventory', async () => {
  const configuredUrl = 'https://api.heygen.com/v3/voices?type=public&limit=100';
  assert.throws(
    () => presenterVoiceInventoryUrls({ HEYGEN_VOICES_URL: configuredUrl }),
    /private voices/i,
  );
  let providerCalls = 0;
  const result = await loadTalentInventory({
    env: {
      HEYGEN_API_KEY: 'unit-test-provider-key',
      HEYGEN_VOICES_URL: configuredUrl,
    },
    fetchImpl: async (value) => {
      providerCalls += 1;
      const url = new URL(value);
      assert.notEqual(url.pathname, '/v3/voices');
      if (url.searchParams.get('ownership') === 'private') {
        return response({ data: FEATURED_CAST.map(look), has_more: false, next_token: null });
      }
      return response({ data: [], has_more: false, next_token: null });
    },
  });

  assert.equal(providerCalls, 2);
  assertVoiceInventoryUnavailable(result);
  assert.equal(JSON.stringify(result).includes(configuredUrl), false);
});

test('missing provider credentials never advertise a ready Presenter voice', async () => {
  let fetches = 0;
  const result = await loadTalentInventory({
    env: {},
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('Provider fetch should not run without a credential.');
    },
  });

  assert.equal(fetches, 0);
  assert.deepEqual(result.connection, { connected: false, status: 'credential_missing' });
  assert(result.talent.avatars.every((avatar) => avatar.providerReady === false && avatar.active === false));
  assert(result.talent.voices.length > 0);
  assert(result.talent.voices.every((voiceItem) => voiceItem.providerReady === false && voiceItem.active === false));
});

test('Presenter voice inventory follows v3 opaque cursors before loading looks and uses one shared deadline signal', async () => {
  const requests = [];
  const signals = [];
  const privateFirst = FEATURED_CAST[0];
  const privateSecond = FEATURED_CAST[1];
  const privateThird = FEATURED_CAST[3];

  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value, options) => {
      const url = new URL(value);
      requests.push(url.href);
      if (url.pathname.startsWith('/v3/avatars/group-')) return acceptedGroup(url);
      signals.push(options.signal);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Api-Key'], 'unit-test-provider-key');
      assert.equal(url.origin, 'https://api.heygen.com');
      if (url.pathname === '/v3/voices') {
        assert.equal(url.searchParams.get('type'), 'private');
        assert.equal(url.searchParams.get('limit'), '100');
        const token = url.searchParams.get('token');
        if (token === null) {
          return response({ data: [voice(privateFirst)], has_more: true, next_token: 'opaque-private-page-2' });
        }
        if (token === 'opaque-private-page-2') {
          return response({ data: [voice(privateSecond), voice(privateThird)], has_more: false, next_token: null });
        }
      }
      if (url.pathname === '/v3/avatars/looks' && url.searchParams.get('ownership') === 'private') {
        return response({ data: FEATURED_CAST.map(consentedLook), has_more: false, next_token: null });
      }
      if (url.pathname === '/v3/avatars/looks' && url.searchParams.get('ownership') === 'public') {
        return response({ data: [], has_more: false, next_token: null });
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
  });

  assert(requests.every((value) => !value.includes('/v2/')));
  assert.equal(requests.some((value) => value.includes('/v3/voices?type=public')), false);
  assert(requests.some((value) => value.includes('token=opaque-private-page-2')));
  assert.equal(requests[0].includes('/v3/voices'), true);
  assert.equal(new Set(signals).size, 1);
  assert(signals[0] instanceof AbortSignal);
  const availableIds = result.talent.voices
    .filter((item) => item.providerReady === true)
    .map((item) => item.id);
  assert(availableIds.includes('featured:ariel:voice'));
  assert(availableIds.includes('featured:oso:voice'));
  assert(availableIds.includes('featured:marcus:voice'));
  assert.equal(result.connection.status, 'connected');
});

test('a v3 voice page without explicit pagination metadata is rejected', async () => {
  const result = await loadWithVoicePayload({ data: [voice(FEATURED_CAST[0])] });
  assertVoiceInventoryUnavailable(result);
});

test('a v3 voice page with non-boolean has_more metadata is rejected', async () => {
  const result = await loadWithVoicePayload({
    data: [voice(FEATURED_CAST[0])],
    has_more: 'false',
    next_token: null,
  });
  assertVoiceInventoryUnavailable(result);
});

test('a continuing v3 voice page requires a nonempty opaque next_token', async () => {
  const result = await loadWithVoicePayload({
    data: [voice(FEATURED_CAST[0])],
    has_more: true,
    next_token: '',
  });
  assertVoiceInventoryUnavailable(result);
});

test('a terminal v3 voice page rejects a stale non-null next_token', async () => {
  const result = await loadWithVoicePayload({
    data: [voice(FEATURED_CAST[0])],
    has_more: false,
    next_token: 'stale-cursor',
  });
  assertVoiceInventoryUnavailable(result);
});

test('a v3 voice page containing a non-record item is rejected as malformed', async () => {
  const result = await loadWithVoicePayload({
    data: [voice(FEATURED_CAST[0]), null],
    has_more: false,
    next_token: null,
  });
  assertVoiceInventoryUnavailable(result);
});

test('a v3 private inventory containing an explicitly public voice record is rejected wholesale', async () => {
  const result = await loadWithVoicePayload({
    data: [
      voice(FEATURED_CAST[0], 'private'),
      voice(FEATURED_CAST[1], 'public'),
    ],
    has_more: false,
    next_token: null,
  });
  assertVoiceInventoryUnavailable(result);
});

test('a complete private inventory keeps every existing featured voice available by exact ID', async () => {
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value) => {
      const url = new URL(value);
      if (url.pathname === '/v3/voices') {
        return response({ data: FEATURED_CAST.map((item) => voice(item)), has_more: false, next_token: null });
      }
      if (url.pathname.startsWith('/v3/avatars/group-')) return acceptedGroup(url);
      if (url.searchParams.get('ownership') === 'private') {
        return response({ data: FEATURED_CAST.map(consentedLook), has_more: false, next_token: null });
      }
      return response({ data: [], has_more: false, next_token: null });
    },
  });

  for (const featured of FEATURED_CAST) {
    const avatar = result.talent.avatars.find((item) => item.id === `featured:${featured.key}`);
    const voiceItem = result.talent.voices.find((item) => item.id === `featured:${featured.key}:voice`);
    assert.equal(avatar.providerReady, true, featured.key);
    assert.equal(voiceItem.providerReady, true, featured.key);
    const selected = assertTalentSelectionsAvailable(
      { avatars: [avatar], voices: [voiceItem] },
      { avatar: { avatarId: avatar.id }, voice: { voiceId: voiceItem.id } },
    );
    assert.deepEqual(selected.providerSelections, {
      avatarId: featured.avatarId,
      voiceId: featured.voiceId,
    });
  }
});

test('complete private voices without featured group consent are not ready', async () => {
  const result = await loadWithVoicePayload({
    data: FEATURED_CAST.map((item) => voice(item)),
    has_more: false,
    next_token: null,
  });

  assert.equal(result.connection.status, 'empty_inventory');
  assert(result.talent.avatars.every((item) => item.providerReady === false));
  for (const featured of FEATURED_CAST) {
    const avatar = result.talent.avatars.find((item) => item.id === `featured:${featured.key}`);
    const voiceItem = result.talent.voices.find((item) => item.id === `featured:${featured.key}:voice`);
    assert.throws(
      () => assertTalentSelectionsAvailable(
        { avatars: [avatar], voices: [voiceItem] },
        { avatar: { avatarId: avatar.id }, voice: { voiceId: voiceItem.id } },
      ),
      /unavailable/i,
      featured.key,
    );
  }
});

test('truncated v3 voice pagination fails closed and discards every partial voice', async () => {
  let voicePage = 0;
  let providerCalls = 0;
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value) => {
      providerCalls += 1;
      const url = new URL(value);
      if (url.pathname === '/v3/voices') {
        voicePage += 1;
        return response({
          data: [voice(FEATURED_CAST[Math.min(voicePage - 1, FEATURED_CAST.length - 1)])],
          has_more: true,
          next_token: `voice-page-${voicePage + 1}`,
        });
      }
      if (url.searchParams.get('ownership') === 'private') {
        return response({ data: FEATURED_CAST.map(look), has_more: false, next_token: null });
      }
      return response({ data: [], has_more: false, next_token: null });
    },
  });

  assert.equal(voicePage, 3);
  assert.equal(providerCalls, 5);
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert(result.talent.voices.every((item) => item.providerReady === false && item.active === false));
  const arielAvatar = result.talent.avatars.find((item) => item.id === 'featured:ariel');
  const arielVoice = result.talent.voices.find((item) => item.id === 'featured:ariel:voice');
  assert.throws(
    () => assertTalentSelectionsAvailable(
      { avatars: [arielAvatar], voices: [arielVoice] },
      { avatar: { avatarId: arielAvatar.id }, voice: { voiceId: arielVoice.id } },
    ),
    /unavailable/i,
  );
});

test('the whole-request call budget stops provider amplification and leaks no credential', async () => {
  const credential = 'private-unit-test-credential';
  let providerCalls = 0;
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: credential },
    maxProviderCalls: 2,
    fetchImpl: async (value) => {
      providerCalls += 1;
      const url = new URL(value);
      assert.equal(url.href.includes(credential), false);
      return response({
        data: [voice(FEATURED_CAST[0])],
        has_more: true,
        next_token: `page-${providerCalls + 1}`,
      });
    },
  });

  assert.equal(providerCalls, 2);
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert(result.talent.voices.every((item) => item.providerReady === false && item.active === false));
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test('redirect refusal keeps the API key off a cross-origin destination and physical calls inside the logical budget', async () => {
  const credential = 'redirect-private-key';
  const destination = 'https://redirect-attacker.example/collect';
  const physicalRequests = [];
  const destinationHeaders = [];
  const transport = async (value, options) => {
    const url = new URL(value);
    physicalRequests.push(url.href);
    if (url.origin === new URL(destination).origin) {
      destinationHeaders.push(options.headers);
      return response({ data: [] });
    }
    assert.equal(url.origin, 'https://api.heygen.com');
    // This mock would follow and leak headers if redirect refusal were absent.
    if (options.redirect !== 'error') return transport(destination, options);
    return response({ location: destination }, 302);
  };
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: credential },
    maxProviderCalls: 2,
    fetchImpl: transport,
  });

  assert.equal(physicalRequests.length, 2);
  assert(physicalRequests.every((value) => new URL(value).origin === 'https://api.heygen.com'));
  assert.deepEqual(destinationHeaders, []);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assertVoiceInventoryUnavailable(result);
});

test('the default whole-request budget never exceeds eight provider calls across all inventories', async () => {
  let providerCalls = 0;
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value) => {
      providerCalls += 1;
      const url = new URL(value);
      return response({
        data: url.pathname === '/v3/voices' ? [voice(FEATURED_CAST[0])] : [look(FEATURED_CAST[0])],
        has_more: true,
        next_token: `cursor-${providerCalls + 1}`,
      });
    },
  });

  assert.equal(providerCalls, 8);
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert(result.talent.voices.every((item) => item.providerReady === false));
});

test('a voice page that finishes after the whole-request clock deadline is rejected', async () => {
  let now = 0;
  let providerCalls = 0;
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    inventoryTimeoutMs: 100,
    now: () => now,
    fetchImpl: async (value) => {
      providerCalls += 1;
      const url = new URL(value);
      assert.equal(url.pathname, '/v3/voices');
      now = 101;
      return response({ data: [voice(FEATURED_CAST[0])], has_more: false, next_token: null });
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert(result.talent.avatars.every((item) => item.providerReady === false));
  assert.equal(result.talent.voices.find((item) => item.id === 'featured:ariel:voice').providerReady, false);
  assert.equal(result.talent.voices.find((item) => item.id === 'featured:oso:voice').providerReady, false);
});

test('the shared deadline aborts a stalled response body and rejects the page', async () => {
  let providerCalls = 0;
  const startedAt = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await loadTalentInventory({
      env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
      inventoryTimeoutMs: 25,
      fetchImpl: async () => {
        providerCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() { return new Promise(() => {}); },
        };
      },
    });

    assert.equal(providerCalls, 1);
    assert(Date.now() - startedAt < 500);
    assertVoiceInventoryUnavailable(result);
  } finally {
    clearInterval(keepAlive);
  }
});

test('the shared deadline races a stalled fetch transport that ignores AbortSignal', async () => {
  let providerCalls = 0;
  const startedAt = Date.now();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const result = await loadTalentInventory({
      env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
      inventoryTimeoutMs: 25,
      fetchImpl: async () => {
        providerCalls += 1;
        return new Promise(() => {});
      },
    });

    assert.equal(providerCalls, 1);
    assert(Date.now() - startedAt < 500);
    assertVoiceInventoryUnavailable(result);
  } finally {
    clearInterval(keepAlive);
  }
});

test('failed v3 voice reads degrade and never fabricate a ready configured voice', async () => {
  const result = await loadTalentInventory({
    env: { HEYGEN_API_KEY: 'unit-test-provider-key' },
    fetchImpl: async (value) => {
      const url = new URL(value);
      if (url.pathname === '/v3/voices') {
        return response({ error: { code: 'provider_unavailable', message: 'private provider detail' } }, 503);
      }
      if (url.pathname === '/v3/avatars/looks') {
        return response({ data: FEATURED_CAST.map(look), has_more: false, next_token: null });
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
  });

  const arielAvatar = result.talent.avatars.find((item) => item.id === 'featured:ariel');
  const arielVoice = result.talent.voices.find((item) => item.id === 'featured:ariel:voice');
  assert.equal(result.connection.status, 'degraded');
  assert.equal(result.connection.connected, false);
  assert.equal(arielVoice.providerReady, false);
  assert.equal(arielVoice.active, false);
  assert.equal(JSON.stringify(result).includes('private provider detail'), false);
  assert.throws(
    () => assertTalentSelectionsAvailable(
      { avatars: [arielAvatar], voices: [arielVoice] },
      { avatar: { avatarId: arielAvatar.id }, voice: { voiceId: arielVoice.id } },
    ),
    /unavailable/i,
  );
});

test('per-account talent throttling uses the atomic limiter and returns an explicit 429', async () => {
  let seen;
  await assertTalentRateLimit('account-allowed', {
    limit: 6,
    rateLimit: async (args) => {
      seen = args;
      return true;
    },
  });
  assert.deepEqual(seen, {
    accountId: 'account-allowed',
    key: 'talent:minute:account-allowed',
    limit: 6,
    windowMs: 60_000,
  });

  await assertTalentRateLimit('account-capped', {
    limit: 99,
    rateLimit: async (args) => {
      assert.equal(args.limit, 6);
      return true;
    },
  });

  await assert.rejects(
    () => assertTalentRateLimit('account-blocked', {
      limit: 6,
      rateLimit: async () => false,
    }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'rate_limited');
      assert.match(error.message, /limit reached/i);
      return true;
    },
  );
});

test('talentMinuteLimit is bounded and defaults safely', () => {
  assert.equal(talentMinuteLimit({}), 6);
  assert.equal(talentMinuteLimit({ VIDEO_OS_TALENT_MINUTE_LIMIT: '3' }), 3);
  assert.equal(talentMinuteLimit({ VIDEO_OS_TALENT_MINUTE_LIMIT: '12' }), 6);
  assert.equal(talentMinuteLimit({ VIDEO_OS_TALENT_MINUTE_LIMIT: '0' }), 6);
  assert.equal(talentMinuteLimit({ VIDEO_OS_TALENT_MINUTE_LIMIT: '61' }), 6);
  assert.equal(talentMinuteLimit({ VIDEO_OS_TALENT_MINUTE_LIMIT: 'not-a-number' }), 6);
});
