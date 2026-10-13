import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { enrollmentDto, identityPhotoPreviewBindingVerified, identityPhotoPreviewVerified } from '../lib/enrollment-dto.js';
import { createAssetHandler } from '../routes/video-os-lite/asset.js';

const IDS = Object.freeze({
  account: 'owner-account',
  enrollment: '22222222-2222-4222-8222-222222222222',
  identity: '33333333-3333-4333-8333-333333333333',
  photo: '11111111-1111-4111-8111-111111111111',
});
const PHOTO_BYTES = Buffer.from('exact-private-identity-photo');
const PHOTO_SHA256 = createHash('sha256').update(PHOTO_BYTES).digest('hex');
const ASSET = Object.freeze({
  id: IDS.photo,
  accountId: IDS.account,
  kind: 'identity-photo-source',
  privatePathname: 'video-os/uploads/owner/photo.png',
  contentType: 'image/png',
  bytes: PHOTO_BYTES.length,
  sha256: PHOTO_SHA256,
  quarantinedAt: null,
});
const ENROLLMENT = Object.freeze({
  id: IDS.enrollment,
  accountId: IDS.account,
  status: 'IDENTITY_READY',
  stateVersion: 8,
  displayName: 'Owner Studio',
  identityId: IDS.identity,
  photoAssetId: IDS.photo,
  photoSha256: PHOTO_SHA256,
  sourceMetadata: {},
  providerReceipts: {},
  providerReconciliationStatus: 'NONE',
  revokedAt: null,
  createdAt: new Date('2026-10-12T12:00:00.000Z'),
  updatedAt: new Date('2026-10-12T12:01:00.000Z'),
});
const IDENTITY = Object.freeze({
  id: IDS.identity,
  accountId: IDS.account,
  sourcePhotoAssetId: IDS.photo,
  archivedAt: null,
  overallStatus: 'DRAFT',
  avatarStatus: 'DRAFT',
  voiceStatus: 'DRAFT',
});

function request(accountId = ASSET.accountId) {
  return {
    method: 'GET',
    url: '/api/video-os-lite/asset?assetId=' + ASSET.id,
    headers: {},
    accountId,
  };
}

function response() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 0,
    headers,
    chunks,
    destroyed: false,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    write(value) { chunks.push(Buffer.from(value)); return true; },
    end(value) { if (value !== undefined) chunks.push(Buffer.from(value)); },
    destroy() { this.destroyed = true; },
  };
}

function handlerFor({ bytes = PHOTO_BYTES, blob = {}, asset = ASSET, enrollment = ENROLLMENT, identity = IDENTITY, onPrivateRead = () => {} } = {}) {
  return createAssetHandler({
    sessionFromRequest: req => ({ accountId: req.accountId }),
    getOwnedMediaAsset: async (accountId, assetId) => (
      accountId === asset.accountId && assetId === asset.id ? asset : null
    ),
    getCurrentIdentityPhotoBinding: async (accountId, assetId) => (
      accountId === enrollment.accountId && assetId === enrollment.photoAssetId ? { enrollment, identity } : null
    ),
    getPrivateBlob: async () => {
      onPrivateRead();
      return {
        blob: {
          pathname: asset.privatePathname,
          size: bytes.length,
          contentType: asset.contentType,
          ...blob,
        },
        stream: Readable.from([bytes]),
      };
    },
  });
}

function jsonBody(res) {
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
}

test('enrollment DTO exposes the photo URL only for the current active unarchived identity binding', () => {
  assert.equal(identityPhotoPreviewBindingVerified(ENROLLMENT, IDENTITY), true);
  assert.equal(identityPhotoPreviewVerified(ENROLLMENT, IDENTITY, ASSET), true);
  assert.equal(enrollmentDto(ENROLLMENT, IDENTITY).photo.previewUrl, '/api/video-os-lite/asset?assetId=' + IDS.photo);

  const revoked = { ...ENROLLMENT, status: 'REVOKED', revokedAt: new Date() };
  assert.equal(identityPhotoPreviewBindingVerified(revoked, IDENTITY), false);
  assert.equal(enrollmentDto(revoked, IDENTITY).photo.previewUrl, undefined);
  assert.equal(enrollmentDto(ENROLLMENT, { ...IDENTITY, archivedAt: new Date() }).photo.previewUrl, undefined);
  assert.equal(enrollmentDto(ENROLLMENT, { ...IDENTITY, sourcePhotoAssetId: '44444444-4444-4444-8444-444444444444' }).photo.previewUrl, undefined);
});

test('identity photo preview verifies pathname, byte count, and SHA-256 before sending image headers', async () => {
  const res = response();
  await handlerFor()(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), PHOTO_BYTES);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), String(PHOTO_BYTES.length));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.destroyed, false);
});

test('same-length corrupt identity photo is rejected before any image response bytes or headers', async () => {
  const corrupt = Buffer.from(PHOTO_BYTES);
  corrupt[0] ^= 0xff;
  const res = response();
  await handlerFor({ bytes: corrupt })(request(), res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.has('content-length'), false);
  assert.match(jsonBody(res).error, /unavailable/i);
});

test('identity photo preview rejects a private-store pathname mismatch before media delivery', async () => {
  const res = response();
  await handlerFor({ blob: { pathname: ASSET.privatePathname + '.wrong' } })(request(), res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.has('content-length'), false);
  assert.match(jsonBody(res).error, /unavailable/i);
});

test('cross-account identity photo preview returns not found before private storage access', async () => {
  let reads = 0;
  const handler = createAssetHandler({
    sessionFromRequest: req => ({ accountId: req.accountId }),
    getOwnedMediaAsset: async () => null,
    getPrivateBlob: async () => { reads += 1; },
  });
  const res = response();
  await handler(request('other-account'), res);
  assert.equal(res.statusCode, 404);
  assert.equal(reads, 0);
});

test('revoked, archived, or mismatched identity bindings deny photo preview while retaining historical private bytes', async t => {
  const scenarios = [
    { name: 'revoked enrollment', enrollment: { ...ENROLLMENT, status: 'REVOKED', revokedAt: new Date() }, identity: IDENTITY },
    { name: 'archived identity', enrollment: ENROLLMENT, identity: { ...IDENTITY, archivedAt: new Date() } },
    { name: 'different identity photo', enrollment: ENROLLMENT, identity: { ...IDENTITY, sourcePhotoAssetId: '44444444-4444-4444-8444-444444444444' } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let privateReads = 0;
      const retainedBytes = Buffer.from(PHOTO_BYTES);
      const retainedAsset = { ...ASSET };
      const res = response();
      await handlerFor({
        asset: retainedAsset,
        enrollment: scenario.enrollment,
        identity: scenario.identity,
        bytes: retainedBytes,
        onPrivateRead: () => { privateReads += 1; },
      })(request(), res);
      assert.equal(res.statusCode, 404);
      assert.equal(privateReads, 0);
      assert.deepEqual(retainedBytes, PHOTO_BYTES);
      assert.equal(retainedAsset.quarantinedAt, null);
      assert.equal(retainedAsset.sha256, PHOTO_SHA256);
    });
  }
});

test('unrelated owned media assets retain their existing private delivery path without identity binding reads', async () => {
  const asset = { ...ASSET, kind: 'final', jobId: 'historical-job' };
  let bindingReads = 0;
  let privateReads = 0;
  const handler = createAssetHandler({
    sessionFromRequest: req => ({ accountId: req.accountId }),
    getOwnedMediaAsset: async () => asset,
    getCurrentIdentityPhotoBinding: async () => { bindingReads += 1; return null; },
    getPrivateBlob: async () => {
      privateReads += 1;
      return { blob: { pathname: asset.privatePathname }, stream: Readable.from([PHOTO_BYTES]) };
    },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(bindingReads, 0);
  assert.equal(privateReads, 1);
  assert.deepEqual(Buffer.concat(res.chunks), PHOTO_BYTES);
});
