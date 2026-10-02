import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHeygenSpaceReprobeOrigin, validateHeygenSpaceReprobeQualification, assertPinnedHeygenSpaceAnchor,
  assertVerifiedHeygenSpaceAnchor, assertFreshHeygenSpaceProof } from '../lib/heygen-space-anchor.js';

test('expired public reprobe origin is inspectable but grants no runtime authority', async () => {
  const origin = await loadHeygenSpaceReprobeOrigin();
  assert.equal(origin.verificationMode, 'refresh_review_only');
  assert.equal(origin.anchorExpiresAt, '2026-10-02T15:11:53.953Z');
  assert.ok(Object.isFrozen(origin));
  assert.throws(() => assertPinnedHeygenSpaceAnchor(origin), {code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR'});
  assert.throws(() => assertVerifiedHeygenSpaceAnchor(origin), {code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR'});
  assert.throws(() => assertFreshHeygenSpaceProof(origin), {code: 'UNVERIFIED_HEYGEN_SPACE_PROOF'});
  assert.throws(() => validateHeygenSpaceReprobeQualification({...origin}, {}), {code: 'UNVERIFIED_HEYGEN_REPROBE_ORIGIN'});
  assert.throws(() => validateHeygenSpaceReprobeQualification(origin, {}), {code: 'UNVERIFIED_HEYGEN_QUALIFICATION'});
});

test('reprobe origin inspection is unavailable inside production runtime', async () => {
  const previous = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = ' production ';
    await assert.rejects(loadHeygenSpaceReprobeOrigin(), {code: 'HEYGEN_SPACE_REPROBE_OPERATOR_ONLY'});
  } finally { if (previous === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous; }
});
