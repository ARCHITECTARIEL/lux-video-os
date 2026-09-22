import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { consumeRateLimit, ensureAccount } from '../db/repositories.js';
import { rateLimits, users } from '../db/schema.js';
import { copywriterAvailability, createCopywriterHandler } from '../routes/video-os-lite/copywriter.js';

function req(method, body = {}) {
  return { method, headers: {}, url: '/api/video-os-lite/copywriter', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
}

function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, write() {}, end(body = '') { this.raw = body; try { this.body = JSON.parse(body); } catch {} } };
}

const validBrief = { topic: 'A new espresso blend', audience: 'Coffee shop regulars', goal: 'sales', tone: 'warm', keyPoints: 'Roasted locally\nLimited batch', callToAction: 'Order online today' };

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
  });
  const response = res();
  await handler(req('POST', { operation: 'draft', idempotencyKey: crypto.randomUUID(), brief: validBrief }), response);
  assert.equal(response.statusCode, 422);
  assert.equal(response.body.code, 'generation_refused');
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
