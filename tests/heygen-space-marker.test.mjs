import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { qualifyHeygenCredential } from '../services/heygen-account-qualification.js';
import {
  heygenSpaceMarkerAssetIdDigest,
  loadPinnedHeygenSpaceMarkerManifest,
  observePinnedHeygenSpaceMarker,
  reviewHeygenSpaceMarkerForTests,
  reviewMarkerObservationForTests,
} from '../lib/heygen-space-marker.js';
import {
  assertPinnedHeygenSpaceAnchorProjection,
  loadPinnedHeygenSpaceAnchorIdentity,
  projectObservedHeygenSpaceMarker,
} from '../lib/heygen-space-anchor.js';

const NOW = '2026-10-19T15:00:00.000Z';
const ASSET_ID = 'synthetic-neutral-marker-1';
const SPACE_ID = 'synthetic-space';
const USERNAME = 'synthetic-owner';
const KEY = 'synthetic-marker-key';
const UPLOADED_AT = Math.floor(Date.parse('2026-10-19T14:55:00.000Z') / 1000);
const sha = value => createHash('sha256').update(value).digest('hex');
const usernameDigest = value => sha(Buffer.concat([
  Buffer.from('LUX_VIDEO_OS\0HEYGEN_PROFILE_USERNAME\0V1\0', 'utf8'), Buffer.from(value),
]));

async function qualification() {
  const responses = [
    { data: { key_id: 'synthetic-key-id', key_name: 'Test', status: 'active', scope_mode: 'full', scopes: ['*:*'],
      created_at: '2026-10-01T14:35:48Z', updated_at: '2026-10-01T14:35:48Z', expires_at: null, expires_in_seconds: null } },
    { data: { username: USERNAME, email: 'synthetic@example.test', first_name: 'Synthetic', last_name: 'Owner',
      billing_type: 'subscription', wallet: null, subscription: { plan: 'creator' }, usage_based: null } },
  ];
  return qualifyHeygenCredential({ apiKey: KEY, now: NOW, fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }) });
}

function fixture(q) {
  const origin = {
    fixtureSha256: '1'.repeat(64), credentialKeyFingerprint: q.credentialKeyFingerprint,
    credentialScopeFingerprint: q.credentialScopeFingerprint, keyIdDigest: q.privateEvidence.keyIdDigest,
    keyCreatedAt: q.privateEvidence.createdAt, usernameDigest: usernameDigest(USERNAME),
    providerSpaceFingerprint: sha(JSON.stringify({ provider: 'heygen', scopeType: 'space', spaceId: SPACE_ID })),
    canonicalScopeKey: '2'.repeat(64), identityDigest: '3'.repeat(64),
    spaceObservedAt: '2026-10-01T15:11:53.953Z',
  };
  const marker = {
    assetIdDigest: heygenSpaceMarkerAssetIdDigest(ASSET_ID), fixtureSha256: origin.fixtureSha256,
    expectedType: 'image', uploadedAt: UPLOADED_AT,
    credentialKeyFingerprint: origin.credentialKeyFingerprint,
    credentialScopeFingerprint: origin.credentialScopeFingerprint,
    keyIdDigest: origin.keyIdDigest, keyCreatedAt: origin.keyCreatedAt,
    usernameDigest: origin.usernameDigest, providerSpaceFingerprint: origin.providerSpaceFingerprint,
    canonicalScopeKey: origin.canonicalScopeKey, originIdentityDigest: origin.identityDigest,
    originSpaceObservedAt: origin.spaceObservedAt,
    uploadReceiptSha256: '4'.repeat(64), readReceiptSha256: '5'.repeat(64),
  };
  return { origin, marker, document: { version: 'heygen-space-marker/v1', marker } };
}

const providerResponse = (spaceId = SPACE_ID, status = 200) => new Response(JSON.stringify(status === 200
  ? { data: { id: ASSET_ID, owner: USERNAME, space_id: spaceId, type: 'image', uploaded_at: UPLOADED_AT } }
  : { error: { code: 'asset_not_found' } }), { status });

test('inactive source-declared marker grants no authority', async () => {
  assert.equal(await loadPinnedHeygenSpaceMarkerManifest(), null);
});

test('reviewed synthetic marker accepts one live read and discards private fields', async () => {
  const q = await qualification();
  const { origin, document } = fixture(q);
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  let requests = 0;
  const result = await observePinnedHeygenSpaceMarker({ origin, manifest, qualification: q, apiKey: KEY,
    markerAssetId: ASSET_ID, now: () => new Date(NOW), fetchImpl: async () => { requests += 1; return providerResponse(); } });
  assert.equal(requests, 1);
  assert.deepEqual(Object.keys(result), ['observedAt', 'freshnessEvidenceSha256']);
  assert.match(result.freshnessEvidenceSha256, /^[a-f0-9]{64}$/);
  for (const privateValue of [ASSET_ID, SPACE_ID, USERNAME, KEY]) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('wrong marker ID or changed pinned identity fails before a provider request', async () => {
  const q = await qualification();
  const { origin, document } = fixture(q);
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return providerResponse(); };
  await assert.rejects(observePinnedHeygenSpaceMarker({ origin, manifest, qualification: q, apiKey: KEY,
    markerAssetId: 'other-id', fetchImpl }), { code: 'HEYGEN_SPACE_MARKER_ID_MISMATCH' });
  assert.throws(() => reviewHeygenSpaceMarkerForTests(document, { ...origin, providerSpaceFingerprint: '0'.repeat(64) }),
    { code: 'HEYGEN_SPACE_MARKER_IDENTITY_MISMATCH' });
  assert.equal(requests, 0);
});

test('same key and owner in a different space cannot authorize creation', async () => {
  const q = await qualification();
  const { origin, document } = fixture(q);
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  await assert.rejects(observePinnedHeygenSpaceMarker({ origin, manifest, qualification: q, apiKey: KEY,
    markerAssetId: ASSET_ID, now: () => new Date(NOW), fetchImpl: async () => providerResponse('different-space') }),
  { code: 'HEYGEN_SPACE_MARKER_IDENTITY_MISMATCH' });
});

test('deleted marker fails closed without a write or fallback', async () => {
  const q = await qualification();
  const { origin, document } = fixture(q);
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  let methods = [];
  await assert.rejects(observePinnedHeygenSpaceMarker({ origin, manifest, qualification: q, apiKey: KEY,
    markerAssetId: ASSET_ID, now: () => new Date(NOW), fetchImpl: async (_url, options) => {
      methods.push(options.method); return providerResponse(null, 404);
    } }), { code: 'HEYGEN_SPACE_MARKER_NOT_FOUND' });
  assert.deepEqual(methods, ['GET']);
});

test('a branded marker observation gives the immutable identity a 60-second authority window', async () => {
  const origin = await loadPinnedHeygenSpaceAnchorIdentity();
  const observedAt = '2026-10-19T15:00:00.000Z';
  const observed = reviewMarkerObservationForTests({ observedAt, freshnessEvidenceSha256: 'a'.repeat(64) });
  const anchor = projectObservedHeygenSpaceMarker(origin, observed, { now: '2026-10-19T15:00:01.000Z' });
  assert.equal(anchor.originSpaceObservedAt, origin.spaceObservedAt);
  assert.equal(anchor.identityDigest, origin.identityDigest);
  assert.equal(anchor.providerSpaceFingerprint, origin.providerSpaceFingerprint);
  assert.equal(anchor.anchorExpiresAt, '2026-10-19T15:01:00.000Z');
  assert.equal(assertPinnedHeygenSpaceAnchorProjection(anchor, { now: '2026-10-19T15:00:59.999Z' }), anchor);
  assert.throws(() => assertPinnedHeygenSpaceAnchorProjection(anchor, { now: '2026-10-19T15:01:00.000Z' }),
    { code: 'HEYGEN_SPACE_ANCHOR_STALE' });
  assert.throws(() => projectObservedHeygenSpaceMarker({ ...origin }, observed, { now: observedAt }),
    { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' });
});
