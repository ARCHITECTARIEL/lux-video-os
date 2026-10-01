import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const account = { ok: true, signedIn: true, email: 'owner@example.com', account: { accountId: 'owner-a', name: 'Owner' } };
const IDS = {
  enrollment: '0d566634-5887-4b5d-b1a0-51f2137da97d',
  identity: '4eb35c45-8427-4237-b098-d5485b8b7808',
  photo: '9ba00bd4-81b7-40ad-a28b-b625c33242e3',
  createKey: '11111111-1111-4111-8111-111111111111',
  consentKey: '22222222-2222-4222-8222-222222222222',
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const PHOTO_HASH = 'c'.repeat(64);
const VOICE_HASH = 'd'.repeat(64);
const phoneVideo = await readFile(new URL('../../public/assets/showcase/example-faq.mp4', import.meta.url));
const photo = { name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 1]) };
const video = { name: 'phone-video.mp4', mimeType: 'video/mp4', buffer: phoneVideo };

const draft = {
  id: IDS.identity, displayName: 'Owner Studio', overallStatus: 'DRAFT', avatarStatus: 'DRAFT', voiceStatus: 'DRAFT',
  portraitUrl: '/portrait.png', voicePreviewUrl: null, createdAt: '2026-07-17T12:00:00.000Z', updatedAt: '2026-07-17T12:00:00.000Z', archivedAt: null, ready: false,
};

function enrollment(status = 'AWAITING_UPLOAD', overrides = {}) {
  const hashed = !['AWAITING_UPLOAD', 'SOURCE_HASHING'].includes(status);
  const bridgeConsented = !['AWAITING_UPLOAD', 'SOURCE_HASHING', 'AWAITING_EXTRACTION_CONSENT'].includes(status);
  return {
    id: IDS.enrollment,
    displayName: 'Owner Studio',
    status,
    stateVersion: overrides.stateVersion || 1,
    photo: { assetId: IDS.photo, sha256: PHOTO_HASH, previewUrl: `/api/video-os-lite/asset?assetId=${IDS.photo}` },
    sourceVideo: {
      state: status === 'AWAITING_UPLOAD' ? 'AWAITING_UPLOAD' : status === 'SOURCE_HASHING' ? 'HASHING' : 'VERIFIED',
      sha256: hashed ? (overrides.sourceHash || HASH_A) : null,
      bytes: phoneVideo.length,
      contentType: 'video/mp4',
      filename: 'phone-video.mp4',
      previewUrl: hashed ? `/api/video-os-lite/enrollments?enrollmentId=${IDS.enrollment}&preview=video` : null,
    },
    derivedAudio: { state: status === 'IDENTITY_READY' ? 'READY' : ['EXTRACTION_QUEUED', 'EXTRACTING'].includes(status) ? status : 'PENDING', ...(status === 'IDENTITY_READY' ? { sha256: VOICE_HASH } : {}) },
    consent: { required: status === 'AWAITING_EXTRACTION_CONSENT', status: status === 'AWAITING_EXTRACTION_CONSENT' ? 'MISSING' : 'PENDING', policyVersion: 'identity-provider-bridge-v2', purpose: 'identity-voice-enrollment' },
    providerBridgeConsent: {
      required: true,
      status: bridgeConsented ? 'active' : 'missing',
      policyVersion: 'identity-provider-bridge-v2',
      temporaryPublicProviderExposureAuthorized: bridgeConsented,
      reconsentAvailable: false,
    },
    providerLifecycle: { state: 'not_started', blockers: [] },
    identity: status === 'IDENTITY_READY' ? { ...draft } : null,
    failure: status === 'FAILED' ? { code: 'EXTRACTION_FAILED', message: 'Extraction needs attention.', retryable: true } : null,
    retry: ['AWAITING_UPLOAD', 'FAILED'].includes(status) ? { allowed: true, action: status === 'AWAITING_UPLOAD' ? 'upload-instructions' : 'retry' } : null,
    ...overrides,
  };
}

function uploadInstruction() {
  return {
    pathname: `video-os/enrollments/${IDS.enrollment}/source.mp4`,
    handleUploadUrl: '/api/video-os-lite/enrollment-upload',
    clientPayload: 'opaque-test-context',
    access: 'private',
    multipart: true,
    maximumSizeInBytes: 100 * 1024 * 1024,
    allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

async function mockApp(page, {
  providerEnabled = false,
  enrollmentEnabled = true,
  initialIdentities = [],
  initialEnrollment = null,
  autoAdvance = false,
  failUploadOnce = false,
  swapHashOnConsent = false,
  callbackAdvanceOnReconcile = false,
  reconsentAbortAfterCommit = false,
} = {}) {
  let identities = [...initialIdentities];
  let currentEnrollment = initialEnrollment;
  let enrollmentReads = 0;
  let reconcileConflicted = false;
  let reconsentAborted = false;
  const calls = [];

  await page.addInitScript(value => { window.__failEnrollmentUploadOnce = value; window.__blobUploadCalls = []; }, failUploadOnce);
  await page.route('**/vendor/vercel-blob-client.js', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `export async function upload(pathname, file, options) {
      window.__blobUploadCalls.push({ pathname, size: file.size, access: options.access, multipart: options.multipart, handleUploadUrl: options.handleUploadUrl, clientPayload: options.clientPayload });
      options.onUploadProgress?.({ percentage: 35 });
      if (window.__failEnrollmentUploadOnce && sessionStorage.getItem('enrollment-upload-failed') !== '1') {
        sessionStorage.setItem('enrollment-upload-failed', '1');
        throw Object.assign(new Error('Private upload interrupted.'), { code: 'network_unavailable' });
      }
      options.onUploadProgress?.({ percentage: 100 });
      return { pathname };
    }`,
  }));
  await page.route('**/api/video-os-lite/session', route => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/uploads', async route => {
    const body = route.request().postDataJSON();
    calls.push({ endpoint: 'uploads', body, requestId: route.request().headers()['x-request-id'] });
    await route.fulfill({ status: 201, json: { ok: true, assetId: IDS.photo, previewUrl: '/private-asset' } });
  });
  await page.route('**/api/video-os-lite/identities*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, identities, providerSubmissionEnabled: providerEnabled } });
    const body = route.request().postDataJSON();
    calls.push({ endpoint: 'identities', body });
    if (body.action === 'retry') identities = identities.map(item => ({ ...item, overallStatus: 'PROCESSING', [`${body.component}Status`]: 'PROCESSING', [`${body.component}Failure`]: null }));
    if (body.action === 'refresh') identities = identities.map(item => ({ ...item, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, voicePreviewUrl: `/api/video-os-lite/identities?voicePreview=${item.id}` }));
    if (body.action === 'archive') identities = identities.filter(item => item.id !== body.identityId);
    if (body.action === 'submit') identities = identities.map(item => item.id === body.identityId ? { ...item, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING', voiceStatus: 'PROCESSING' } : item);
    return route.fulfill({ json: { ok: true, identity: identities.find(item => item.id === body.identityId) || draft } });
  });
  await page.route('**/api/video-os-lite/enrollments*', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') {
      if (url.searchParams.has('enrollmentId') && currentEnrollment && autoAdvance) {
        enrollmentReads += 1;
        if (currentEnrollment.status === 'SOURCE_HASHING') currentEnrollment = enrollment('AWAITING_EXTRACTION_CONSENT', { stateVersion: currentEnrollment.stateVersion + 1 });
        else if (currentEnrollment.status === 'EXTRACTION_QUEUED') currentEnrollment = enrollment('EXTRACTING', { stateVersion: currentEnrollment.stateVersion + 1 });
        else if (currentEnrollment.status === 'EXTRACTING') {
          currentEnrollment = enrollment('IDENTITY_READY', { stateVersion: currentEnrollment.stateVersion + 1 });
          identities = [{ ...draft, displayName: currentEnrollment.displayName }];
        }
      }
      if (url.searchParams.has('enrollmentId')) return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
      return route.fulfill({ json: {
        ok: true, enabled: enrollmentEnabled, extractionEnabled: enrollmentEnabled,
        limits: { sourceVideo: { maximumSizeInBytes: 104857600, minimumDurationSeconds: 5, maximumDurationSeconds: 60, maximumDimensionPx: 4096, allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'] } },
        enrollments: currentEnrollment ? [currentEnrollment] : [],
      } });
    }
    const body = route.request().postDataJSON();
    calls.push({ endpoint: 'enrollments', body });
    if (body.action === 'create') {
      currentEnrollment ||= enrollment('AWAITING_UPLOAD', { displayName: body.displayName });
      return route.fulfill({ status: 201, json: { ok: true, enrollment: currentEnrollment, upload: uploadInstruction() } });
    }
    if (body.action === 'upload-instructions') return route.fulfill({ json: { ok: true, enrollment: currentEnrollment, upload: uploadInstruction() } });
    if (body.action === 'retry') return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
    if (body.action === 'reconcile-upload') {
      currentEnrollment = enrollment('SOURCE_HASHING', { stateVersion: currentEnrollment.stateVersion + 1, displayName: currentEnrollment.displayName });
      if (callbackAdvanceOnReconcile && !reconcileConflicted) {
        reconcileConflicted = true;
        return route.fulfill({ status: 409, json: { ok: false, code: 'RECONCILIATION', error: 'Enrollment state changed.' } });
      }
      return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
    }
    if (body.action === 'consent') {
      if (swapHashOnConsent) {
        currentEnrollment = enrollment('AWAITING_EXTRACTION_CONSENT', { stateVersion: currentEnrollment.stateVersion + 1, sourceHash: HASH_B, displayName: currentEnrollment.displayName });
        return route.fulfill({ status: 409, json: { ok: false, code: 'source_binding_changed', error: 'The verified source changed.' } });
      }
      currentEnrollment = enrollment('EXTRACTION_QUEUED', { stateVersion: currentEnrollment.stateVersion + 1, displayName: currentEnrollment.displayName });
      return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
    }
    if (body.action === 'provider-reconsent') {
      currentEnrollment = {
        ...currentEnrollment,
        stateVersion: currentEnrollment.stateVersion + 1,
        providerBridgeConsent: {
          required: true,
          status: 'active',
          policyVersion: 'identity-provider-bridge-v2',
          temporaryPublicProviderExposureAuthorized: true,
          reconsentAvailable: false,
        },
      };
      if (reconsentAbortAfterCommit && !reconsentAborted) {
        reconsentAborted = true;
        return route.abort('connectionfailed');
      }
      return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
    }
    if (body.action === 'revoke') {
      currentEnrollment = enrollment('REVOKED', { stateVersion: currentEnrollment.stateVersion + 1, displayName: currentEnrollment.displayName });
      return route.fulfill({ json: { ok: true, enrollment: currentEnrollment } });
    }
    return route.fulfill({ status: 400, json: { ok: false, error: 'Unexpected action.' } });
  });
  await page.route('**/portrait.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from([137, 80, 78, 71]) }));
  return { calls, identities: () => identities, enrollment: () => currentEnrollment, enrollmentReads: () => enrollmentReads };
}

async function openToVideo(page) {
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.locator('#photo-input').setInputFiles(photo);
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await expect(page.locator('[data-panel="2"] legend')).toHaveText('Your Phone Video');
}

async function chooseVideo(page) {
  await page.locator('#video-input').setInputFiles(video);
  await expect(page.locator('#video-metadata')).toContainText('seconds');
  await page.getByRole('button', { name: 'Use this video' }).click();
}

async function openToConsent(page) {
  await openToVideo(page);
  await chooseVideo(page);
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
}

async function checkAllConsents(page) {
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure']) await page.locator(`#${id}`).check();
}

test('Identity Studio requires the existing authenticated workspace session', async ({ page }) => {
  await page.route('**/api/video-os-lite/session', route => route.fulfill({ status: 401, json: { ok: false, error: 'Sign in to render videos.' } }));
  await page.goto('/identity.html');
  await expect(page.getByRole('heading', { name: 'Sign in to open your Identity Studio.' })).toBeVisible();
});

test('desktop and mobile keep five explicit steps with compact phone progress', async ({ page }) => {
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await expect(page.locator('.steps')).toBeVisible();
  await expect(page.locator('.steps li')).toHaveText(['1Your Photo', '2Your Video', '3Consent', '4Creating', '5Ready']);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.steps')).toBeHidden();
  await expect(page.locator('#compact-step-label')).toHaveText('1 of 5: Photo');
  const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogWidth: document.querySelector('#wizard').scrollWidth }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.dialogWidth).toBeLessThanOrEqual(layout.viewport + 1);
});

test('camera and microphone permission is requested only on Record and denial exposes native/file fallbacks', async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { window.__mediaCalls += 1; throw new DOMException('Denied', 'NotAllowedError'); } } });
  });
  await mockApp(page);
  await openToVideo(page);
  expect(await page.evaluate(() => window.__mediaCalls)).toBe(0);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect.poll(() => page.evaluate(() => window.__mediaCalls)).toBe(1);
  await expect(page.locator('#video-error')).toContainText('not granted');
  await expect(page.locator('#native-capture-label')).toBeVisible();
  await expect(page.getByText('Choose existing video')).toBeVisible();
});

test('a late permission result after closing is discarded and its tracks stop', async ({ page }) => {
  await page.addInitScript(() => {
    window.__trackStopped = false;
    window.__mediaCalls = 0;
    const track = { stop: () => { window.__trackStopped = true; } };
    window.__lateStream = { getTracks: () => [track] };
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    window.__resolveMedia = () => resolve(window.__lateStream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { window.__mediaCalls += 1; return pending; } } });
  });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#close-wizard').click();
  await page.evaluate(() => window.__resolveMedia());
  await expect.poll(() => page.evaluate(() => window.__trackStopped)).toBe(true);
  await expect(page.locator('#wizard')).toBeHidden();
});

test('invalid replacement and dismissed Retake preserve the valid video', async ({ page }) => {
  await mockApp(page);
  await openToVideo(page);
  await chooseVideo(page);
  const originalMetadata = await page.locator('#video-metadata').textContent();
  await page.locator('#video-input').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not-video') });
  await expect(page.locator('#video-error')).toContainText('previous valid video was kept');
  await expect(page.locator('#video-metadata')).toHaveText(originalMetadata);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(page.locator('#video-preview')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(page.locator('#video-placeholder')).toBeVisible();
});

test('two captures and six unchecked consents create a v2 hash-bound enrollment without provider creation', async ({ page }) => {
  const mock = await mockApp(page, { providerEnabled: false, autoAdvance: true, callbackAdvanceOnReconcile: true });
  await openToConsent(page);
  await page.locator('#identity-name').fill('Owner Studio');
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive']) await page.locator(`#${id}`).check();
  await page.locator('#next-button').click();
  await expect(page.locator('#consent-error')).toContainText('All six authorizations are required.');
  expect(mock.calls.some(call => call.endpoint === 'enrollments')).toBe(false);
  await page.locator('#consent-provider-exposure').check();
  await page.locator('#next-button').click();
  await expect(page.getByRole('heading', { name: 'Enrollment is ready.' })).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#ready-use-link')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#ready-copy')).toContainText('Final presenter creation has not started');

  const create = mock.calls.find(call => call.endpoint === 'enrollments' && call.body.action === 'create').body;
  expect(Object.keys(create).sort()).toEqual(['action', 'bytes', 'contentType', 'contractVersion', 'displayName', 'filename', 'idempotencyKey', 'photoAssetId'].sort());
  const consent = mock.calls.find(call => call.endpoint === 'enrollments' && call.body.action === 'consent').body;
  expect(consent).toMatchObject({
    contractVersion: 'identity-phone-video-v1', policyVersion: 'identity-provider-bridge-v2', purpose: 'identity-voice-enrollment',
    sourceVideoSha256: HASH_A, audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
    providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true, temporaryPublicProviderExposureAuthorization: true,
  });
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'submit')).toBe(false);
  expect(await page.evaluate(() => window.__blobUploadCalls[0])).toMatchObject({ access: 'private', multipart: true, handleUploadUrl: '/api/video-os-lite/enrollment-upload', clientPayload: 'opaque-test-context' });
  await page.getByRole('button', { name: 'Back to My identities' }).click();
  await expect(page.getByRole('button', { name: 'Start creation' })).toBeDisabled();
});

test('failed direct upload persists only resume metadata and resumes after reload with the original video reselected', async ({ page }) => {
  await mockApp(page, { autoAdvance: true, failUploadOnce: true });
  await openToConsent(page);
  await page.locator('#identity-name').fill('Resume Owner');
  await checkAllConsents(page);
  await page.locator('#next-button').click();
  await expect(page.locator('#enrollment-recovery-message')).toContainText('Private upload interrupted');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('luxVideoOsEnrollmentResumeV1:owner-a')));
  expect(Object.keys(stored).sort()).toEqual(['consentIdempotencyKey', 'createIdempotencyKey', 'enrollmentId', 'retryIdempotencyKey', 'revokeIdempotencyKey'].sort());
  expect(JSON.stringify(stored)).not.toContain('opaque-test-context');
  await page.reload();
  await expect(page.locator('#enrollment-resume')).toBeVisible();
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await expect(page.locator('#compact-step-label')).toContainText('Video');
  await chooseVideo(page);
  await page.locator('#next-button').click();
  await checkAllConsents(page);
  await page.locator('#next-button').click();
  await expect(page.getByRole('heading', { name: 'Enrollment is ready.' })).toBeVisible({ timeout: 12_000 });
  expect(await page.evaluate(() => localStorage.getItem('luxVideoOsEnrollmentResumeV1:owner-a'))).toBeNull();
});

test('a server-side source hash change clears every consent before retry', async ({ page }) => {
  const initial = enrollment('AWAITING_EXTRACTION_CONSENT', { sourceHash: HASH_A, stateVersion: 4 });
  await page.addInitScript(({ id }) => localStorage.setItem('luxVideoOsEnrollmentResumeV1:owner-a', JSON.stringify({
    enrollmentId: id, createIdempotencyKey: '11111111-1111-4111-8111-111111111111', consentIdempotencyKey: null, retryIdempotencyKey: null, revokeIdempotencyKey: null,
  })), { id: IDS.enrollment });
  await mockApp(page, { initialEnrollment: initial, swapHashOnConsent: true });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await checkAllConsents(page);
  await page.locator('#next-button').click();
  await expect(page.locator('#enrollment-recovery')).toBeVisible();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure']) await expect(page.locator(`#${id}`)).not.toBeChecked();
  await expect(page.locator('#wizard-status')).toContainText('Review and confirm every permission');
});

test('legacy consent reuses owned sources for v2 reconsent without rerecording or provider upload', async ({ page }) => {
  const legacyEnrollment = enrollment('IDENTITY_READY', {
    stateVersion: 9,
    consent: { required: false, status: 'active', policyVersion: 'identity-video-audio-extraction-v1', purpose: 'identity-voice-enrollment' },
    providerBridgeConsent: {
      required: true,
      status: 'missing',
      policyVersion: 'identity-provider-bridge-v2',
      temporaryPublicProviderExposureAuthorized: false,
      reconsentAvailable: true,
    },
  });
  const mock = await mockApp(page, { providerEnabled: true, initialIdentities: [{ ...draft }], initialEnrollment: legacyEnrollment });
  await page.goto('/identity.html');

  await expect(page.getByRole('button', { name: 'Start creation' })).toBeDisabled();
  await page.getByRole('button', { name: 'Review provider consent' }).click();
  await expect(page.getByRole('heading', { name: 'Review provider consent' })).toBeVisible();
  await expect(page.locator('#provider-reconsent-note')).toContainText('without another recording');
  await expect(page.locator('#identity-name')).toHaveAttribute('readonly', '');
  await expect(page.locator('#consent-photo-preview')).toHaveAttribute('src', new RegExp('^/api/video-os-lite/asset'));
  await expect(page.locator('#consent-video-preview')).toHaveAttribute('src', new RegExp('^/api/video-os-lite/enrollments'));
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure']) {
    await expect(page.locator(`#${id}`)).not.toBeChecked();
  }
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive']) await page.locator(`#${id}`).check();
  await page.getByRole('button', { name: 'Save updated consent' }).click();
  await expect(page.locator('#consent-error')).toContainText('All six authorizations are required.');
  expect(mock.calls.some(call => call.endpoint === 'enrollments' && call.body.action === 'provider-reconsent')).toBe(false);

  await page.locator('#consent-provider-exposure').check();
  await page.getByRole('button', { name: 'Save updated consent' }).click();
  await expect(page.locator('#wizard')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('No provider upload was started.');
  const request = mock.calls.find(call => call.endpoint === 'enrollments' && call.body.action === 'provider-reconsent').body;
  expect(request).toMatchObject({
    action: 'provider-reconsent',
    contractVersion: 'identity-phone-video-v1',
    enrollmentId: IDS.enrollment,
    identityId: IDS.identity,
    expectedStateVersion: 9,
    policyVersion: 'identity-provider-bridge-v2',
    purpose: 'identity-voice-enrollment',
    sourcePhotoSha256: PHOTO_HASH,
    sourceVideoSha256: HASH_A,
    derivedVoiceSha256: VOICE_HASH,
    audioExtractionAuthorization: true,
    faceAuthorization: true,
    voiceAuthorization: true,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  });
  expect(Object.keys(request).sort()).toEqual([
    'action', 'archiveDeleteAcknowledgment', 'audioExtractionAuthorization', 'contractVersion', 'derivedVoiceSha256',
    'expectedStateVersion', 'faceAuthorization', 'idempotencyKey', 'identityId', 'enrollmentId', 'policyVersion',
    'providerProcessingAuthorization', 'purpose', 'sourcePhotoSha256', 'sourceVideoSha256',
    'temporaryPublicProviderExposureAuthorization', 'voiceAuthorization',
  ].sort());
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'submit')).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('luxVideoOsEnrollmentResumeV1:owner-a'))).toBeNull();
  expect(await page.evaluate(() => window.__blobUploadCalls.length)).toBe(0);
});

test('uncertain reconsent performs a mandatory DTO readback without a duplicate submission', async ({ page }) => {
  const legacyEnrollment = enrollment('IDENTITY_READY', {
    stateVersion: 11,
    providerBridgeConsent: {
      required: true,
      status: 'missing',
      policyVersion: 'identity-provider-bridge-v2',
      temporaryPublicProviderExposureAuthorized: false,
      reconsentAvailable: true,
    },
  });
  const mock = await mockApp(page, {
    providerEnabled: true,
    initialIdentities: [{ ...draft }],
    initialEnrollment: legacyEnrollment,
    reconsentAbortAfterCommit: true,
  });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Review provider consent' }).click();
  await checkAllConsents(page);
  await page.getByRole('button', { name: 'Save updated consent' }).click();
  await expect(page.locator('#wizard')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('Updated provider consent is saved.');
  expect(mock.calls.filter(call => call.endpoint === 'enrollments' && call.body.action === 'provider-reconsent')).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('luxVideoOsEnrollmentResumeV1:owner-a'))).toBeNull();
});

test('provider lifecycle shows cleanup pending without exposing provider evidence', async ({ page }) => {
  const currentEnrollment = enrollment('IDENTITY_READY', {
    providerLifecycle: { state: 'temporary_sources_pending_removal', blockers: ['URL_STILL_ACCESSIBLE'] },
    providerUrl: 'https://provider.example/private-evidence-url',
    providerEvidenceHash: 'e'.repeat(64),
  });
  await mockApp(page, { providerEnabled: true, initialIdentities: [{ ...draft, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true }], initialEnrollment: currentEnrollment });
  await page.goto('/identity.html');
  await expect(page.getByText('Removing temporary provider files')).toBeVisible();
  await expect(page.getByText('Temporary provider file removal is still pending.')).toBeVisible();
  const visibleText = await page.locator('body').innerText();
  expect(visibleText).not.toContain('provider.example');
  expect(visibleText).not.toContain('URL_STILL_ACCESSIBLE');
  expect(visibleText).not.toContain('e'.repeat(64));
  expect(visibleText).not.toContain('deleted everywhere');
});

test('unavailable legacy sources keep provider creation held without offering a false reconsent path', async ({ page }) => {
  const heldEnrollment = enrollment('IDENTITY_READY', {
    providerBridgeConsent: {
      required: true,
      status: 'source_unavailable',
      policyVersion: 'identity-provider-bridge-v2',
      temporaryPublicProviderExposureAuthorized: false,
      reconsentAvailable: false,
    },
    providerLifecycle: { state: 'needs_attention', blockers: ['PREVIEW_VISIBILITY_UNQUALIFIED'] },
  });
  await mockApp(page, { providerEnabled: true, initialIdentities: [{ ...draft }], initialEnrollment: heldEnrollment });
  await page.goto('/identity.html');
  await expect(page.getByRole('button', { name: 'Start creation' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review provider consent' })).toHaveCount(0);
  await expect(page.getByText('Updated provider consent needs attention because the original owned sources are unavailable.')).toBeVisible();
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
});

test('existing provider processing still resumes to a genuinely ready identity and enabled link', async ({ page }) => {
  await page.clock.install();
  const processing = { ...draft, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING', voiceStatus: 'PROCESSING' };
  const mock = await mockApp(page, { providerEnabled: true, initialIdentities: [processing] });
  await page.goto('/identity.html');
  await expect(page.getByText('Processing').first()).toBeVisible();
  await page.clock.fastForward(8_500);
  await expect(page.getByText('Ready').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use in Video OS' })).toHaveAttribute('href', `/?identityId=${draft.id}`);
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'refresh')).toBe(true);
});

test('partial provider failure retries only the failed component and archive removes it', async ({ page }) => {
  const failed = { ...draft, overallStatus: 'PARTIAL_FAILURE', avatarStatus: 'READY', voiceStatus: 'FAILED', voiceFailure: { code: 'PROVIDER_REJECTED', message: 'This voice could not be created.' } };
  const mock = await mockApp(page, { providerEnabled: true, initialIdentities: [failed] });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Retry voice' }).click();
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'retry' && call.body.component === 'voice')).toBe(true);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'Owner Studio' })).toHaveCount(0);
});

test('wizard remains keyboard-contained and restores focus', async ({ page }) => {
  await mockApp(page);
  await page.goto('/identity.html');
  const opener = page.locator('#empty-create-button');
  await opener.click();
  await expect(page.locator('#photo-input')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#close-wizard')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wizard')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('identity loading failure offers a retry without substituting an empty workspace', async ({ page }) => {
  let identityReads = 0;
  await page.route('**/api/video-os-lite/session', route => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/enrollments*', route => route.fulfill({ json: { ok: true, enabled: true, extractionEnabled: true, limits: {}, enrollments: [] } }));
  await page.route('**/api/video-os-lite/identities*', route => {
    identityReads += 1;
    if (identityReads === 1) return route.abort('connectionfailed');
    return route.fulfill({ json: { ok: true, identities: [], providerSubmissionEnabled: false } });
  });
  await page.goto('/identity.html');
  await expect(page.locator('#load-error')).toBeVisible();
  await page.locator('#retry-load').click();
  await expect(page.locator('#studio')).toBeVisible();
  expect(identityReads).toBe(2);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'narrow phone', width: 320, height: 720 },
]) {
  test(`identity wizard avoids horizontal overflow at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockApp(page);
    await page.goto('/identity.html');
    await page.locator('#empty-create-button').click();
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('#wizard');
      const rect = dialog.getBoundingClientRect();
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right, client: dialog.clientWidth, scroll: dialog.scrollWidth };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.left).toBeGreaterThanOrEqual(-1);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.scroll).toBeLessThanOrEqual(layout.client + 1);
  });
}
