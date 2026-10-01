import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  HEYGEN_ACCOUNT_QUALIFICATION_VERSION,
  assertQualifiedHeygenCredential,
  qualifyHeygenCredential,
} from '../services/heygen-account-qualification.js';

const NOW = '2026-10-01T12:00:00.000Z';
const API_KEY = 'qualification-secret-never-returned';

function keyData(overrides = {}) {
  return {
    key_id: 'key_qualification_1',
    key_name: 'Private operator label',
    status: 'active',
    scope_mode: 'full',
    scopes: ['*:*'],
    created_at: '2026-09-21T10:30:00Z',
    updated_at: '2026-09-21T10:30:00Z',
    expires_at: '2026-11-01T12:00:00Z',
    expires_in_seconds: 2_678_400,
    ...overrides,
  };
}

function profileData(overrides = {}) {
  return {
    username: 'private-user-name',
    email: 'private-user@example.test',
    first_name: 'Private',
    last_name: 'User',
    billing_type: 'subscription',
    wallet: null,
    subscription: { plan: 'creator' },
    usage_based: null,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sequenceFetch(descriptors, observed = []) {
  const remaining = [...descriptors];
  return async (url, options) => {
    observed.push({ url, options });
    const descriptor = remaining.shift();
    assert.ok(descriptor, `unexpected request to ${url}`);
    if (typeof descriptor === 'function') return descriptor(url, options);
    return jsonResponse(descriptor.status ?? 200, descriptor.body);
  };
}

async function qualify({ key = keyData(), profile = profileData(), apiKey = API_KEY, ...options } = {}) {
  return qualifyHeygenCredential({
    apiKey,
    now: NOW,
    fetchImpl: sequenceFetch([
      { body: { data: key } },
      { body: { data: profile } },
    ]),
    ...options,
  });
}

test('observed null expiry pair permits profile inspection without asserting expiry or account authority', async () => {
  const result = await qualify({ key: keyData({ expires_at: null, expires_in_seconds: null }) });
  assert.equal(result.publicSummary.profileProbeOutcome, 'OBSERVED');
  assert.equal(result.publicSummary.expiresInSeconds, null);
  assert.ok(!result.publicSummary.holds.some(hold => hold.code === 'CREDENTIAL_EXPIRED'));
  assert.ok(result.publicSummary.holds.some(hold => hold.code === 'CREDENTIAL_EXPIRY_FORMAT_UNVERIFIED'));
  assert.equal(result.bindingEligible, false);
});

test('a dated expiry cannot be paired with a missing remaining lifetime', async () => {
  await assert.rejects(qualify({ key: keyData({ expires_in_seconds: null }) }), { code: 'HEYGEN_QUALIFICATION_MALFORMED_RESPONSE' });
});

test('qualifies active full-scope credential while holding account binding', async () => {
  const observed = [];
  const result = await qualifyHeygenCredential({
    apiKey: `  ${API_KEY}  `,
    now: NOW,
    fetchImpl: sequenceFetch([
      { body: { data: keyData() } },
      { body: { data: profileData() } },
    ], observed),
  });

  assert.equal(result.version, HEYGEN_ACCOUNT_QUALIFICATION_VERSION);
  assert.equal(result.observedAt, NOW);
  assert.match(result.credentialKeyFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.credentialScopeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.accountScopeVerified, false);
  assert.equal(result.bindingEligible, false);
  assert.deepEqual(result.publicSummary.permissions, {
    account: { read: true },
    assets: { read: true, write: true },
    avatars: { read: true, write: true },
    voices: { read: true, write: true },
    videos: { read: true, write: true },
  });
  assert.equal('rendering' in result.publicSummary.permissions, false);
  assert.equal(result.publicSummary.profileProbeOutcome, 'OBSERVED');
  assert.deepEqual(result.publicSummary.holds, [{ code: 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE' }]);
  assert.equal(result.privateEvidence.keyId, 'key_qualification_1');
  assert.equal(result.privateEvidence.createdAt, '2026-09-21T10:30:00.000Z');
  assert.deepEqual(result.privateEvidence.profile, {
    username: 'private-user-name',
    email: 'private-user@example.test',
    billingType: 'subscription',
  });
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result.publicSummary).includes('private-user'), false);
  assert.equal(JSON.stringify(result.publicSummary).includes('example.test'), false);
  assert.equal(JSON.stringify(result.publicSummary).includes('key_qualification_1'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.publicSummary.permissions.assets), true);
  assert.throws(() => { result.publicSummary.permissions.assets.write = false; }, TypeError);

  assert.deepEqual(observed.map(({ url }) => url), [
    'https://api.heygen.com/v3/api_keys/self',
    'https://api.heygen.com/v3/users/me',
  ]);
  for (const { options } of observed) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['X-Api-Key'], API_KEY);
    assert.equal('body' in options, false);
  }
});

test('only the exact live qualification object carries process authority', async () => {
  const result = await qualify();
  assert.strictEqual(assertQualifiedHeygenCredential(result), result);
  assert.throws(() => assertQualifiedHeygenCredential(structuredClone(result)), { code: 'UNVERIFIED_HEYGEN_QUALIFICATION' });
  assert.throws(() => assertQualifiedHeygenCredential(JSON.parse(JSON.stringify(result))), { code: 'UNVERIFIED_HEYGEN_QUALIFICATION' });
  assert.throws(() => assertQualifiedHeygenCredential({ ...result }), { code: 'UNVERIFIED_HEYGEN_QUALIFICATION' });
});

test('custom qualification transport cannot mint authority outside the Node test runner', async () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const script = `
    import { qualifyHeygenCredential } from './services/heygen-account-qualification.js';
    try {
      await qualifyHeygenCredential({ apiKey: 'test-only', fetchImpl: async () => new Response('{}') });
      console.log('UNEXPECTED_SUCCESS');
    } catch (error) {
      console.log(error.code);
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout.trim(), 'INVALID_HEYGEN_QUALIFICATION_OPTIONS');
  assert.equal(child.stderr, '');
});

test('credential and scope fingerprints bind the intended independent facts', async () => {
  const base = await qualify();
  const sameTrimmedKey = await qualify({ apiKey: ` ${API_KEY} ` });
  const rotated = await qualify({ apiKey: `${API_KEY}-rotated` });
  const changedScope = await qualify({ key: keyData({ scope_mode: 'custom', scopes: [
    'account:read', 'assets:write', 'avatars:write', 'voices:write', 'videos:write',
  ] }) });
  const changedExpiry = await qualify({ key: keyData({ expires_at: '2026-12-01T12:00:00Z' }) });
  const equivalentExpirySpelling = await qualify({ key: keyData({ expires_at: '2026-11-01T08:00:00-04:00' }) });

  assert.equal(base.credentialKeyFingerprint, sameTrimmedKey.credentialKeyFingerprint);
  assert.equal(base.credentialScopeFingerprint, sameTrimmedKey.credentialScopeFingerprint);
  assert.notEqual(base.credentialKeyFingerprint, rotated.credentialKeyFingerprint);
  assert.notEqual(base.credentialScopeFingerprint, rotated.credentialScopeFingerprint);
  assert.equal(base.privateEvidence.keyIdDigest, rotated.privateEvidence.keyIdDigest);
  assert.equal(base.credentialKeyFingerprint, changedScope.credentialKeyFingerprint);
  assert.notEqual(base.credentialScopeFingerprint, changedScope.credentialScopeFingerprint);
  assert.equal(base.credentialKeyFingerprint, changedExpiry.credentialKeyFingerprint);
  assert.notEqual(base.credentialScopeFingerprint, changedExpiry.credentialScopeFingerprint);
  assert.equal(base.credentialScopeFingerprint, equivalentExpirySpelling.credentialScopeFingerprint);
});

test('custom resource write scopes imply same-resource read with literal account read', async () => {
  const result = await qualify({ key: keyData({
    scope_mode: 'custom',
    scopes: ['videos:write', 'voices:write', 'avatars:write', 'assets:write', 'account:read'],
  }) });
  assert.equal(result.publicSummary.permissions.account.read, true);
  for (const resource of ['assets', 'avatars', 'voices', 'videos']) {
    assert.deepEqual(result.publicSummary.permissions[resource], { read: true, write: true });
  }
  assert.deepEqual(result.publicSummary.holds, [{ code: 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE' }]);
  assert.deepEqual(result.privateEvidence.scopes, [
    'account:read', 'assets:write', 'avatars:write', 'videos:write', 'voices:write',
  ]);
});

test('undocumented account write does not satisfy account read or trigger profile access', async () => {
  const observed = [];
  const result = await qualifyHeygenCredential({
    apiKey: API_KEY,
    now: NOW,
    fetchImpl: sequenceFetch([{ body: { data: keyData({
      scope_mode: 'custom',
      scopes: ['account:write', 'assets:write', 'avatars:write', 'voices:write', 'videos:write'],
    }) } }], observed),
  });
  assert.equal(observed.length, 1);
  assert.equal(result.publicSummary.permissions.account.read, false);
  assert.equal(result.publicSummary.profileProbeOutcome, 'SKIPPED_MISSING_ACCOUNT_READ');
  assert.ok(result.publicSummary.holds.some(({ code }) => code === 'UNRECOGNIZED_SCOPE_PRESENT'));
  assert.ok(result.publicSummary.holds.some(({ permission }) => permission === 'account:read'));
});

test('read-only wildcard reports reads, holds every missing write, and probes profile', async () => {
  const result = await qualify({ key: keyData({ scope_mode: 'read_only', scopes: ['*:read'] }) });
  assert.equal(result.publicSummary.profileProbeOutcome, 'OBSERVED');
  assert.equal(result.publicSummary.permissions.account.read, true);
  for (const resource of ['assets', 'avatars', 'voices', 'videos']) {
    assert.deepEqual(result.publicSummary.permissions[resource], { read: true, write: false });
  }
  assert.deepEqual(
    result.publicSummary.holds.filter(({ code }) => code === 'MISSING_REQUIRED_PERMISSION').map(({ permission }) => permission),
    ['assets:write', 'avatars:write', 'voices:write', 'videos:write'],
  );
});

test('missing account read skips profile instead of making an unauthorized request', async () => {
  const observed = [];
  const result = await qualifyHeygenCredential({
    apiKey: API_KEY,
    now: NOW,
    fetchImpl: sequenceFetch([{ body: { data: keyData({ scope_mode: 'custom', scopes: ['assets:read'] }) } }], observed),
  });
  assert.equal(observed.length, 1);
  assert.equal(result.publicSummary.profileProbeOutcome, 'SKIPPED_MISSING_ACCOUNT_READ');
  assert.equal(result.privateEvidence.profile, null);
  assert.ok(result.publicSummary.holds.some(({ code }) => code === 'PROFILE_PROBE_SKIPPED_MISSING_ACCOUNT_READ'));
  assert.ok(result.publicSummary.holds.some(({ permission }) => permission === 'account:read'));
  assert.equal(result.accountScopeVerified, false);
  assert.equal(result.bindingEligible, false);
});

test('scope-mode labels never grant permissions without consistent scope entries', async () => {
  const result = await qualifyHeygenCredential({
    apiKey: API_KEY,
    now: NOW,
    fetchImpl: sequenceFetch([{ body: { data: keyData({ scope_mode: 'full', scopes: ['account:read'] }) } }, { body: { data: profileData() } }]),
  });
  assert.equal(result.publicSummary.permissions.account.read, true);
  assert.equal(result.publicSummary.permissions.assets.read, false);
  assert.ok(result.publicSummary.holds.some(({ code }) => code === 'SCOPE_MODE_SCOPE_MISMATCH'));
  assert.ok(result.publicSummary.holds.some(({ permission }) => permission === 'assets:read'));
});

test('expired, inactive, conflicting, and undocumented expiry metadata are explicit holds', async (t) => {
  await t.test('expired and inactive', async () => {
    const result = await qualify({ key: keyData({ status: 'disabled', expires_at: '2026-09-30T12:00:00Z', expires_in_seconds: -1 }) });
    assert.ok(result.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_NOT_ACTIVE'));
    assert.ok(result.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_EXPIRED'));
  });
  await t.test('expiry fields conflict', async () => {
    const result = await qualify({ key: keyData({ expires_at: '2026-11-01T12:00:00Z', expires_in_seconds: 0 }) });
    assert.ok(result.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_EXPIRY_METADATA_CONFLICT'));
  });
  await t.test('expiry remaining seconds tolerate request latency but hold material drift', async () => {
    const withinTolerance = await qualify({ key: keyData({ expires_in_seconds: 2_678_350 }) });
    const outsideTolerance = await qualify({ key: keyData({ expires_in_seconds: 2_678_300 }) });
    assert.equal(withinTolerance.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_EXPIRY_METADATA_CONFLICT'), false);
    assert.equal(outsideTolerance.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_EXPIRY_METADATA_CONFLICT'), true);
  });
  for (const expiresAt of [1_799_000_000, null]) {
    await t.test(`undocumented ${String(expiresAt)}`, async () => {
      const result = await qualify({ key: keyData({ expires_at: expiresAt }) });
      assert.equal(result.publicSummary.expiresAt, null);
      assert.ok(result.publicSummary.holds.some(({ code }) => code === 'CREDENTIAL_EXPIRY_FORMAT_UNVERIFIED'));
      assert.equal(result.privateEvidence.expiresAtObserved, expiresAt);
    });
  }
});

test('malformed key metadata and unknown modes fail closed before profile access', async (t) => {
  const cases = [
    ['missing data', { body: {} }],
    ['missing key ID', { body: { data: keyData({ key_id: undefined }) } }],
    ['unsafe key ID', { body: { data: keyData({ key_id: '../key' }) } }],
    ['unknown scope mode', { body: { data: keyData({ scope_mode: 'owner' }) } }],
    ['non-array scopes', { body: { data: keyData({ scopes: '*:*' }) } }],
    ['malformed scope', { body: { data: keyData({ scope_mode: 'custom', scopes: ['assets:admin'] }) } }],
    ['duplicate scope', { body: { data: keyData({ scopes: ['*:*', '*:*'] }) } }],
    ['invalid expiration', { body: { data: keyData({ expires_at: { seconds: 1 } }) } }],
    ['invalid remaining seconds', { body: { data: keyData({ expires_in_seconds: 1.5 }) } }],
  ];
  for (const [name, descriptor] of cases) {
    await t.test(name, async () => {
      let requests = 0;
      await assert.rejects(
        qualifyHeygenCredential({
          apiKey: API_KEY,
          now: NOW,
          fetchImpl: async () => { requests += 1; return jsonResponse(200, descriptor.body); },
        }),
        { code: 'HEYGEN_QUALIFICATION_MALFORMED_RESPONSE' },
      );
      assert.equal(requests, 1);
    });
  }
});

test('malformed profile never establishes account scope', async (t) => {
  for (const profile of [
    {},
    { username: '', email: null, billing_type: null },
    { username: 'user', email: 'email\r\nleak', billing_type: null },
    { username: 'user', email: null, billing_type: 'unknown' },
  ]) {
    await t.test(JSON.stringify(profile), async () => {
      await assert.rejects(qualify({ profile }), { code: 'HEYGEN_QUALIFICATION_MALFORMED_RESPONSE' });
    });
  }
});

test('provider authorization and HTTP failures are distinct and sanitized', async (t) => {
  const cases = [
    [401, 'invalid_api_key', 'HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE'],
    [403, 'insufficient_api_key_scope', 'HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE'],
    [429, 'rate_limited', 'HEYGEN_QUALIFICATION_RATE_LIMITED'],
    [503, 'unavailable', 'HEYGEN_QUALIFICATION_PROVIDER_FAILURE'],
    [302, 'redirect', 'HEYGEN_QUALIFICATION_REJECTED'],
  ];
  for (const [status, providerErrorCode, expectedCode] of cases) {
    await t.test(String(status), async () => {
      await assert.rejects(
        qualifyHeygenCredential({
          apiKey: API_KEY,
          now: NOW,
          fetchImpl: async () => jsonResponse(status, { error: { code: providerErrorCode, message: `${API_KEY} private-user@example.test https://secret.test` } }),
        }),
        (error) => {
          assert.equal(error.code, expectedCode);
          assert.equal(error.providerHttpStatus, status);
          assert.equal(error.providerErrorCode, providerErrorCode);
          assert.equal(error.message.includes(API_KEY), false);
          assert.equal(error.message.includes('private-user'), false);
          assert.equal(error.message.includes('secret.test'), false);
          assert.equal('cause' in error, false);
          return true;
        },
      );
    });
  }
});

test('profile authorization failure is sanitized and cannot yield partial qualification', async () => {
  await assert.rejects(
    qualifyHeygenCredential({
      apiKey: API_KEY,
      now: NOW,
      fetchImpl: sequenceFetch([
        { body: { data: keyData() } },
        { status: 403, body: { error: { code: 'insufficient_api_key_scope', message: `${API_KEY} private-user@example.test` } } },
      ]),
    }),
    (error) => {
      assert.equal(error.code, 'HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE');
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(error.message.includes('private-user'), false);
      return true;
    },
  );
});

test('network, timeout, body stall, malformed JSON, and response-size limits fail safely', async (t) => {
  await t.test('network', async () => {
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, fetchImpl: async () => { throw new Error(`${API_KEY} https://secret.test`); } }),
      (error) => error.code === 'HEYGEN_QUALIFICATION_NETWORK_FAILURE' && !error.message.includes(API_KEY),
    );
  });
  await t.test('fetch cannot forge a trusted qualification error', async () => {
    const forged = Object.assign(new Error(`${API_KEY} https://secret.test`), {
      failureCategory: 'HEYGEN_QUALIFICATION_REJECTED',
      providerErrorCode: API_KEY,
    });
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, fetchImpl: async () => { throw forged; } }),
      (error) => error.code === 'HEYGEN_QUALIFICATION_NETWORK_FAILURE'
        && !error.message.includes(API_KEY)
        && !('providerErrorCode' in error),
    );
  });
  await t.test('fetch ignores AbortSignal', async () => {
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) }),
      { code: 'HEYGEN_QUALIFICATION_TIMEOUT' },
    );
  });
  await t.test('body stalls after headers', async () => {
    const body = new ReadableStream({ start() {} });
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, timeoutMs: 5, fetchImpl: async () => new Response(body, { status: 200 }) }),
      { code: 'HEYGEN_QUALIFICATION_TIMEOUT' },
    );
  });
  await t.test('malformed JSON', async () => {
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, fetchImpl: async () => new Response(`${API_KEY} not-json`) }),
      (error) => error.code === 'HEYGEN_QUALIFICATION_MALFORMED_RESPONSE' && !error.message.includes(API_KEY),
    );
  });
  await t.test('oversize response', async () => {
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, fetchImpl: async () => new Response('x'.repeat(129 * 1024)) }),
      { code: 'HEYGEN_QUALIFICATION_RESPONSE_TOO_LARGE' },
    );
  });
  await t.test('oversize stream cancellation cannot hang', async () => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(129 * 1024)); },
      cancel() { return new Promise(() => {}); },
    });
    await assert.rejects(
      qualifyHeygenCredential({ apiKey: API_KEY, now: NOW, fetchImpl: async () => new Response(body, { status: 200 }) }),
      { code: 'HEYGEN_QUALIFICATION_RESPONSE_TOO_LARGE' },
    );
  });
});

test('invalid options and credentials fail before network access', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return jsonResponse(200, {}); };
  await assert.rejects(qualifyHeygenCredential({ apiKey: '', fetchImpl }), { code: 'HEYGEN_QUALIFICATION_CONFIG_MISSING' });
  await assert.rejects(qualifyHeygenCredential({ apiKey: 'bad\nkey', fetchImpl }), { code: 'HEYGEN_QUALIFICATION_CONFIG_MISSING' });
  await assert.rejects(qualifyHeygenCredential({ apiKey: API_KEY, fetchImpl, timeoutMs: 30_001 }), { code: 'INVALID_HEYGEN_QUALIFICATION_OPTIONS' });
  await assert.rejects(qualifyHeygenCredential({ apiKey: API_KEY, fetchImpl, baseUrl: 'https://evil.test' }), { code: 'INVALID_HEYGEN_QUALIFICATION_OPTIONS' });
  assert.equal(requests, 0);
});

test('successful GETs never invent or promote a provider workspace identity', async () => {
  const result = await qualify();
  assert.equal(result.accountScopeVerified, false);
  assert.equal(result.bindingEligible, false);
  assert.equal(result.publicSummary.accountScopeVerified, false);
  assert.equal(result.publicSummary.bindingEligible, false);
  assert.equal('providerAccountFingerprint' in result, false);
  assert.equal('workspaceId' in result, false);
  assert.equal('accountId' in result, false);
  assert.ok(result.publicSummary.holds.some(({ code }) => code === 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE'));
});
