// Real coverage gap found while edge-casing Premium tier: PREMIUM_SCRIPT_MAX_CHARS
// (900) is a genuine, server-enforced cost-control gate -- lib/video-os-validation.js's
// own comment says it exists to bound real per-render HeyGen cost exposure, not
// just a display limit -- but its exact boundary had no direct test anywhere.
// The client's textarea maxlength="900" (public/index.html, public/studio.html)
// is the same number, but that only stops normal typing; a direct API call
// bypasses it entirely, so the server-side Zod schema is the real gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrThrow, renderRequestSchema, projectRequestSchema, scriptedPhotoRenderRequestSchema, PREMIUM_SCRIPT_MAX_CHARS } from '../lib/video-os-validation.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION } from '../lib/scripted-photo-contract.js';

function baseRenderRequest(scriptLength) {
  return {
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    provider: 'heygen',
    title: 'A render',
    format: 'vertical',
    script: 'x'.repeat(scriptLength),
    avatar: { avatarId: 'featured:ariel' },
    voice: { voiceId: 'featured:ariel:voice' },
    productionKit: {},
    projectId: '22222222-2222-4222-8222-222222222222',
  };
}

test('PREMIUM_SCRIPT_MAX_CHARS is really 900, matching the client textarea maxlength', () => {
  assert.equal(PREMIUM_SCRIPT_MAX_CHARS, 900);
});

test('a script at exactly the 900-char limit is accepted', () => {
  const parsed = parseOrThrow(renderRequestSchema, baseRenderRequest(900));
  assert.equal(parsed.script.length, 900);
});

test('the Premium browser tier marker is accepted but stripped from the canonical render payload', () => {
  const legacyPayload = parseOrThrow(renderRequestSchema, baseRenderRequest(120));
  const browserPayload = parseOrThrow(renderRequestSchema, { ...baseRenderRequest(120), tier: 'PREMIUM' });

  assert.deepEqual(browserPayload, legacyPayload);
  assert.equal(Object.hasOwn(browserPayload, 'tier'), false);
});

test('the Premium schema rejects every non-PREMIUM tier value and keeps Standard separate', () => {
  for (const tier of [null, 'premium', 'STANDARD', 'PREMIUM_PLUS', true]) {
    assert.throws(
      () => parseOrThrow(renderRequestSchema, { ...baseRenderRequest(120), tier }),
      { statusCode: 400, failureCategory: 'VALIDATION' },
    );
  }
});

test('the Premium tier marker does not weaken existing provider, identity, or identifier constraints', () => {
  for (const invalidRequest of [
    { ...baseRenderRequest(120), tier: 'PREMIUM', provider: 'sadtalker' },
    { ...baseRenderRequest(120), tier: 'PREMIUM', projectId: 'not-a-uuid' },
    { ...baseRenderRequest(120), tier: 'PREMIUM', avatar: undefined, voice: undefined },
  ]) {
    assert.throws(
      () => parseOrThrow(renderRequestSchema, invalidRequest),
      { statusCode: 400, failureCategory: 'VALIDATION' },
    );
  }
});

test('accepting the Premium tier marker does not admit unknown or server-owned fields', () => {
  for (const serverOwned of [
    { costCredits: 0 },
    { accountId: 'attacker-selected-account' },
    { providerJobId: 'attacker-selected-provider-job' },
  ]) {
    assert.throws(
      () => parseOrThrow(renderRequestSchema, { ...baseRenderRequest(120), tier: 'PREMIUM', ...serverOwned }),
      { statusCode: 400, failureCategory: 'VALIDATION' },
    );
  }
});

test('scripted-photo-v1 accepts only the versioned client reference contract', () => {
  const request = {
    contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
    tier: 'STANDARD',
    projectId: '22222222-2222-4222-8222-222222222222',
    identityId: '33333333-3333-4333-8333-333333333333',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    quoteToken: 'opaque.quote-token',
    title: 'A scripted render',
    script: 'An approved saved script.',
    format: 'vertical',
  };
  assert.deepEqual(parseOrThrow(scriptedPhotoRenderRequestSchema, request), request);
  assert.doesNotThrow(() => parseOrThrow(scriptedPhotoRenderRequestSchema, { ...request, tier: 'PREMIUM' }));
  for (const tier of [undefined, null, 'standard', 'premium', 'ENTERPRISE']) {
    assert.throws(() => parseOrThrow(scriptedPhotoRenderRequestSchema, { ...request, tier }));
  }
  assert.throws(() => parseOrThrow(scriptedPhotoRenderRequestSchema, { ...request, quoteToken: undefined }));
  for (const controlled of [
    { provider: 'heygen' },
    { avatar: { avatarId: 'client-selected' } },
    { voice: { voiceId: 'client-selected' } },
    { costCredits: 1 },
    { productionKit: { overlay: 'client-selected' } },
    { renderAuthorization: { tier: 'premium' } },
    { sourceBinding: { photoSha256: 'a'.repeat(64) } },
  ]) {
    assert.throws(() => parseOrThrow(scriptedPhotoRenderRequestSchema, { ...request, ...controlled }));
  }
});

test('scripted-photo quote request requires the stable render idempotency key', async () => {
  const { scriptedPhotoQuoteRequestSchema } = await import('../lib/video-os-validation.js');
  const request = {
    action: 'quote',
    projectId: '22222222-2222-4222-8222-222222222222',
    tier: 'STANDARD',
    format: 'vertical',
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  };
  assert.deepEqual(parseOrThrow(scriptedPhotoQuoteRequestSchema, request), request);
  assert.throws(() => parseOrThrow(scriptedPhotoQuoteRequestSchema, { ...request, idempotencyKey: undefined }));
});

test('a script one character over the limit (901) is rejected with a clear 400, not forwarded to the provider', () => {
  assert.throws(
    () => parseOrThrow(renderRequestSchema, baseRenderRequest(901), 'Render request validation failed.'),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.failureCategory, 'VALIDATION');
      assert.ok(error.issues.some((issue) => issue.path === 'script'), 'the validation error must point at the script field specifically');
      return true;
    },
  );
});

test('an empty script is rejected (min length 1), not silently accepted as a free/no-op render', () => {
  assert.throws(() => parseOrThrow(renderRequestSchema, baseRenderRequest(0)));
});

test('projectRequestSchema enforces the identical 900-char cap for the saved-draft script, so a draft cannot be used to smuggle an oversized script past the render-time check', () => {
  const base = {
    title: 'A project',
    identityId: undefined,
    avatar: { id: 'featured:ariel' },
    voice: { id: 'featured:ariel:voice' },
    settings: {},
  };
  assert.doesNotThrow(() => parseOrThrow(projectRequestSchema, { ...base, script: 'x'.repeat(900) }));
  assert.throws(() => parseOrThrow(projectRequestSchema, { ...base, script: 'x'.repeat(901) }));
});
