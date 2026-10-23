// Real gap found during a beta-test pass (2026-09-28): routes/video-os-lite/
// copywriter.js's own tests (tests/copywriter.test.mjs) inject a hand-rolled
// stand-in for `generate`, so the route's error-mapping is covered -- but
// services/copywriter.js's generateCopy(), the function that actually talks
// to the real paid AI Gateway and decides what status/code a timeout,
// content-filter refusal, empty output, or generic provider error becomes,
// had zero direct test coverage anywhere. This is exactly the logic that
// would silently misbehave if the `ai` SDK's error shapes or finishReason
// values ever changed.
//
// generateCopy() takes an injectable generateTextFn (added here, defaulting
// to the real `generateText` from `ai` -- a no-op change for every real
// caller, matching the same DI style already used for `generate` in
// routes/video-os-lite/copywriter.js's createCopywriterHandler), so these
// tests mock the AI SDK call directly rather than hitting a real, paid
// Gateway endpoint or trying to fake its wire format via fetch.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RetryError } from 'ai';
import { GatewayAuthenticationError, GatewayModelNotFoundError } from '@ai-sdk/gateway';
import { DEFAULT_COPYWRITER_MODEL, MAX_COPYWRITER_OUTPUT_TOKENS, describeProviderError, gatewayAuthMode, generateCopy, statusClass } from '../services/copywriter.js';

const validPayload = {
  operation: 'draft',
  brief: { topic: 'A new espresso blend', audience: 'Coffee shop regulars', goal: 'sales', tone: 'warm', keyPoints: 'Roasted locally', callToAction: 'Order online today' },
};

test('a successful generation returns the trimmed text as-is when already under the limit', async () => {
  const text = await generateCopy(validPayload, {
    generateTextFn: async () => ({ text: '  A short, punchy draft.  ', finishReason: 'stop' }),
  });
  assert.equal(text, 'A short, punchy draft.');
});

test('output longer than 900 characters is truncated to exactly 900, never returned in full', async () => {
  const longText = 'x'.repeat(1500);
  const text = await generateCopy(validPayload, {
    generateTextFn: async () => ({ text: longText, finishReason: 'stop' }),
  });
  assert.equal(text.length, 900);
  assert.equal(text, 'x'.repeat(900));
});

test('empty output after trimming is a 422 generation_refused, not a silent empty success', async () => {
  await assert.rejects(
    generateCopy(validPayload, { generateTextFn: async () => ({ text: '   ', finishReason: 'stop' }) }),
    (error) => { assert.equal(error.statusCode, 422); assert.equal(error.code, 'generation_refused'); return true; },
  );
});

test('a content-filter finishReason is a 422 generation_refused, regardless of any text returned alongside it', async () => {
  await assert.rejects(
    generateCopy(validPayload, { generateTextFn: async () => ({ text: 'partial output', finishReason: 'content-filter' }) }),
    (error) => { assert.equal(error.statusCode, 422); assert.equal(error.code, 'generation_refused'); return true; },
  );
});

test('an AbortError from the SDK call (the real shape AbortSignal.timeout produces) maps to a 504 generation_timeout, not a generic 502', async () => {
  await assert.rejects(
    generateCopy(validPayload, {
      generateTextFn: async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); },
    }),
    (error) => { assert.equal(error.statusCode, 504); assert.equal(error.code, 'generation_timeout'); return true; },
  );
});

test('a TimeoutError from the SDK call also maps to 504 generation_timeout (both abort shapes the underlying SDK/runtime can produce)', async () => {
  await assert.rejects(
    generateCopy(validPayload, {
      generateTextFn: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
    }),
    (error) => { assert.equal(error.statusCode, 504); assert.equal(error.code, 'generation_timeout'); return true; },
  );
});

test('an unrelated provider error maps to a safe 502 without retaining the raw cause', async () => {
  const providerError = Object.assign(new Error('Gateway returned 500'), { name: 'APIError' });
  await assert.rejects(
    generateCopy(validPayload, { generateTextFn: async () => { throw providerError; } }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'copywriter_provider_error');
      assert.equal(error.cause, undefined);
      assert.equal(error.providerDetail.errorName, 'APIError');
      return true;
    },
  );
});

test('provider classifications use SDK error shapes and retry lastError', async () => {
  const cases = [
    [new GatewayAuthenticationError(), 'auth', 502],
    [new GatewayModelNotFoundError(), 'model', 502],
    [Object.assign(new Error('funds'), { statusCode: 402, type: 'insufficient_funds' }), 'billing', 502],
    [new RetryError({ message: 'retry', reason: 'maxRetriesExceeded', errors: Array.from({ length: 3 }, () => Object.assign(new Error('limited'), { statusCode: 429 })) }), 'rate_limit', 502],
    [Object.assign(new Error('timeout'), { name: 'GatewayTimeoutError' }), 'timeout', 504],
  ];
  for (const [providerError, category, status] of cases) {
    await assert.rejects(generateCopy(validPayload, { generateTextFn: async () => { throw providerError; } }), error => {
      assert.equal(error.statusClass, category);
      assert.equal(error.statusCode, status);
      if (category === 'rate_limit') assert.deepEqual([error.providerDetail.retryWrapped, error.providerDetail.attempts], [true, 3]);
      return true;
    });
  }
});

test('provider detail contains only safe keys and prompt echo is discarded', () => {
  const detail = describeProviderError(Object.assign(new Error('Topic: SENTINEL_TOPIC_7f3a'), { headers: { Authorization: 'Bearer secret' }, requestBodyValues: 'secret' }), { forbidden: ['Topic: SENTINEL_TOPIC_7f3a'] });
  assert.deepEqual(Object.keys(detail), ['errorName', 'errorCode', 'providerStatus', 'providerErrorType', 'generationId', 'retryWrapped', 'attempts', 'message']);
  assert.equal(detail.message, 'AI writing could not be completed.');
  assert.equal(statusClass(detail), 'upstream');
  assert.equal(describeProviderError(new Error('wrapper', { cause: Object.assign(new Error('limited'), { statusCode: 429 }) })).providerStatus, 429);
  assert.equal(statusClass(describeProviderError(Object.assign(new Error('timeout', { cause: new Error('inner') }), { name: 'GatewayTimeoutError' }))), 'timeout');
});

test('gateway auth mode prioritizes key, then OIDC, without returning credentials', () => {
  assert.equal(gatewayAuthMode({}), 'none');
  assert.equal(gatewayAuthMode({ VERCEL_OIDC_TOKEN: 'fake-oidc' }), 'oidc');
  assert.equal(gatewayAuthMode({ VERCEL_OIDC_TOKEN: 'fake-oidc', AI_GATEWAY_API_KEY: 'fake-key' }), 'api-key');
  assert.equal(gatewayAuthMode({}, { 'x-vercel-oidc-token': 'header-value' }), 'oidc');
  assert.equal(gatewayAuthMode({}, { 'X-Vercel-Oidc-Token': 'header-value' }), 'oidc');
});

test('the configured model and prompt are actually passed through to the SDK call, and default to DEFAULT_COPYWRITER_MODEL', async () => {
  let receivedArgs;
  await generateCopy(validPayload, {
    generateTextFn: async (args) => { receivedArgs = args; return { text: 'ok', finishReason: 'stop' }; },
  });
  assert.equal(receivedArgs.model, DEFAULT_COPYWRITER_MODEL);
  assert.match(receivedArgs.prompt, /espresso blend/, 'the brief must actually reach the prompt sent to the model');
  assert.match(receivedArgs.system, /900 characters/, 'the system prompt must state the length constraint the truncation above enforces server-side too');
  assert.ok(receivedArgs.abortSignal instanceof AbortSignal, 'a real timeout signal must be wired, not omitted');
  assert.equal(receivedArgs.maxRetries, 2);
  assert.equal(receivedArgs.maxOutputTokens, 400);
});

test('configured output token cap is passed to the mocked SDK call', async () => {
  let received;
  await generateCopy(validPayload, { maxOutputTokens: 123, generateTextFn: async args => { received = args; return { text: 'ok', finishReason: 'stop' }; } });
  assert.equal(received.maxOutputTokens, 123);
  await generateCopy(validPayload, { maxOutputTokens: 100_000, generateTextFn: async args => { received = args; return { text: 'ok', finishReason: 'stop' }; } });
  assert.equal(received.maxOutputTokens, MAX_COPYWRITER_OUTPUT_TOKENS);
});

test('an explicit model override is honored instead of the default', async () => {
  let receivedModel;
  await generateCopy(validPayload, {
    model: 'anthropic/claude-haiku-explicit-override',
    generateTextFn: async (args) => { receivedModel = args.model; return { text: 'ok', finishReason: 'stop' }; },
  });
  assert.equal(receivedModel, 'anthropic/claude-haiku-explicit-override');
});
