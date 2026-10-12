import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_LUX_CREDIT_ENV,
  LUXIFY_PRICING_VERSION,
  configuredLuxifyCredits,
  digestLuxifyLookBindings,
  issueLuxifyQuote,
  safeLuxifyQuoteProof,
  verifyLuxifyQuote,
} from '../lib/luxify-quote.js';

const secret = 'luxify-quote-test-secret-at-least-32-bytes';
const now = Date.parse('2026-10-11T16:00:00.000Z');
const env = {
  [LUXIFY_LUX_CREDIT_ENV['720p']]: '41',
  [LUXIFY_LUX_CREDIT_ENV['1080p']]: '97',
  HEYGEN_SEEDANCE_720P_CREDITS: '60',
  HEYGEN_SEEDANCE_1080P_CREDITS: '150',
};
const lookBindings = [
  { identityId: '11111111-1111-4111-8111-111111111111', providerLookId: 'look_primary' },
  { identityId: '22222222-2222-4222-8222-222222222222', providerLookId: 'look_secondary' },
];
const binding = {
  accountId: 'owner-account',
  projectId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: '44444444-4444-4444-8444-444444444444',
  title: 'Owner cinematic proof',
  prompt: 'A cinematic scene with a slow camera move and generated ambient audio.',
  lookBindings,
  eligibilityRevision: 'eligible-looks-snapshot-v1:20261011',
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
};

function issue(overrides = {}, options = {}) {
  return issueLuxifyQuote({ ...binding, ...overrides }, {
    secret,
    now,
    nonce: 'fixed-luxify-nonce-123456789',
    env,
    ...options,
  });
}

test('resolution-specific configured LUX credits do not use provider-credit values', () => {
  assert.equal(configuredLuxifyCredits('720p', env), 41);
  assert.equal(configuredLuxifyCredits('1080p', env), 97);
  assert.notEqual(configuredLuxifyCredits('720p', env), Number(env.HEYGEN_SEEDANCE_720P_CREDITS));
  assert.throws(() => configuredLuxifyCredits('720p', { HEYGEN_SEEDANCE_720P_CREDITS: '60' }), { code: 'LUXIFY_QUOTE_CONFIG_MISSING', statusCode: 503 });
  assert.throws(() => configuredLuxifyCredits('4k', env), { code: 'LUXIFY_QUOTE_INVALID' });
});

test('issued quote is five-minute bounded and binds the complete server-resolved intent', () => {
  const quote = issue();
  assert.equal(quote.credits, 41);
  assert.equal(quote.currency, 'lux_credits');
  assert.equal(quote.pricingVersion, LUXIFY_PRICING_VERSION);
  assert.equal(quote.expiresAt, '2026-10-11T16:05:00.000Z');
  assert.match(quote.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  for (const sensitive of [binding.accountId, binding.prompt, lookBindings[0].providerLookId, binding.eligibilityRevision, secret]) {
    assert.equal(quote.token.includes(sensitive), false);
  }
  const claims = verifyLuxifyQuote(quote.token, binding, { secret, now: now + 60_000, env });
  assert.equal(claims.projectId, binding.projectId);
  assert.equal(claims.renderMode, 'luxify_cinematic_v1');
  assert.equal(claims.providerCapability, 'cinematic_avatar');
  assert.equal(claims.luxCredits, 41);
  assert.equal(claims.lookBindingsSha256, digestLuxifyLookBindings(lookBindings));
});

test('look binding object key order is canonical while selected look order remains bound', () => {
  const reorderedKeys = lookBindings.map(item => ({ providerLookId: item.providerLookId, identityId: item.identityId }));
  assert.equal(digestLuxifyLookBindings(reorderedKeys), digestLuxifyLookBindings(lookBindings));
  const token = issue().token;
  assert.doesNotThrow(() => verifyLuxifyQuote(token, { ...binding, lookBindings: reorderedKeys }, { secret, now, env }));
  assert.throws(() => verifyLuxifyQuote(token, { ...binding, lookBindings: [...lookBindings].reverse() }, { secret, now, env }), { code: 'LUXIFY_QUOTE_MISMATCH' });
});

test('every account, project, key, content, look, eligibility, output, duration, and price change invalidates the quote', () => {
  const token = issue().token;
  const changes = [
    { accountId: 'another-account' },
    { projectId: '55555555-5555-4555-8555-555555555555' },
    { idempotencyKey: '66666666-6666-4666-8666-666666666666' },
    { title: binding.title + ' changed' },
    { prompt: binding.prompt + ' changed' },
    { lookBindings: [{ ...lookBindings[0], providerLookId: 'look_changed' }, lookBindings[1]] },
    { eligibilityRevision: binding.eligibilityRevision + ':changed' },
    { aspectRatio: '9:16' },
    { resolution: '1080p' },
    { durationSeconds: 9 },
  ];
  for (const change of changes) {
    assert.throws(() => verifyLuxifyQuote(token, { ...binding, ...change }, { secret, now, env }), { code: 'LUXIFY_QUOTE_MISMATCH' });
  }
  assert.throws(() => verifyLuxifyQuote(token, binding, {
    secret,
    now,
    env: { ...env, [LUXIFY_LUX_CREDIT_ENV['720p']]: '42' },
  }), { code: 'LUXIFY_QUOTE_MISMATCH' });
});

test('persistable proof contains only bounded hashes and public pricing metadata', () => {
  const claims = verifyLuxifyQuote(issue().token, binding, { secret, now, env });
  const proof = safeLuxifyQuoteProof(claims);
  assert.equal(proof.projectId, binding.projectId);
  assert.equal(proof.renderMode, 'luxify_cinematic_v1');
  assert.equal(proof.providerCapability, 'cinematic_avatar');
  assert.equal(proof.luxCredits, 41);
  assert.match(proof.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(proof.lookBindingsSha256, /^[a-f0-9]{64}$/);
  assert.match(proof.eligibilityRevisionSha256, /^[a-f0-9]{64}$/);
  assert.match(proof.nonceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(safeLuxifyQuoteProof(proof), proof);
  for (const forbidden of ['token', 'nonce', 'prompt', 'title', 'lookBindings', 'providerLookId', 'eligibilityRevision']) {
    assert.equal(Object.hasOwn(proof, forbidden), false);
  }
});

test('tampered, malformed, expired, and future-issued quote tokens fail closed', () => {
  const quote = issue();
  const [payload, signature] = quote.token.split('.');
  for (const token of [
    payload + '.' + signature.slice(0, -1) + 'x',
    payload.slice(0, -1) + 'x.' + signature,
    'not-a-token',
    '',
  ]) assert.throws(() => verifyLuxifyQuote(token, binding, { secret, now, env }), { code: 'LUXIFY_QUOTE_INVALID' });
  assert.throws(() => verifyLuxifyQuote(quote.token, binding, { secret, now: now + 300_000, env }), { code: 'LUXIFY_QUOTE_EXPIRED', statusCode: 410 });
  const future = issue({}, { now: now + 60_000 }).token;
  assert.throws(() => verifyLuxifyQuote(future, binding, { secret, now, env }), { code: 'LUXIFY_QUOTE_INVALID' });
});

test('quote input, look bindings, signing secret, and pricing fail closed', () => {
  for (const invalid of [
    { ...binding, extra: true },
    { ...binding, lookBindings: [] },
    { ...binding, lookBindings: [lookBindings[0], lookBindings[0]] },
    { ...binding, lookBindings: [{ ...lookBindings[0], extra: true }] },
    { ...binding, eligibilityRevision: 'contains spaces' },
  ]) assert.throws(() => issueLuxifyQuote(invalid, { secret, now, env }), { code: 'LUXIFY_QUOTE_INVALID' });
  assert.throws(() => issueLuxifyQuote(binding, { secret: '', now, env }), { code: 'LUXIFY_QUOTE_CONFIG_MISSING' });
  assert.throws(() => issueLuxifyQuote(binding, { secret, now, env: {} }), { code: 'LUXIFY_QUOTE_CONFIG_MISSING' });
  assert.throws(() => verifyLuxifyQuote(issue().token, binding, { secret: '', now, env }), { code: 'LUXIFY_QUOTE_CONFIG_MISSING' });
});
