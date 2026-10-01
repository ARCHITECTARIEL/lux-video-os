import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  enrollmentResumeStorageKey,
  readEnrollmentResume,
  uploadEnrollmentVideo,
  writeEnrollmentResume,
} from '../public/enrollment-client.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Identity Studio is a separate five-step photo and phone-video experience', async () => {
  const [html, client, routes] = await Promise.all([
    read('public/identity.html'),
    read('public/identity.js'),
    read('vercel.json'),
  ]);
  assert.match(routes, /"src"\s*:\s*"\/identity"[\s\S]*?"dest"\s*:\s*"\/identity\.html"/);
  for (const label of ['Your Photo', 'Your Video', 'Consent', 'Creating', 'Ready']) assert.match(html, new RegExp(label));
  assert.match(html, /one photo and one phone video/i);
  assert.match(html, /compact-step-label/);
  assert.doesNotMatch(html, /id="voice-input"|Upload MP3 or WAV/);
  assert.match(client, /\/api\/video-os-lite\/session/);
  assert.match(client, /\/api\/video-os-lite\/identities/);
  assert.match(client, /\/api\/video-os-lite\/enrollments/);
  assert.match(client, /pollCount >= 45/);
  assert.match(html, /ready-use-link/);
  assert.doesNotMatch(html, /useIdentity/);
  assert.match(client, /readyUseLink\.href[\s\S]*encodeURIComponent\(identity\.id\)/);
});

test('phone video is one enrollment input and never a third voice upload', async () => {
  const [html, client, uploadClient] = await Promise.all([read('public/identity.html'), read('public/identity.js'), read('public/enrollment-client.js')]);
  assert.match(html, /id="video-input"[^>]+video\/mp4,video\/quicktime,video\/webm/);
  assert.match(html, /id="video-capture-input"[^>]+capture="user"/);
  assert.match(html, /id="video-preview"[^>]+controls[^>]+playsinline[^>]+preload="metadata"/);
  assert.match(client, /maximumSizeInBytes: 100 \* 1024 \* 1024/);
  assert.match(client, /minimumDurationSeconds: 5/);
  assert.match(client, /maximumDurationSeconds: 60/);
  assert.match(client, /maximumDimensionPx: 4096/);
  assert.doesNotMatch(client, /identity_voice|voiceFile|voice-input/);
  assert.match(uploadClient, /import\('\/vendor\/vercel-blob-client\.js'\)/);
  assert.match(uploadClient, /access: 'private'/);
  assert.match(uploadClient, /multipart: true/);
  assert.match(uploadClient, /handleUploadUrl: instruction\.handleUploadUrl/);
  assert.match(uploadClient, /clientPayload: instruction\.clientPayload/);
  assert.match(uploadClient, /abortSignal/);
});

test('six explicit permissions include temporary public provider exposure without auto-consent', async () => {
  const [html, client] = await Promise.all([read('public/identity.html'), read('public/identity.js')]);
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="consent-(?:face|extraction|voice|process|archive|provider-exposure)"[^>]+checked/);
  assert.match(html, /Anyone with either link can access that temporary file while the link works\./);
  assert.match(html, /stays available for future scripts until you withdraw permission/i);
  assert.match(html, /does not certify deletion from provider backups/i);
  assert.match(html, /Leaving any permission unchecked means Video OS will not upload these files to the provider\./);
  for (const field of ['audioExtractionAuthorization', 'faceAuthorization', 'voiceAuthorization', 'providerProcessingAuthorization', 'archiveDeleteAcknowledgment', 'temporaryPublicProviderExposureAuthorization']) {
    assert.match(client, new RegExp(`${field}: true`));
  }
  assert.match(client, /sourceVideoSha256: enrollment\.sourceVideo\.sha256/);
  assert.match(client, /policyVersion: ENROLLMENT_POLICY_VERSION/);
  assert.match(client, /purpose: ENROLLMENT_PURPOSE/);
  assert.match(client, /All six authorizations are required\./);
  assert.match(client, /clearConsentChecks\('The stored source video changed/);
});

test('resume storage excludes Blob instructions and media', async () => {
  const client = await read('public/enrollment-client.js');
  const persisted = client.slice(client.indexOf('export function writeEnrollmentResume'), client.indexOf('export function clearEnrollmentResume'));
  for (const key of ['enrollmentId', 'createIdempotencyKey', 'consentIdempotencyKey', 'retryIdempotencyKey', 'revokeIdempotencyKey']) assert.match(persisted, new RegExp(key));
  assert.doesNotMatch(persisted, /clientPayload|pathname|handleUploadUrl|File|Blob|videoFile|photoFile/);
  assert.match(client, /ENROLLMENT_RESUME_KEY}:\$\{encodeURIComponent\(normalized\)}/);
  assert.match(client, /authenticated account/);
});

test('resume metadata is scoped to the authenticated account', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const metadata = {
    enrollmentId: '0d566634-5887-4b5d-b1a0-51f2137da97d',
    createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
    consentIdempotencyKey: null,
    retryIdempotencyKey: null,
    revokeIdempotencyKey: null,
  };
  writeEnrollmentResume(metadata, 'account-a', storage);
  assert.deepEqual(readEnrollmentResume('account-a', storage), metadata);
  assert.equal(readEnrollmentResume('account-b', storage), null);
  assert.notEqual(enrollmentResumeStorageKey('account-a'), enrollmentResumeStorageKey('account-b'));
});

test('private video upload forwards only the server instruction and abort/progress controls', async () => {
  const instruction = {
    pathname: 'video-os/enrollments/test/source.mp4',
    handleUploadUrl: '/api/video-os-lite/enrollment-upload',
    clientPayload: 'opaque',
    access: 'private',
    multipart: true,
    maximumSizeInBytes: 10,
    allowedContentTypes: ['video/mp4'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const file = { size: 4, type: 'video/mp4' };
  const controller = new AbortController();
  const progress = [];
  let observed;
  await uploadEnrollmentVideo(instruction, file, {
    abortSignal: controller.signal,
    onUploadProgress: event => progress.push(event.percentage),
    loadSdk: async () => ({ upload: async (pathname, body, options) => {
      observed = { pathname, body, options };
      options.onUploadProgress({ percentage: 50 });
      return { pathname };
    } }),
  });
  assert.equal(observed.pathname, instruction.pathname);
  assert.equal(observed.body, file);
  assert.equal(observed.options.access, 'private');
  assert.equal(observed.options.multipart, true);
  assert.equal(observed.options.handleUploadUrl, instruction.handleUploadUrl);
  assert.equal(observed.options.clientPayload, instruction.clientPayload);
  assert.equal(observed.options.abortSignal, controller.signal);
  assert.deepEqual(progress, [50]);
});

test('identity provider submission is doubly gated and private DTOs hide provider IDs', async () => {
  const [route, service] = await Promise.all([
    read('routes/video-os-lite/identities.js'),
    read('services/heygen.js'),
  ]);
  assert.match(route, /assertIdentityProviderMutationEnabled\(\)/);
  assert.match(route, /assertIdentityProviderAccountAuthorized\(accountId\)/);
  assert.match(route, /assertHeygenConfigured\(\)/);
  assert.match(service, /VIDEO_OS_IDENTITY_PROVIDER_ENABLED/);
  assert.match(service, /HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED/);
  const dtoBody = route.slice(route.indexOf('function identityForClient'), route.indexOf('function validateName'));
  assert.doesNotMatch(dtoBody, /providerAvatar|providerVoice|providerAsset|privatePathname/);
  assert.match(route, /getOwnedIdentity\(accountId, identityId\)/);
  assert.match(route, /getOwnedMediaAsset\(accountId, assetId\)/);
});

test('composer handoff selects only an authenticated ready private identity', async () => {
  const client = await read('public/lite.js');
  const handoff = client.slice(client.indexOf('function consumeIdentitySelection'), client.indexOf('function firstCaption'));
  assert.match(handoff, /if \(!appState\.signedIn\) return/);
  assert.match(handoff, /appState\.identities\.find\(\(item\) => item\.id === identityId\)/);
  assert.match(handoff, /That private identity is unavailable for this account/);
  assert.match(handoff, /chooseIdentity\(identity, \{ forcePairedVoice: true \}\)/);
  assert.doesNotMatch(handoff, /getJson|fetch\(/);
  assert.equal((client.match(/consumeIdentitySelection\(\);/g) || []).length, 2);
});
test('hosted composer keeps local avatar compatibility separate from Identity Studio', async () => {
  const [html, client] = await Promise.all([read('public/index.html'), read('public/lite.js')]);
  // index.html is the Studio-only root entrypoint; it no longer embeds lite.js's
  // inline local-photo-avatar composer markup (`#local-photo-avatar-card`), which
  // existed only in the pre-Studio-rewrite dashboard layout. lite.js itself is
  // preserved unchanged as a historical surface (see CONTRACTS-AND-FILE-MAP.md)
  // and still defensively no-ops when that element is absent.
  assert.match(html, /href="\/identity"[^>]*>Open Identity Studio/);
  assert.match(client, /localPhotoAvatarCard\.hidden = !canUseLocalApi\(\)/);
  assert.doesNotMatch(client, /row\.innerHTML = `\<span>\$\{label\}/);
  assert.match(client, /labelElement\.textContent = label/);
  assert.match(client, /valueElement\.textContent = value/);
});

test('Kristian is the named KD upload identity and Ariel is the demo default', async () => {
  const [server, client, composer] = await Promise.all([read('lib/video-os-featured-cast.js'), read('public/video-os-cast.js'), read('public/lite.js')]);
  assert.match(server, /key: 'kd', label: 'Kristian'/);
  assert.match(client, /key: 'kd', label: 'Kristian'/);
  assert.match(composer, /selectDefaultDemoPresenter/);
  assert.match(composer, /featuredKey === 'ariel'/);
});
