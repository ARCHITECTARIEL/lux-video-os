import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { consumeRateLimit, ensureAccount } from '../db/repositories.js';
import { rateLimits, users } from '../db/schema.js';
import { copywriterAvailability, createCopywriterHandler } from '../routes/video-os-lite/copywriter.js';
import { copywriterFailureRecord } from '../routes/video-os-lite/copywriter.js';
import { generateCopy } from '../services/copywriter.js';
import { RetryError } from 'ai';
import { prepareOpsEvent } from '../lib/ops-log.js';
import { createCopywriterIdempotency } from '../lib/copywriter-idempotency.js';

process.env.VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT = '100';
process.env.VIDEO_OS_COPYWRITER_CLIENT_GUARD = 'off';

function req(method, body = {}) {
  return { method, headers: {}, url: '/api/video-os-lite/copywriter', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
}

function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, write() {}, end(body = '') { this.raw = body; try { this.body = JSON.parse(body); } catch {} } };
}

const validBrief = { topic: 'A new espresso blend', audience: 'Coffee shop regulars', goal: 'sales', tone: 'warm', keyPoints: 'Roasted locally\nLimited batch', callToAction: 'Order online today' };
const configuredEnv = { AI_GATEWAY_API_KEY: 'FAKE1', VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT: '2', VIDEO_OS_COPYWRITER_BLOCKED_TERMS: 'Acme Law' };
const payload = (idempotencyKey = crypto.randomUUID(), brief = validBrief) => ({ operation: 'draft', idempotencyKey, brief });

test('copywriterAvailability reflects the enable flag and Gateway key independently', () => {
  const original = { enabled: process.env.VIDEO_OS_COPYWRITER_ENABLED, key: process.env.AI_GATEWAY_API_KEY };
  try {
    delete process.env.VIDEO_OS_COPYWRITER_ENABLED;
    delete process.env.AI_GATEWAY_API_KEY;
    assert.equal(copywriterAvailability().reason, 'setup_required');

    process.env.VIDEO_OS_COPYWRITER_ENABLED = 'false';
    process.env.AI_GATEWAY_API_KEY = 'gw_test_key';
    assert.equal(copywriterAvailability().reason, 'disabled');

    process.env.VIDEO_OS_COPYWRITER_ENABLED = 'true';
    const ready = copywriterAvailability();
    assert.equal(ready.available, true);
    assert.equal(ready.reason, 'ready');
    assert.deepEqual(ready.limits, { maxDraftCharacters: 900, maxBriefCharacters: 2000, maxRevisionCharacters: 600 });
  } finally {
    if (original.enabled === undefined) delete process.env.VIDEO_OS_COPYWRITER_ENABLED; else process.env.VIDEO_OS_COPYWRITER_ENABLED = original.enabled;
    if (original.key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = original.key;
  }
});

test('copywriter availability accepts OIDC as Gateway authentication', () => {
  assert.equal(copywriterAvailability({ VERCEL_OIDC_TOKEN: 'FAKE1', VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT: '100', VIDEO_OS_COPYWRITER_CLIENT_GUARD: 'off' }).reason, 'ready');
  assert.equal(copywriterAvailability({ VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT: '100', VIDEO_OS_COPYWRITER_CLIENT_GUARD: 'off' }, { 'x-vercel-oidc-token': 'FAKE1' }).reason, 'ready');
  assert.equal(copywriterAvailability({}).reason, 'setup_required');
});

test('GET uses the OIDC request header without exposing its value', async () => {
  const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env: { VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT: '100', VIDEO_OS_COPYWRITER_CLIENT_GUARD: 'off' } });
  const request = req('GET');
  request.headers['x-vercel-oidc-token'] = 'FAKE_HEADER_VALUE_FOR_TESTS';
  const response = res();
  await handler(request, response);
  assert.equal(response.body.copywriter.reason, 'ready');
  assert.equal(JSON.stringify(response.body).includes(request.headers['x-vercel-oidc-token']), false);
});

test('copywriter handler requires sign-in before anything else, on both GET and POST', async () => {
  const handler = createCopywriterHandler({ authenticate: () => { throw new Error('no session'); } });
  const getRes = res();
  await handler(req('GET'), getRes);
  assert.equal(getRes.statusCode, 401);
  assert.equal(getRes.body.code, 'sign_in_required');

  const postRes = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), postRes);
  assert.equal(postRes.statusCode, 401);
  assert.equal(postRes.body.code, 'sign_in_required');
});

test('GET always reports capability as 200, never surfaces availability as an error status', async () => {
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: false, reason: 'setup_required', message: 'AI writing needs its server connection configured.' }),
  });
  const response = res();
  await handler(req('GET'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.copywriter.reason, 'setup_required');
});

test('POST fails closed with the matching status/code when capability is unavailable', async () => {
  const unavailable = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: false, reason: 'disabled', message: 'AI writing is turned off for this deployment.' }),
  });
  const disabledRes = res();
  await unavailable(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), disabledRes);
  assert.equal(disabledRes.statusCode, 503);
  assert.equal(disabledRes.body.code, 'copywriter_unavailable');

  const notAuthorized = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: false, reason: 'not_authorized', message: 'Not available for this account.' }),
  });
  const authRes = res();
  await notAuthorized(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), authRes);
  assert.equal(authRes.statusCode, 403);
  assert.equal(authRes.body.code, 'copywriter_not_authorized');
});

test('POST rejects a malformed brief before touching rate limiting or generation', async () => {
  let rateLimitCalled = false;
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: true, reason: 'ready' }),
    rateLimit: async () => { rateLimitCalled = true; return true; },
    generate: async () => { throw new Error('must not be called'); },
  });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: 'not-a-uuid', brief: { ...validBrief, topic: '' } }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'invalid_request');
  assert.equal(rateLimitCalled, false);
});

test('POST returns 429 rate_limited without calling generate when the limit is exhausted', async () => {
  let generateCalled = false;
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: true, reason: 'ready' }),
    rateLimit: async () => false,
    generate: async () => { generateCalled = true; return 'unused'; },
  });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), response);
  assert.equal(response.statusCode, 429);
  assert.equal(response.body.code, 'rate_limited');
  assert.equal(generateCalled, false);
});

test('POST echoes the idempotency key as requestId and the requested operation on success', async () => {
  const idempotencyKey = crypto.randomUUID();
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: true, reason: 'ready' }),
    rateLimit: async () => true,
    generate: async (payload) => `Draft for ${payload.brief.topic}`,
  });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey, brief: validBrief }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.result, { text: `Draft for ${validBrief.topic}`, operation: 'draft', requestId: idempotencyKey });
});

test('a typed generation failure maps to its own status and code instead of a generic 502', async () => {
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: true, reason: 'ready' }),
    rateLimit: async () => true,
    generate: async () => { throw Object.assign(new Error('The AI declined this request.'), { statusCode: 422, code: 'generation_refused' }); },
    opsLog: () => {},
  });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), response);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'generation_refused');
  assert.equal(response.body.statusClass, 'internal');
  assert.ok(response.body.requestId);
});

test('failure record has exactly the allowed fields and ops gets one matching event', async () => {
  const events = [];
  const requestId = crypto.randomUUID();
  const record = copywriterFailureRecord({ code: 'copywriter_provider_error', statusCode: 502, statusClass: 'upstream' }, { requestId, stage: 'generate', env: {} });
  assert.deepEqual(Object.keys(record), ['event', 'requestId', 'stage', 'code', 'statusClass', 'providerStatus', 'providerErrorType', 'errorName', 'errorCode', 'message', 'model', 'gatewayAuthMode', 'retryWrapped', 'attempts', 'generationId']);
  const projected = prepareOpsEvent({ event: 'copywriter.failure', details: { ...record, headers: { authorization: 'Bearer secret' }, requestBodyValues: fakeKey } }).entry.details;
  assert.deepEqual(Object.keys(projected), Object.keys(record));
  const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), availability: () => ({ available: true }), rateLimit: async () => true, generate: async () => { throw Object.assign(new Error('failed'), { statusCode: 502, code: 'copywriter_provider_error' }); }, opsLog: event => events.push(event) });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: requestId, brief: validBrief }), response);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'copywriter.failure');
  assert.equal(events[0].correlationId, requestId);
  assert.equal(events[0].details.requestId, requestId);
});

test('ops failure does not alter 502 response and rate limit throw records its stage', async () => {
  const original = console.error;
  const lines = [];
  console.error = line => lines.push(line);
  try {
    const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), availability: () => ({ available: true }), rateLimit: async () => { throw new Error('db unavailable'); }, opsLog: () => { throw new Error('ops unavailable'); } });
    const response = res();
    await handler(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.code, 'copywriter_internal_error');
    assert.ok(response.body.requestId);
    assert.equal(JSON.parse(lines[0]).stage, 'rate_limit');
  } finally { console.error = original; }
});

const fakeKey = 'FAKE';
const fakeOidc = 'OIDC';
const promptBrief = { ...validBrief, topic: 'SENTINEL_TOPIC_7f3a', keyPoints: 'KP99' };
const promptPayload = { operation: 'revise', idempotencyKey: crypto.randomUUID(), brief: promptBrief, draft: 'SENTINEL_DRAFT_11ab', instructions: 'SENTINEL_INSTRUCTIONS_22cd' };
const secretErrors = [
  () => Object.assign(new Error(`Gateway key ${fakeKey}`), { statusCode: 502 }),
  () => Object.assign(new Error(`token ${fakeOidc}`), { statusCode: 502 }),
  () => Object.assign(new Error('Gateway failed'), { responseHeaders: { authorization: `Bearer ${fakeKey}` } }),
  () => Object.assign(new Error('Gateway failed'), { requestBodyValues: { key: fakeKey } }),
  () => Object.assign(new Error('Gateway failed'), { responseBody: `${fakeKey} https://invalid.example contact@example.com` }),
  () => Object.assign(new Error('Gateway failed'), { cause: { message: fakeKey, authorization: `Bearer ${fakeOidc}` } }),
  () => new Error('SENTINEL_TOPIC_7f3a KP99 SENTINEL_DRAFT_11ab SENTINEL_INSTRUCTIONS_22cd'),
  () => new RetryError({ message: `Bearer ${fakeKey}`, reason: 'maxRetriesExceeded', errors: [new Error('retry'), Object.assign(new Error(`SENTINEL_TOPIC_7f3a ${fakeKey} https://invalid.example contact@example.com`), { responseHeaders: { authorization: `Bearer ${fakeOidc}` }, requestBodyValues: { key: fakeKey }, responseBody: fakeKey, cause: { message: fakeOidc } })] }),
];
for (const [index, makeError] of secretErrors.entries()) {
  test(`secret-leak ${index + 1}`, async () => {
    const lines = [];
    const events = [];
    const original = console.error;
    console.error = line => lines.push(line);
    try {
      const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), availability: () => ({ available: true }), rateLimit: async () => true, opsLog: event => events.push(event), generate: payload => generateCopy(payload, { generateTextFn: async () => { throw makeError(); } }) });
      const response = res();
      await handler(req('POST', promptPayload), response);
      assert.equal(response.statusCode, 502);
      assert.equal(events.length, 1);
      const projected = events.map(event => prepareOpsEvent(event).entry.details);
      const observed = JSON.stringify({ lines, events, projected, body: response.body });
      for (const forbidden of [fakeKey, fakeOidc, 'Bearer', 'authorization', 'http', '@', 'headers', 'requestBodyValues', 'SENTINEL_TOPIC_7f3a', 'KP99', 'SENTINEL_DRAFT_11ab', 'SENTINEL_INSTRUCTIONS_22cd']) {
        assert.equal(observed.toLowerCase().includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
      }
    } finally { console.error = original; }
  });
}

test('short brief words in provider prose never enter stderr or ops events', async () => {
  const lines = [];
  const events = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), availability: () => ({ available: true }), rateLimit: async () => true, opsLog: event => events.push(event), generate: payload => generateCopy(payload, { generateTextFn: async () => { throw new Error('Acme Bob Co Zed9'); } }) });
    const response = res();
    await handler(req('POST', promptPayload), response);
    const observed = JSON.stringify({ lines, events, projected: events.map(event => prepareOpsEvent(event).entry.details) });
    for (const word of ['Acme', 'Bob Co', 'Zed9']) assert.equal(observed.includes(word), false);
    assert.equal(response.body.statusClass, 'upstream');
  } finally { console.error = original; }
});

test('secrets in provider metadata and nested retry errors never enter stderr or ops events', async () => {
  const secrets = ['FAKE_CODE_SENTINEL', 'FAKE_NAME_SENTINEL', 'FAKE_TYPE_SENTINEL', 'FAKE_CAUSE_SENTINEL', 'FAKE_LASTERROR_SENTINEL', 'FAKE_ARRAY_SENTINEL'];
  const lines = [];
  const events = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    const nested = Object.assign(new Error(secrets[4]), { name: secrets[1], code: secrets[0], type: secrets[2], cause: new Error(secrets[3]) });
    const retry = Object.assign(new Error('retry'), { name: 'AI_RetryError', lastError: nested, errors: [new Error(secrets[5])], code: secrets[0], type: secrets[2] });
    const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), availability: () => ({ available: true }), rateLimit: async () => true, opsLog: event => events.push(event), generate: payload => generateCopy(payload, { generateTextFn: async () => { throw retry; } }) });
    const response = res();
    await handler(req('POST', promptPayload), response);
    assert.equal(events.length, 1);
    const observed = JSON.stringify({ lines, events, projected: events.map(event => prepareOpsEvent(event).entry.details), body: response.body });
    for (const secret of secrets) assert.equal(observed.includes(secret), false);
    assert.equal(response.body.statusClass, 'upstream');
  } finally { console.error = original; }
});

test('ops persistence projection rejects injected diagnostic fields', () => {
  const injected = 'FAKE_FIELD_VALUE_FOR_TESTS';
  const details = prepareOpsEvent({ event: 'copywriter.failure', details: {
    event: 'copywriter.failure', code: injected, statusClass: injected,
    errorName: injected, errorCode: injected, providerErrorType: injected,
    message: injected, model: injected, generationId: injected,
  } }).entry.details;
  assert.equal(JSON.stringify(details).includes(injected), false);
});

test('shorten/improve_hook/revise require a working draft; revise also requires instructions', async () => {
  const handler = createCopywriterHandler({
    authenticate: () => ({ accountId: 'writer-1' }),
    availability: () => ({ available: true, reason: 'ready' }),
    rateLimit: async () => true,
    generate: async () => 'ok',
  });
  const missingDraft = res();
  await handler(req('POST', { operation: 'shorten', idempotencyKey: crypto.randomUUID(), brief: validBrief }), missingDraft);
  assert.equal(missingDraft.statusCode, 400);

  const missingInstructions = res();
  await handler(req('POST', { operation: 'revise', idempotencyKey: crypto.randomUUID(), brief: validBrief, draft: 'Some working draft.' }), missingInstructions);
  assert.equal(missingInstructions.statusCode, 400);
});

test('global budget and guard configuration fail closed', async () => {
  for (const value of [undefined, '0', '-1', 'nope', '1.5']) {
    const env = { ...configuredEnv, VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT: value };
    assert.equal(copywriterAvailability(env).reason, 'setup_required');
    const response = res();
    await createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env })(req('POST', payload()), response);
    assert.equal(response.body.code, 'copywriter_budget_unconfigured');
  }
  assert.equal(copywriterAvailability({ ...configuredEnv, VIDEO_OS_COPYWRITER_BLOCKED_TERMS: '' }).reason, 'setup_required');
  assert.equal(copywriterAvailability({ ...configuredEnv, VIDEO_OS_COPYWRITER_BLOCKED_TERMS: '', VIDEO_OS_COPYWRITER_CLIENT_GUARD: 'off' }).reason, 'ready');
});

test('replay uses one generation and one pair of limits; conflict and in-flight duplicate return 409', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let generated = 0;
  const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env: configuredEnv, idempotency: createCopywriterIdempotency(), rateLimit: async args => { calls.push(args); return true; }, generate: async () => { generated++; await gate; return { text: 'A draft.', truncated: false }; } });
  const body = payload();
  const first = res();
  const pending = handler(req('POST', body), first);
  await new Promise(resolve => setImmediate(resolve));
  const second = res();
  await handler(req('POST', body), second);
  assert.equal(second.body.code, 'request_in_progress');
  release();
  await pending;
  const replay = res();
  await handler(req('POST', { brief: { ...validBrief }, idempotencyKey: body.idempotencyKey, operation: 'draft' }), replay);
  assert.equal(replay.body.result.replayed, true);
  assert.equal(generated, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].key, 'copywriter:global:daily:v1');
  assert.equal(calls[1].windowMs, 86_400_000);
  const conflict = res();
  await handler(req('POST', payload(body.idempotencyKey, { ...validBrief, topic: 'Other topic' })), conflict);
  assert.equal(conflict.body.code, 'idempotency_conflict');
});

test('budget denial and budget check failure never generate; failed request can retry', async () => {
  for (const mode of ['denied', 'throw']) {
    let calls = 0;
    let generated = 0;
    const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env: configuredEnv, idempotency: createCopywriterIdempotency(), rateLimit: async () => { calls++; if (calls === 2) { if (mode === 'throw') throw Object.assign(new Error('FAKE1'), { code: 'SENTINEL' }); return false; } return true; }, generate: async () => { generated++; return 'ok'; } });
    const body = payload();
    const response = res();
    await handler(req('POST', body), response);
    assert.equal(response.body.code, mode === 'throw' ? 'copywriter_budget_unavailable' : 'copywriter_budget_reached');
    assert.equal(generated, 0);
    const retry = res();
    await handler(req('POST', body), retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(generated, 1);
  }
});

test('client names in input and output are rejected without leaking text or caching failures', async () => {
  let limited = 0;
  let generated = 0;
  const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env: configuredEnv, idempotency: createCopywriterIdempotency(), rateLimit: async () => { limited++; return true; }, generate: async () => { generated++; return generated === 1 ? 'Visit acmelaw.com today.' : 'Safe draft.'; } });
  const input = res();
  await handler(req('POST', payload(crypto.randomUUID(), { ...validBrief, keyPoints: "Аcme Law's site" })), input);
  assert.equal(input.body.code, 'client_reference_in_brief');
  assert.equal(limited, 0);
  const body = payload();
  const blocked = res();
  await handler(req('POST', body), blocked);
  assert.equal(blocked.body.code, 'client_reference_blocked');
  assert.equal(JSON.stringify(blocked.body).includes('acmelaw'), false);
  const retry = res();
  await handler(req('POST', body), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(generated, 2);
});

test('flat provider metadata, rate limit error code, and sensitive request headers stay out of stderr and ops', async () => {
  const lines = [];
  const events = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    const cases = [
      { generate: body => generateCopy(body, { generateTextFn: async () => { throw Object.assign(new Error('FAKE1'), { code: 'SENTINEL_CODE', name: 'SENTINEL_NAME', type: 'SENTINEL_TYPE', statusCode: 500 }); } }) },
      { rateLimit: async () => { throw Object.assign(new Error('FAKE1'), { code: 'SENTINEL_RATE' }); } },
    ];
    for (const options of cases) {
      const handler = createCopywriterHandler({ authenticate: () => ({ accountId: 'writer-1' }), env: configuredEnv, idempotency: createCopywriterIdempotency(), rateLimit: async () => true, opsLog: event => events.push(event), ...options });
      const request = req('POST', payload());
      request.headers['x-vercel-oidc-token'] = 'FAKEOIDC';
      request.headers.cookie = 'FAKECOOKIE';
      const response = res();
      await handler(request, response);
      assert.equal(response.statusCode, 502);
      assert.equal(response.body.code.includes('SENTINEL'), false);
    }
    assert.equal(events.length, 2);
    for (const forbidden of ['SENTINEL_CODE', 'SENTINEL_NAME', 'SENTINEL_TYPE', 'SENTINEL_RATE', 'FAKEOIDC', 'FAKECOOKIE']) {
      assert.equal(JSON.stringify(lines).includes(forbidden), false, `stderr leaked ${forbidden}`);
      assert.equal(JSON.stringify(events).includes(forbidden), false, `ops leaked ${forbidden}`);
    }
  } finally { console.error = original; }
});

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test(
  'consumeRateLimit is an atomic fixed-window counter that resets once its window expires',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-copywriter-rate-${crypto.randomUUID()}`;
    const key = `copywriter:hourly:${accountId}`;
    t.after(async () => {
      await database().delete(rateLimits).where(eq(rateLimits.key, key)).catch(() => {});
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });
    await ensureAccount({ accountId, email: `${accountId}@example.com`, name: 'Copywriter Rate Test', initialCredits: 0 });

    assert.equal(await consumeRateLimit({ accountId, key, limit: 2, windowMs: 60 * 60 * 1000 }), true);
    assert.equal(await consumeRateLimit({ accountId, key, limit: 2, windowMs: 60 * 60 * 1000 }), true);
    assert.equal(await consumeRateLimit({ accountId, key, limit: 2, windowMs: 60 * 60 * 1000 }), false);

    // Force the window into the past to prove the next call starts a fresh
    // one instead of staying permanently exhausted.
    await database().update(rateLimits).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(rateLimits.key, key));
    assert.equal(await consumeRateLimit({ accountId, key, limit: 2, windowMs: 60 * 60 * 1000 }), true);
  },
);
