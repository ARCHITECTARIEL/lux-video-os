import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCRIPTED_PHOTO_PRICING_VERSION,
  digestScriptedPhotoSourceBinding,
  issueScriptedPhotoQuote,
  safeScriptedPhotoQuoteProof,
  verifyScriptedPhotoQuote,
} from '../lib/scripted-photo-quote.js';

const secret = 'scripted-photo-quote-test-secret-at-least-32-bytes';
const now = Date.parse('2026-09-30T16:00:00.000Z');
const binding = {
  accountId: 'account-owner',
  projectId: '11111111-1111-4111-8111-111111111111',
  identityId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: '44444444-4444-4444-8444-444444444444',
  title: 'Owner-approved project title',
  script: 'This exact saved script is bound into the quote.',
  format: 'vertical',
  tier: 'STANDARD',
  sourceBinding: {
    provider: 'heygen',
    consentId: '33333333-3333-4333-8333-333333333333',
    providerAvatarGroupId: 'private-provider-avatar-group',
    providerVoiceId: 'private-provider-voice',
    photoSha256: 'a'.repeat(64),
    nested: { voiceSha256: 'b'.repeat(64), enrollment: { derivationVersion: 'enrollment-media-audio-v1' } },
  },
  credits: 37,
};

function issue(overrides = {}, options = {}) {
  return issueScriptedPhotoQuote({ ...binding, ...overrides }, {
    secret,
    now,
    nonce: 'fixed-test-nonce-1234567890',
    ...options,
  });
}

test('issued quote is opaque, five-minute bounded, and verifies the complete server binding', () => {
  const quote = issue();
  assert.equal(quote.credits, 37);
  assert.equal(quote.pricingVersion, SCRIPTED_PHOTO_PRICING_VERSION);
  assert.equal(quote.expiresAt, '2026-09-30T16:05:00.000Z');
  assert.match(quote.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(quote.token, /Owner-approved|private-provider-voice|scripted-photo-quote-test-secret/);
  const verified = verifyScriptedPhotoQuote(quote.token, binding, { secret, now: now + 60_000 });
  assert.equal(verified.projectId, binding.projectId);
  assert.equal(verified.identityId, binding.identityId);
  assert.equal(verified.credits, binding.credits);
  assert.equal(verified.sourceBindingSha256, digestScriptedPhotoSourceBinding(binding.sourceBinding));
});

test('source binding digest is canonical across object key order', () => {
  const reordered = {
    nested: { enrollment: { derivationVersion: 'enrollment-media-audio-v1' }, voiceSha256: 'b'.repeat(64) },
    photoSha256: 'a'.repeat(64),
    providerAvatarGroupId: 'private-provider-avatar-group',
    providerVoiceId: 'private-provider-voice',
    consentId: '33333333-3333-4333-8333-333333333333',
    provider: 'heygen',
  };
  assert.equal(digestScriptedPhotoSourceBinding(reordered), digestScriptedPhotoSourceBinding(binding.sourceBinding));
  const quote = issue();
  assert.doesNotThrow(() => verifyScriptedPhotoQuote(quote.token, { ...binding, sourceBinding: reordered }, { secret, now }));
});

test('persistable quote proof binds the request without retaining token, nonce, script, or provider identifiers', () => {
  const quote = issue();
  const claims = verifyScriptedPhotoQuote(quote.token, binding, { secret, now });
  const proof = safeScriptedPhotoQuoteProof(claims);
  assert.equal(proof.projectId, binding.projectId);
  assert.equal(proof.identityId, binding.identityId);
  assert.equal(proof.credits, binding.credits);
  assert.equal(proof.sourceBindingSha256, digestScriptedPhotoSourceBinding(binding.sourceBinding));
  assert.match(proof.idempotencyKeySha256, /^[a-f0-9]{64}$/);
  assert.match(proof.nonceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(safeScriptedPhotoQuoteProof(proof), proof);
  for (const forbidden of ['token', 'nonce', 'script', 'title', 'providerVoiceId']) assert.equal(Object.hasOwn(proof, forbidden), false);
  for (const corrupted of [
    { ...proof, expiresAt: proof.expiresAt + 1 },
    { ...proof, credits: 1.5 },
    { ...proof, sourceBindingSha256: 'not-a-digest' },
  ]) assert.throws(() => safeScriptedPhotoQuoteProof(corrupted), { code: 'SCRIPTED_PHOTO_QUOTE_INVALID' });
});

test('tampered, malformed, expired, and future-issued quote tokens fail closed', () => {
  const quote = issue();
  const [payload, signature] = quote.token.split('.');
  for (const token of [
    `${payload}.${signature.slice(0, -1)}x`,
    `${payload.slice(0, -1)}x.${signature}`,
    'not-a-token',
    '',
  ]) assert.throws(() => verifyScriptedPhotoQuote(token, binding, { secret, now }), { code: 'SCRIPTED_PHOTO_QUOTE_INVALID' });
  assert.throws(() => verifyScriptedPhotoQuote(quote.token, binding, { secret, now: now + 300_000 }), { code: 'SCRIPTED_PHOTO_QUOTE_EXPIRED', statusCode: 410 });
  const future = issue({}, { now: now + 60_000 }).token;
  assert.throws(() => verifyScriptedPhotoQuote(future, binding, { secret, now }), { code: 'SCRIPTED_PHOTO_QUOTE_INVALID' });
});

test('every account, project, identity, content, format, tier, source, and price change invalidates the quote', () => {
  const token = issue().token;
  const changes = [
    { accountId: 'different-account' },
    { projectId: '44444444-4444-4444-8444-444444444444' },
    { identityId: '55555555-5555-4555-8555-555555555555' },
    { idempotencyKey: '66666666-6666-4666-8666-666666666666' },
    { title: `${binding.title} changed` },
    { script: `${binding.script} changed` },
    { format: 'landscape' },
    { tier: 'PREMIUM' },
    { sourceBinding: { ...binding.sourceBinding, providerAvatarGroupId: 'different-provider-avatar-group' } },
    { sourceBinding: { ...binding.sourceBinding, photoSha256: 'c'.repeat(64) } },
    { credits: 90 },
  ];
  for (const change of changes) {
    assert.throws(() => verifyScriptedPhotoQuote(token, { ...binding, ...change }, { secret, now }), { code: 'SCRIPTED_PHOTO_QUOTE_MISMATCH' });
  }
});

test('quote issue and verification fail closed without the existing session secret', () => {
  assert.throws(() => issueScriptedPhotoQuote(binding, { secret: '', now }), { code: 'SCRIPTED_PHOTO_QUOTE_CONFIG_MISSING' });
  const token = issue().token;
  assert.throws(() => verifyScriptedPhotoQuote(token, binding, { secret: '', now }), { code: 'SCRIPTED_PHOTO_QUOTE_CONFIG_MISSING' });
});
