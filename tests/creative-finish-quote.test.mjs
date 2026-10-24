import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREATIVE_FINISH_QUOTE_TTL_MS,
  issueCreativeFinishQuote,
  verifyCreativeFinishQuote,
} from '../lib/creative-finish-quote.js';

const NOW = Date.UTC(2026, 9, 14, 12);
const SECRET = 'synthetic-creative-finish-signing-secret-1234567890';
const ENV = { VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS: '7' };
const PROJECT = '11111111-1111-4111-8111-111111111111';

function binding() {
  return {
    accountId: 'account-one',
    projectId: PROJECT,
    projectBindingSha256: '9'.repeat(64),
    sourceJobId: 'source-job-one',
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    projectMode: 'premium_presenter',
    format: 'landscape',
    baseSha256: 'a'.repeat(64),
    basePrivatePathname: 'video-os/creative-base/55555555-5555-4555-8555-555555555555.mp4',
    selectionDigest: 'b'.repeat(64),
  };
}

const options = { secret: SECRET, env: ENV, now: NOW, nonce: 'synthetic-nonce-1234567890' };

test('server quote binds the project, source, retained base, selection and price without exposing private path', () => {
  const issued = issueCreativeFinishQuote(binding(), options);
  assert.equal(issued.credits, 7);
  assert.equal(issued.pricingVersion, 'creative-finish-revision-pricing/v1');
  const proof = verifyCreativeFinishQuote(issued.token, binding(), { ...options, now: NOW + 1 });
  assert.equal(proof.credits, 7);
  assert.equal(proof.projectId, PROJECT);
  assert.equal(proof.mode, 'finish_only_v1');
  assert.equal(proof.baseSha256, 'a'.repeat(64));
  assert.equal(proof.selectionSha256, 'b'.repeat(64));
  const decoded = Buffer.from(issued.token.split('.')[0], 'base64url').toString('utf8');
  assert.doesNotMatch(decoded, /source-job-one|video-os\/creative-base|account-one/);
  assert.equal(proof.expiresAt - proof.issuedAt, CREATIVE_FINISH_QUOTE_TTL_MS);
});

test('every material project, base, selection, price and signing change invalidates the quote', () => {
  const issued = issueCreativeFinishQuote(binding(), options);
  for (const changed of [
    { accountId: 'account-two' },
    { projectId: '22222222-2222-4222-8222-222222222222' },
    { projectBindingSha256: '8'.repeat(64) },
    { sourceJobId: 'source-job-two' },
    { idempotencyKey: '44444444-4444-4444-8444-444444444444' },
    { projectMode: 'luxify' },
    { format: 'vertical' },
    { baseSha256: 'c'.repeat(64) },
    { basePrivatePathname: 'video-os/creative-base/66666666-6666-4666-8666-666666666666.mp4' },
    { selectionDigest: 'd'.repeat(64) },
  ]) {
    assert.throws(() => verifyCreativeFinishQuote(issued.token, { ...binding(), ...changed }, options),
      { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  }
  assert.throws(() => verifyCreativeFinishQuote(issued.token, binding(), {
    ...options, env: { VIDEO_OS_CREATIVE_FINISH_REVISION_CREDITS: '8' },
  }), { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  assert.throws(() => verifyCreativeFinishQuote(issued.token, binding(), {
    ...options, secret: 'different-synthetic-secret-123456789012345',
  }), { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
});

test('tampering, expiry, future issuance and missing signing authority fail closed', () => {
  const issued = issueCreativeFinishQuote(binding(), options);
  assert.throws(() => verifyCreativeFinishQuote(issued.token.slice(0, -1) + 'x', binding(), options),
    { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  assert.throws(() => verifyCreativeFinishQuote(issued.token, binding(), { ...options, now: NOW + CREATIVE_FINISH_QUOTE_TTL_MS }),
    { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  assert.throws(() => verifyCreativeFinishQuote(issued.token, binding(), { ...options, now: NOW - 5_001 }),
    { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  assert.throws(() => issueCreativeFinishQuote(binding(), { ...options, secret: 'short' }),
    { code: 'CREATIVE_FINISH_QUOTE_CONFIG_MISSING' });
  assert.throws(() => issueCreativeFinishQuote({ ...binding(), basePrivatePathname: 'https://example.test/video.mp4' }, options),
    { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
  assert.throws(() => issueCreativeFinishQuote({ ...binding(), basePrivatePathname: 'video-os/finals/55555555-5555-4555-8555-555555555555.mp4' }, options),
    { code: 'CREATIVE_FINISH_QUOTE_INVALID' });
});
