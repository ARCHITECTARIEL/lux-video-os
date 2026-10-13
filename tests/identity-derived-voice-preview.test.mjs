import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { derivedVoicePreviewVerified, enrollmentDto } from '../lib/enrollment-dto.js';
import { accountHash } from '../lib/video-os-security.js';
import { createEnrollmentHandler } from '../routes/video-os-lite/enrollments.js';

const IDS = Object.freeze({
  account: 'owner-account',
  enrollment: '11111111-1111-4111-8111-111111111111',
  identity: '22222222-2222-4222-8222-222222222222',
  photo: '33333333-3333-4333-8333-333333333333',
  source: '44444444-4444-4444-8444-444444444444',
  voice: '55555555-5555-4555-8555-555555555555',
});
const VOICE_BYTES = Buffer.from('private-derived-voice-sample');
const VOICE_HASH = createHash('sha256').update(VOICE_BYTES).digest('hex');

function readyEnrollment(overrides = {}) {
  return {
    id: IDS.enrollment,
    accountId: IDS.account,
    status: 'IDENTITY_READY',
    stateVersion: 8,
    displayName: 'Owner Studio',
    photoAssetId: IDS.photo,
    photoSha256: 'b'.repeat(64),
    sourceVideoAssetId: IDS.source,
    sourceSha256: 'c'.repeat(64),
    sourceBytes: 100,
    sourceMetadata: { fullDecode: true, mimeType: 'video/mp4' },
    derivedVoiceAssetId: IDS.voice,
    derivedAudioSha256: VOICE_HASH,
    derivedAudioBytes: VOICE_BYTES.length,
    derivedAudioDurationMs: 6_000,
    derivationVersion: 'enrollment-media-audio-v1/ffmpeg-static',
    identityId: IDS.identity,
    consentAuthorizations: {},
    providerReceipts: {},
    providerReconciliationStatus: 'NONE',
    createdAt: new Date('2026-10-11T12:00:00.000Z'),
    updatedAt: new Date('2026-10-11T12:01:00.000Z'),
    revokedAt: null,
    sourceDeletedAt: null,
    ...overrides,
  };
}

function currentIdentity(overrides = {}) {
  return {
    id: IDS.identity,
    accountId: IDS.account,
    sourcePhotoAssetId: IDS.photo,
    sourceVoiceAssetId: IDS.voice,
    archivedAt: null,
    ...overrides,
  };
}

function currentVoiceAsset(record, overrides = {}) {
  return {
    id: IDS.voice,
    accountId: IDS.account,
    kind: 'identity-voice-source',
    privatePathname: 'video-os/enrollment-sources/' + accountHash(IDS.account) + '/' + record.id + '/derived-' + VOICE_HASH + '.wav',
    contentType: 'audio/wav',
    bytes: VOICE_BYTES.length,
    sha256: VOICE_HASH,
    durationMs: 6_000,
    quarantinedAt: null,
    ...overrides,
  };
}

function request(accountId = IDS.account) {
  return {
    method: 'GET',
    url: '/api/video-os-lite/enrollments?enrollmentId=' + IDS.enrollment + '&preview=voice',
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

function jsonBody(res) {
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'));
}

test('enrollment DTO exposes the exact extracted sample only for a current verified ready binding', () => {
  const current = readyEnrollment();
  const identity = currentIdentity();
  const voice = currentVoiceAsset(current);
  assert.equal(derivedVoicePreviewVerified(current, identity, voice), true);
  const visible = enrollmentDto(current, identity, { derivedVoicePreviewVerified: true });
  assert.equal(
    visible.derivedAudio.previewUrl,
    '/api/video-os-lite/enrollments?enrollmentId=' + IDS.enrollment + '&preview=voice',
  );
  assert.equal(enrollmentDto(current, identity, { derivedVoicePreviewVerified: false }).derivedAudio.previewUrl, undefined);
  assert.equal(derivedVoicePreviewVerified(current, { ...identity, archivedAt: new Date() }, voice), false);
  assert.equal(derivedVoicePreviewVerified(current, identity, { ...voice, privatePathname: voice.privatePathname + '.wrong' }), false);
  assert.equal(derivedVoicePreviewVerified(current, identity, { ...voice, contentType: 'audio/mpeg' }), false);
  assert.equal(derivedVoicePreviewVerified(current, identity, { ...voice, durationMs: voice.durationMs + 1 }), false);
});

test('owner preview streams the exact private derived WAV without a Blob URL or download disposition', async () => {
  const record = readyEnrollment();
  const asset = currentVoiceAsset(record);
  let requestedPathname = null;
  const originalGetPrivateBlob = async pathname => {
    requestedPathname = pathname;
    return {
      blob: { pathname, size: VOICE_BYTES.length, contentType: 'audio/wav' },
      stream: Readable.from([VOICE_BYTES]),
    };
  };
  const boundHandler = createEnrollmentHandler({
    sessionFromRequest: req => ({ accountId: req.accountId, email: 'owner@example.com' }),
    getOwnedEnrollment: async () => record,
    getOwnedIdentity: async () => currentIdentity(),
    getOwnedMediaAsset: async () => asset,
    getPrivateBlob: originalGetPrivateBlob,
  });
  const res = response();
  await boundHandler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), VOICE_BYTES);
  assert.equal(requestedPathname, asset.privatePathname);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.has('content-disposition'), false);
  assert.equal(res.headers.has('location'), false);
  assert.equal(res.destroyed, false);
});

test('anonymous voice preview is rejected before enrollment or private-media reads', async () => {
  let enrollmentReads = 0;
  let privateReads = 0;
  const handler = createEnrollmentHandler({
    sessionFromRequest: () => {
      throw Object.assign(new Error('Sign in required.'), { statusCode: 401 });
    },
    getOwnedEnrollment: async () => { enrollmentReads += 1; },
    getPrivateBlob: async () => { privateReads += 1; },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(enrollmentReads, 0);
  assert.equal(privateReads, 0);
});

test('same-length corrupt derived audio is rejected before any audio response bytes or headers', async () => {
  const record = readyEnrollment();
  const asset = currentVoiceAsset(record);
  const corrupt = Buffer.from(VOICE_BYTES);
  corrupt[0] ^= 0xff;
  const handler = createEnrollmentHandler({
    sessionFromRequest: req => ({ accountId: req.accountId, email: 'owner@example.com' }),
    getOwnedEnrollment: async () => record,
    getOwnedIdentity: async () => currentIdentity(),
    getOwnedMediaAsset: async () => asset,
    getPrivateBlob: async () => ({
      blob: { pathname: asset.privatePathname, size: corrupt.length, contentType: 'audio/wav' },
      stream: Readable.from([corrupt]),
    }),
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.has('content-length'), false);
  assert.equal(res.headers.has('content-disposition'), false);
  assert.match(jsonBody(res).error, /unavailable/i);
});

test('voice preview denies cross-account, revoked, archived, mismatched, and quarantined bindings before private bytes', async t => {
  const cases = [
    { name: 'cross-account', req: request('other-account') },
    { name: 'revoked enrollment', record: readyEnrollment({ revokedAt: new Date() }) },
    { name: 'archived identity', identity: currentIdentity({ archivedAt: new Date() }) },
    { name: 'mismatched identity source', identity: currentIdentity({ sourceVoiceAssetId: IDS.source }) },
    { name: 'quarantined derived voice', asset: currentVoiceAsset(readyEnrollment(), { quarantinedAt: new Date() }) },
    { name: 'wrong content-addressed path', asset: currentVoiceAsset(readyEnrollment(), { privatePathname: 'video-os/enrollment-sources/wrong/derived-' + VOICE_HASH + '.wav' }) },
    { name: 'wrong MIME type', asset: currentVoiceAsset(readyEnrollment(), { contentType: 'audio/mpeg' }) },
    { name: 'wrong duration', asset: currentVoiceAsset(readyEnrollment(), { durationMs: 5_999 }) },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let privateReads = 0;
      const record = scenario.record || readyEnrollment();
      const identity = scenario.identity || currentIdentity();
      const asset = scenario.asset || currentVoiceAsset(record);
      const handler = createEnrollmentHandler({
        sessionFromRequest: req => ({ accountId: req.accountId, email: 'owner@example.com' }),
        getOwnedEnrollment: async (accountId, enrollmentId) => (
          accountId === record.accountId && enrollmentId === record.id ? record : null
        ),
        getOwnedIdentity: async () => identity,
        getOwnedMediaAsset: async () => asset,
        getPrivateBlob: async () => {
          privateReads += 1;
          return { blob: {}, stream: Readable.from([VOICE_BYTES]) };
        },
      });
      const res = response();
      await handler(scenario.req || request(), res);
      assert.equal(res.statusCode, 404);
      assert.equal(privateReads, 0);
      assert.match(jsonBody(res).error, /unavailable|not found/i);
    });
  }
});
