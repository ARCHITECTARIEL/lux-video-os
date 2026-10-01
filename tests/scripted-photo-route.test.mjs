import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { verifyScriptedPhotoQuote } from '../lib/scripted-photo-quote.js';
import { createScriptedPhotoHandler, recoverOwnedJob } from '../routes/video-os-lite/scripted-photo.js';

const accountId = 'scripted-route-owner';
const projectId = '11111111-1111-4111-8111-111111111111';
const identityId = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';
const title = 'Saved scripted-photo project';
const script = 'This exact script belongs to the saved owner project.';
const secret = 'scripted-photo-route-session-secret-at-least-32-bytes';

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = raw ? JSON.parse(raw) : null; } };
}

function request(method, { body, query = '', headers = {} } = {}) {
  return {
    method,
    url: `/api/video-os-lite/scripted-photo${query}`,
    headers: {
      origin: 'https://video.example',
      'sec-fetch-site': 'same-origin',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body,
  };
}

function fixtures(overrides = {}) {
  const project = {
    id: projectId, accountId, identityId, title, script, avatar: {}, voice: {},
    settings: { contractVersion: 'scripted-photo-v1', tier: 'STANDARD', format: 'vertical' },
    createdAt: new Date('2026-09-30T15:00:00.000Z'), updatedAt: new Date('2026-09-30T15:01:00.000Z'),
  };
  const context = {
    project,
    identity: { id: identityId },
    input: {
      contractVersion: 'scripted-photo-v1', tier: 'STANDARD', projectId, identityId, script,
      avatar: { avatarId: 'private-avatar' }, voice: { voiceId: 'private-voice' },
      sourceBinding: { consentId: randomUUID(), photoSha256: 'a'.repeat(64), voiceSha256: 'b'.repeat(64), providerRenderableAvatarId: 'private-avatar', providerVoiceId: 'private-voice' },
    },
  };
  const calls = { rate: [], save: [], authorize: [], context: [], recover: [] };
  const existingJob = overrides.existingJob ?? null;
  const handler = createScriptedPhotoHandler({
    authenticate: () => ({ accountId, email: 'owner@example.test' }),
    environment: { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example', VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true', VIDEO_OS_STANDARD_SCRIPTED_CREDITS: '37' },
    rateLimit: async input => { calls.rate.push(input); return true; },
    ensureAccountRecord: async () => ({}),
    saveProjectRecord: async input => { calls.save.push(input); return project; },
    getProject: async () => project,
    getReservationContext: async input => { calls.context.push(input); return context; },
    authorizeTier: async (owner, tier) => { calls.authorize.push({ owner, tier }); },
    recoverExistingJob: async input => {
      calls.recover.push(input);
      if (existingJob && input.format !== undefined && input.format !== existingJob.format) {
        throw Object.assign(new Error('Idempotency key belongs to a different format.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      return existingJob;
    },
    quoteOptions: { secret, now: Date.parse('2026-09-30T16:00:00.000Z'), nonce: 'route-test-nonce-123456789' },
    ...overrides,
  });
  return { handler, calls, project, context };
}

test('GET capabilities stays available with precise reasons while feature and Standard price are unset', async () => {
  const { handler, calls } = fixtures({ environment: { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example' } });
  const res = response();
  await handler(request('GET'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contractVersion, 'scripted-photo-v1');
  assert.equal(res.body.pricingVersion, 'scripted-photo-pricing-v1');
  assert.equal(res.body.capabilities.enabled, false);
  assert.deepEqual(res.body.capabilities.tiers.STANDARD.reasons, ['feature_disabled', 'standard_price_unconfigured']);
  assert.deepEqual(res.body.capabilities.tiers.PREMIUM.reasons, ['feature_disabled']);
  assert.equal(res.body.existingJob, null);
  assert.equal(calls.recover.length, 0);
});

test('GET idempotency recovery returns only an owned existing job and never creates work', async () => {
  const existingJob = { id: 'job-existing', status: 'workflow_started', title, format: 'vertical', costCredits: 37 };
  const { handler, calls } = fixtures({ existingJob });
  const res = response();
  await handler(request('GET', { query: `?contractVersion=scripted-photo-v1&projectId=${projectId}&tier=STANDARD&idempotencyKey=${idempotencyKey}` }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.existingJob, existingJob);
  assert.deepEqual(calls.recover, [{ accountId, contractVersion: 'scripted-photo-v1', projectId, tier: 'STANDARD', idempotencyKey }]);
  assert.equal(calls.save.length, 0);
  assert.equal(calls.context.length, 0);
  const partial = response();
  await handler(request('GET', { query: `?idempotencyKey=${idempotencyKey}` }), partial);
  assert.equal(partial.statusCode, 400);
});

test('default recovery adapter forwards optional format to the repository binding check', async () => {
  let captured;
  const job = { id: 'job-existing', input: { contractVersion: 'scripted-photo-v1' } };
  const intent = { accountId, contractVersion: 'scripted-photo-v1', projectId, tier: 'STANDARD', format: 'landscape', idempotencyKey };
  const result = await recoverOwnedJob(intent, {
    lookup: async request => { captured = request; return job; },
    serialize: value => ({ id: value.id }),
  });
  assert.deepEqual(captured, { accountId, idempotencyKey, projectId, tier: 'STANDARD', format: 'landscape' });
  assert.deepEqual(result, { id: 'job-existing' });
});

test('save-project accepts only strict client fields and stores server-owned contract settings', async () => {
  const { handler, calls } = fixtures();
  const body = { action: 'save-project', contractVersion: 'scripted-photo-v1', projectId, tier: 'STANDARD', title, script, identityId, format: 'vertical' };
  const res = response();
  await handler(request('POST', { body }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(calls.save, [{
    id: projectId, accountId, identityId, title, script, avatar: {}, voice: {},
    settings: { contractVersion: 'scripted-photo-v1', tier: 'STANDARD', format: 'vertical' },
  }]);
  assert.deepEqual(res.body.project, {
    id: projectId, identityId, title, script, tier: 'STANDARD', format: 'vertical', contractVersion: 'scripted-photo-v1',
    createdAt: '2026-09-30T15:00:00.000Z', updatedAt: '2026-09-30T15:01:00.000Z',
  });
  const controlled = response();
  await handler(request('POST', { body: { ...body, provider: 'heygen' } }), controlled);
  assert.equal(controlled.statusCode, 400);
  assert.equal(controlled.body.code, 'invalid_request');
});

test('quote loads the owned saved project and ready identity, authorizes its tier, and exposes no provider fields', async () => {
  const { handler, calls, context } = fixtures();
  const res = response();
  await handler(request('POST', { body: { action: 'quote', projectId, tier: 'STANDARD', format: 'vertical', idempotencyKey } }), res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.quote.credits, 37);
  assert.equal(res.body.quote.pricingVersion, 'scripted-photo-pricing-v1');
  assert.ok(res.body.quote.token);
  assert.equal(res.body.project.provider, undefined);
  assert.equal(res.body.project.sourceBinding, undefined);
  assert.deepEqual(calls.authorize, [{ owner: accountId, tier: 'standard' }]);
  assert.deepEqual(calls.context, [{ accountId, projectId, identityId, title, script, tier: 'STANDARD' }]);
  assert.doesNotThrow(() => verifyScriptedPhotoQuote(res.body.quote.token, {
    accountId, projectId, identityId, idempotencyKey, title, script, format: 'vertical', tier: 'STANDARD', sourceBinding: context.input.sourceBinding, credits: 37,
  }, { secret, now: Date.parse('2026-09-30T16:01:00.000Z') }));
});

test('quote rejects saved project tier or format drift before issuing a token', async () => {
  const { handler, calls } = fixtures({
    getProject: async () => ({ id: projectId, accountId, identityId, title, script, settings: { contractVersion: 'scripted-photo-v1', tier: 'PREMIUM', format: 'vertical' } }),
  });
  const res = response();
  await handler(request('POST', { body: { action: 'quote', projectId, tier: 'STANDARD', format: 'vertical', idempotencyKey } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.quote, undefined);
  assert.equal(calls.context.length, 0);
});

test('same-key quote retry returns the exact existing job without authorizing or creating a second quote', async () => {
  const existingJob = { id: 'job-existing', status: 'provider_submitted', title, format: 'vertical', costCredits: 37 };
  const { handler, calls } = fixtures({
    existingJob,
    environment: { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example' },
    getProject: async () => { throw new Error('existing job recovery must not depend on mutable project state'); },
  });
  const res = response();
  await handler(request('POST', { body: { action: 'quote', projectId, tier: 'STANDARD', format: 'vertical', idempotencyKey } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.recovered, true);
  assert.equal(res.body.quote, null);
  assert.equal(res.body.project, null);
  assert.deepEqual(res.body.existingJob, existingJob);
  assert.equal(calls.authorize.length, 0);
  assert.equal(calls.context.length, 0);
  assert.deepEqual(calls.recover, [{ accountId, contractVersion: 'scripted-photo-v1', projectId, tier: 'STANDARD', format: 'vertical', idempotencyKey }]);
  const changedFormat = response();
  await handler(request('POST', { body: { action: 'quote', projectId, tier: 'STANDARD', format: 'landscape', idempotencyKey } }), changedFormat);
  assert.equal(changedFormat.statusCode, 409);
});

test('authentication, same-origin JSON, and account rate limits fail before mutation', async () => {
  const unauthenticated = fixtures({ authenticate: () => null });
  const authRes = response();
  await unauthenticated.handler(request('GET'), authRes);
  assert.equal(authRes.statusCode, 401);

  const wrongOrigin = fixtures();
  const originRes = response();
  await wrongOrigin.handler(request('POST', { body: {}, headers: { origin: 'https://other.example' } }), originRes);
  assert.equal(originRes.statusCode, 403);
  const missingOriginRes = response();
  await wrongOrigin.handler(request('POST', { body: {}, headers: { origin: undefined } }), missingOriginRes);
  assert.equal(missingOriginRes.statusCode, 403);

  const malformed = fixtures();
  const malformedRes = response();
  await malformed.handler(request('POST', { body: '{' }), malformedRes);
  assert.equal(malformedRes.statusCode, 400);
  assert.equal(malformedRes.body.code, 'invalid_request');

  const limited = fixtures({ rateLimit: async () => false });
  const limitedRes = response();
  await limited.handler(request('GET'), limitedRes);
  assert.equal(limitedRes.statusCode, 429);
  assert.equal(limited.calls.save.length, 0);
});
