import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildProviderReconsentRequest,
  ENROLLMENT_CONTRACT_VERSION,
  ENROLLMENT_POLICY_VERSION,
  ENROLLMENT_PURPOSE,
} from '../public/enrollment-client.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const PHOTO_HASH = 'a'.repeat(64);
const VIDEO_HASH = 'b'.repeat(64);
const VOICE_HASH = 'c'.repeat(64);

function readyLegacyEnrollment(overrides = {}) {
  return {
    id: '0d566634-5887-4b5d-b1a0-51f2137da97d',
    status: 'IDENTITY_READY',
    stateVersion: 7,
    displayName: 'Owner Studio',
    photo: { sha256: PHOTO_HASH, previewUrl: '/api/video-os-lite/asset?assetId=owned' },
    sourceVideo: { sha256: VIDEO_HASH, previewUrl: '/api/video-os-lite/enrollments?enrollmentId=owned&preview=video' },
    derivedAudio: { sha256: VOICE_HASH },
    identity: { id: '4eb35c45-8427-4237-b098-d5485b8b7808' },
    providerBridgeConsent: {
      required: true,
      status: 'missing',
      policyVersion: ENROLLMENT_POLICY_VERSION,
      temporaryPublicProviderExposureAuthorized: false,
      reconsentAvailable: true,
    },
    ...overrides,
  };
}

test('ready-only provider reconsent request is exact, hash-bound, and file-free', () => {
  const enrollment = readyLegacyEnrollment({
    providerUrl: 'https://provider.example/raw-source',
    providerLifecycle: { state: 'needs_attention', blockers: ['SAFE_CODE'] },
  });
  const request = buildProviderReconsentRequest(enrollment, '22222222-2222-4222-8222-222222222222');

  assert.deepEqual(request, {
    action: 'provider-reconsent',
    contractVersion: ENROLLMENT_CONTRACT_VERSION,
    enrollmentId: enrollment.id,
    identityId: enrollment.identity.id,
    expectedStateVersion: 7,
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    policyVersion: 'identity-provider-bridge-v2',
    purpose: ENROLLMENT_PURPOSE,
    sourcePhotoSha256: PHOTO_HASH,
    sourceVideoSha256: VIDEO_HASH,
    derivedVoiceSha256: VOICE_HASH,
    audioExtractionAuthorization: true,
    faceAuthorization: true,
    voiceAuthorization: true,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  });
  const serialized = JSON.stringify(request);
  for (const forbidden of ['previewUrl', 'providerUrl', 'providerLifecycle', 'blockers', 'File', 'Blob']) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

test('provider reconsent fails closed without a ready owned source set', () => {
  const key = '22222222-2222-4222-8222-222222222222';
  assert.throws(() => buildProviderReconsentRequest(readyLegacyEnrollment({ status: 'EXTRACTING' }), key), /unavailable/);
  assert.throws(() => buildProviderReconsentRequest(readyLegacyEnrollment({ derivedAudio: {} }), key), /original owned identity sources/);
  assert.throws(() => buildProviderReconsentRequest(readyLegacyEnrollment({ providerBridgeConsent: { status: 'missing', reconsentAvailable: false } }), key), /unavailable/);
});

test('public consent UI keeps disclosure and provider lifecycle language truthful and redacted', async () => {
  const [html, identityClient] = await Promise.all([read('public/identity.html'), read('public/identity.js')]);
  assert.match(html, /temporary copies of your approved photo and prepared voice file/i);
  assert.match(html, /anyone with the link can access/i);
  assert.match(html, /does not certify deletion from provider backups/i);
  for (const label of ['Preparing presenter', 'Removing temporary provider files', 'Ready', 'Removal requested', 'Needs attention']) {
    assert.match(identityClient, new RegExp(label));
  }
  assert.doesNotMatch(`${html}\n${identityClient}`, /deleted everywhere|backup(?:s)? (?:are )?purged/i);
  assert.doesNotMatch(identityClient, /providerLifecycle\.blockers|providerAssetId|providerAccountFingerprint|evidenceObjectReference/);
});

test('reconsent is a separate readback-verified action and browser resume remains identifier-only', async () => {
  const [identityClient, enrollmentClient] = await Promise.all([read('public/identity.js'), read('public/enrollment-client.js')]);
  assert.match(identityClient, /buildProviderReconsentRequest\(enrollment, requestKey\)/);
  assert.match(identityClient, /readBackProviderReconsent\(enrollment\.id\)/);
  assert.match(identityClient, /No provider upload was started/);
  const persisted = enrollmentClient.slice(enrollmentClient.indexOf('export function writeEnrollmentResume'), enrollmentClient.indexOf('export function clearEnrollmentResume'));
  assert.doesNotMatch(persisted, /sourcePhotoSha256|sourceVideoSha256|derivedVoiceSha256|providerUrl|previewUrl|consent payload/i);
  for (const key of ['enrollmentId', 'createIdempotencyKey', 'consentIdempotencyKey', 'retryIdempotencyKey', 'revokeIdempotencyKey']) {
    assert.match(persisted, new RegExp(key));
  }
});
