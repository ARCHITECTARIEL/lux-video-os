import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
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
const photo = { name: 'portrait.png', mimeType: 'image/png', buffer: tinyPng(640, 640) };

function tinyPng(width, height) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x66)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const video = { name: 'phone-video.mp4', mimeType: 'video/mp4', buffer: phoneVideo };
const voiceSample = (() => {
  const samples = 1_600;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
})();

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
    derivedAudio: {
      state: status === 'IDENTITY_READY' ? 'READY' : ['EXTRACTION_QUEUED', 'EXTRACTING'].includes(status) ? status : 'PENDING',
      ...(status === 'IDENTITY_READY' ? {
        sha256: VOICE_HASH,
        previewUrl: '/api/video-os-lite/enrollments?enrollmentId=' + IDS.enrollment + '&preview=voice',
      } : {}),
    },
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
  failExtractedVoicePreview = false,
  swapHashOnConsent = false,
  callbackAdvanceOnReconcile = false,
  reconsentAbortAfterCommit = false,
  submitMode = 'processing',
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
      if (window.__uploadMode === 'hang') {
        window.__uploadMode = 'succeed';
        await new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('The upload was cancelled.'), { name: 'AbortError' }));
          if (options.abortSignal?.aborted) return fail();
          options.abortSignal?.addEventListener('abort', fail, { once: true });
          window.__releaseUpload = () => {
            options.onUploadProgress?.({ percentage: 100 });
            resolve();
          };
        });
        return { pathname };
      }
      if (window.__uploadMode === 'fail-once') {
        window.__uploadMode = 'succeed';
        throw Object.assign(new Error('Failed to fetch'), { name: 'TypeError' });
      }
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
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.searchParams.has('voicePreview')) {
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: voiceSample });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, identities, providerSubmissionEnabled: providerEnabled } });
    const body = route.request().postDataJSON();
    calls.push({ endpoint: 'identities', body });
    if (body.action === 'retry') identities = identities.map(item => ({ ...item, overallStatus: 'PROCESSING', [`${body.component}Status`]: 'PROCESSING', [`${body.component}Failure`]: null }));
    if (body.action === 'refresh') identities = identities.map(item => ({ ...item, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, voicePreviewUrl: `/api/video-os-lite/identities?voicePreview=${item.id}` }));
    if (body.action === 'archive') identities = identities.filter(item => item.id !== body.identityId);
    if (body.action === 'submit' && submitMode === 'held') {
      return route.fulfill({ status: 503, json: {
        ok: false,
        code: 'PROVIDER_SUBMISSION_HELD',
        error: 'Presenter creation is held before provider submission. No provider request was sent.',
      } });
    }
    if (body.action === 'submit') {
      identities = identities.map(item => item.id === body.identityId ? { ...item, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING', voiceStatus: 'PROCESSING' } : item);
      if (submitMode === 'reconciliation') {
        return route.fulfill({ status: 202, json: {
          ok: true,
          state: 'reconciliation_required',
          code: 'PROVIDER_RECONCILIATION_REQUIRED',
          message: 'Provider submission could not be confirmed. Creation is held for reconciliation; do not start it again.',
          identity: identities.find(item => item.id === body.identityId),
        } });
      }
    }
    return route.fulfill({ json: { ok: true, identity: identities.find(item => item.id === body.identityId) || draft } });
  });
  await page.route('**/api/video-os-lite/enrollments*', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET') {
      if (url.searchParams.get('preview') === 'voice') {
        if (failExtractedVoicePreview) return route.fulfill({ status: 410, json: { ok: false, error: 'Extracted voice sample is unavailable.' } });
        return route.fulfill({ status: 200, contentType: 'audio/wav', body: voiceSample });
      }
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
  await expect(page.locator('#photo-preview')).toBeVisible();
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await expect(page.locator('[data-panel="2"] legend')).toHaveText('Your Phone Video');
}

async function stageVideo(page) {
  await page.locator('#video-input').setInputFiles(video);
  await expect(page.locator('#video-metadata')).toContainText('seconds');
  await expect(page.locator('#video-check-status')).toBeHidden();
  await expect(page.locator('#video-actions')).toBeHidden();
  await expect(page.locator('#next-button')).toBeHidden();
}

async function chooseVideo(page) {
  await stageVideo(page);
  await page.getByRole('button', { name: 'Use this video' }).click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
}

async function openToConsent(page) {
  await openToVideo(page);
  await chooseVideo(page);
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
  await expect(page.locator('#next-button')).toBeVisible();
}

async function checkAllConsents(page) {
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive', 'consent-provider-exposure']) await page.locator(`#${id}`).check();
}

test('a signed-out session with an error explains that the session expired', async ({ page }) => {
  await page.route('**/api/video-os-lite/session', route => route.fulfill({
    json: { ok: true, signedIn: false, error: 'Your session expired. Sign in again.' },
  }));
  await page.goto('/identity.html');
  await expect(page.getByRole('heading', { name: 'Sign in to open your Identity Studio.' })).toBeVisible();
  await expect(page.locator('#signed-out-reason')).toHaveText('Your session expired. Sign in again.');
  await expect(page.locator('#studio')).toBeHidden();
});

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
  await expect(page.locator('#video-error')).toContainText('Camera or microphone access was denied');
  await expect(page.locator('#native-capture-label')).toBeVisible();
  await expect(page.getByText('Choose existing video')).toBeVisible();
});

async function installRecorder(page, { infiniteDuration = false } = {}) {
  await page.addInitScript(({ infiniteDuration }) => {
    window.__record = { started: 0, stopped: 0 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10);
    const track = stream.getVideoTracks()[0];
    const originalStop = track.stop.bind(track);
    track.stop = () => { window.__record.trackStopped = true; originalStop(); };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      writable: true,
      value: { getUserMedia: async () => stream },
    });
    class FakeRecorder {
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        this.onpause = null;
        this.onresume = null;
      }
      start() {
        this.state = 'recording';
        window.__record.started += 1;
      }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        window.__record.stopped += 1;
        const blob = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: this.mimeType.split(';')[0] });
        this.ondataavailable?.({ data: blob });
        this.onstop?.();
      }
      static isTypeSupported() { return true; }
    }
    window.MediaRecorder = FakeRecorder;
    if (!infiniteDuration) return;
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() { return src.get.call(this); },
      set(value) {
        src.set.call(this, value);
        if (String(value).startsWith('blob:')) {
          Object.defineProperty(this, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY });
          Object.defineProperty(this, 'videoWidth', { configurable: true, get: () => 720 });
          Object.defineProperty(this, 'videoHeight', { configurable: true, get: () => 1280 });
          queueMicrotask(() => this.onloadedmetadata?.());
        }
      },
    });
  }, { infiniteDuration });
}

test('Given a recording, When Record is pressed, Then a countdown runs, Stop waits 5 seconds, and 60 seconds stops it', async ({ page }) => {
  await page.clock.install();
  await installRecorder(page, { infiniteDuration: true });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await expect(page.locator('#teleprompter-script')).toContainText('Welcome to my Video OS.');
  await expect(page.locator('#video-live')).toBeVisible();
  const mirror = await page.locator('#video-live').evaluate(element => getComputedStyle(element).transform);
  expect(mirror).toContain('matrix');
  expect(mirror).not.toBe('none');
  await page.clock.fastForward(3_000);
  await expect(page.locator('#video-recording-state')).toBeVisible();
  await expect(page.locator('#stop-recording')).toBeDisabled();
  await expect(page.locator('#stop-hint')).toHaveText('Keep going, at least 5 seconds.');
  await expect(page.locator('#recording-time')).toBeVisible();
  await page.clock.fastForward(3_500);
  await expect(page.locator('#stop-recording')).toBeDisabled();
  await page.clock.fastForward(2_000);
  await expect(page.locator('#stop-recording')).toBeEnabled();
  await expect(page.locator('#stop-hint')).toBeHidden();
  await page.clock.fastForward(56_000);
  await expect.poll(() => page.evaluate(() => window.__record.stopped)).toBe(1);
  await expect(page.locator('#video-preview')).toBeVisible();
  await expect(page.locator('#video-check-status')).toBeHidden();
});

function boxesOverlap(a, b) {
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

async function bandLayout(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('#video-stage').getBoundingClientRect();
    const band = document.querySelector('#teleprompter').getBoundingClientRect();
    const face = document.querySelector('#face-guide').getBoundingClientRect();
    const stop = document.querySelector('#stop-recording').getBoundingClientRect();
    const script = document.querySelector('#teleprompter-script');
    const scriptStyle = getComputedStyle(script);
    const bandStyle = getComputedStyle(document.querySelector('#teleprompter'));
    return {
      stage: { top: stage.top, right: stage.right, bottom: stage.bottom, left: stage.left, width: stage.width, height: stage.height },
      band: { top: band.top, right: band.right, bottom: band.bottom, left: band.left, height: band.height },
      face: { top: face.top, right: face.right, bottom: face.bottom, left: face.left },
      stop: { top: stop.top, right: stop.right, bottom: stop.bottom, left: stop.left, width: stop.width, height: stop.height },
      color: scriptStyle.color,
      background: bandStyle.backgroundColor,
      backgroundImage: bandStyle.backgroundImage,
      textShadow: scriptStyle.textShadow,
      backdrop: bandStyle.backdropFilter || bandStyle.webkitBackdropFilter,
      position: bandStyle.position,
      transition: scriptStyle.transitionDuration,
      motion: script.dataset.motion,
      text: script.textContent,
    };
  });
}

function gradientStops(backgroundImage) {
  const stops = [...backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map(match => match[1].split(',').map(part => Number(part.trim())));
  return stops.filter(stop => stop.length >= 3 && stop.every(Number.isFinite));
}

test('Given the camera is open, When the script band is showing, Then it stays inside the stage and off the face', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await installRecorder(page, { infiniteDuration: true });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await page.clock.fastForward(3_000);
  await expect(page.locator('#teleprompter')).toBeVisible();
  await expect(page.locator('#face-guide')).toBeVisible();
  const before = await page.locator('#teleprompter-script').textContent();
  await page.clock.fastForward(3_500);
  await page.clock.fastForward(2_000);
  await page.clock.fastForward(4_000);
  const stepped = await bandLayout(page);
  const timer = await page.locator('#recording-time').textContent();
  expect(stepped.transition === '0s' || stepped.transition.startsWith('0s')).toBe(true);
  expect(stepped.motion).toBe('instant');
  expect(stepped.text).toContain('natural speaking voice');
  expect(stepped.text).not.toBe(before);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 375, height: 667 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await bandLayout(page);
    expect(layout.position).toBe('absolute');
    expect(layout.band.top).toBeGreaterThanOrEqual(layout.stage.top - 1);
    expect(layout.band.left).toBeGreaterThanOrEqual(layout.stage.left - 1);
    expect(layout.band.right).toBeLessThanOrEqual(layout.stage.right + 1);
    expect(layout.band.bottom).toBeLessThanOrEqual(layout.stage.top + (layout.stage.height * 0.13) + 2);
    expect(layout.band.bottom).toBeLessThanOrEqual(layout.face.top + 0.5);
    expect(boxesOverlap(layout.band, layout.face)).toBe(false);
    expect(boxesOverlap(layout.band, layout.stop)).toBe(false);
    const scrim = gradientStops(layout.backgroundImage);
    expect(layout.backgroundImage).toMatch(/linear-gradient/i);
    expect(layout.background).not.toMatch(/rgba?\(\s*8\s*,\s*12\s*,\s*20/i);
    expect(layout.backgroundImage).not.toMatch(/rgba?\(\s*8\s*,\s*12\s*,\s*20/i);
    const solidAlpha = layout.background.match(/[\d.]+/g)?.map(Number).at(-1);
    expect(solidAlpha === undefined ? 0 : solidAlpha).toBeLessThan(0.2);
    expect(scrim.length).toBeGreaterThanOrEqual(2);
    expect(scrim[0][3] ?? 1).toBeGreaterThan(0.4);
    expect(scrim[0][3] ?? 1).toBeLessThan(0.7);
    expect(scrim.at(-1)[3] ?? 1).toBeLessThan(0.05);
    expect(layout.textShadow).not.toBe('none');
    expect(layout.backdrop).toMatch(/blur/i);
    const contrast = await page.evaluate(({ color, stop }) => {
      const parse = value => value.match(/[\d.]+/g).map(Number);
      const channel = value => {
        const scaled = value / 255;
        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      const lum = ([r, g, b]) => (0.2126 * channel(r)) + (0.7152 * channel(g)) + (0.0722 * channel(b));
      const ink = parse(color);
      const alpha = stop[3] === undefined ? 1 : stop[3];
      const over = light => stop.slice(0, 3).map((part, index) => (part * alpha) + (light[index] * (1 - alpha)));
      const ratio = backgroundColor => {
        const hi = Math.max(lum(ink), lum(backgroundColor));
        const lo = Math.min(lum(ink), lum(backgroundColor));
        return (hi + 0.05) / (lo + 0.05);
      };
      return Math.min(ratio(over([255, 255, 255])), ratio(over([0, 0, 0])));
    }, { color: layout.color, stop: scrim[0] });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const dark = await bandLayout(page);
  const darkStops = gradientStops(dark.backgroundImage);
  expect(dark.color).toBe('rgb(255, 255, 255)');
  expect(darkStops.at(-1)[3] ?? 1).toBeLessThan(0.05);
  expect(dark.band.bottom).toBeLessThanOrEqual(dark.face.top + 0.5);
  const safeArea = await page.evaluate(() => {
    const found = [];
    const visit = rules => {
      for (const rule of rules) {
        if (rule.selectorText?.split(',').map(part => part.trim()).includes('.teleprompter')) {
          found.push({ media: rule.parentRule?.conditionText || '', padding: rule.style.padding, paddingTop: rule.style.paddingTop });
        }
        if (rule.cssRules) visit([...rule.cssRules]);
      }
    };
    for (const sheet of document.styleSheets) {
      try { visit([...sheet.cssRules]); } catch { /* a cross-origin sheet has no readable rules */ }
    }
    return found;
  });
  const baseBand = safeArea.find(rule => rule.padding && !rule.media.includes('719'));
  const bleedBand = safeArea.find(rule => rule.media.includes('719') && rule.paddingTop.includes('safe-area-inset-top'));
  expect(baseBand?.padding || '').not.toContain('safe-area');
  expect(bleedBand?.paddingTop || '').toContain('safe-area-inset-top');
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.clock.fastForward(80);
  await expect(page.locator('#teleprompter')).toBeHidden();
  await expect(page.locator('#video-preview')).toBeVisible();
});

async function soilTeleprompter(page) {
  await page.getByRole('button', { name: 'Pause script' }).click();
  await expect(page.getByRole('button', { name: 'Resume script' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const band = document.querySelector('#teleprompter');
    const script = document.querySelector('#teleprompter-script');
    band.style.overflow = 'auto';
    script.style.overflow = 'auto';
    script.style.maxHeight = '8px';
    script.textContent = 'with clear pacing\nand steady volume.';
    script.dataset.line = '3';
    band.scrollTop = 24;
    script.scrollTop = 18;
  });
}

async function expectFreshTeleprompter(page) {
  const fresh = await page.evaluate(() => {
    const script = document.querySelector('#teleprompter-script');
    return {
      text: script.textContent,
      line: script.dataset.line,
      bandScroll: document.querySelector('#teleprompter').scrollTop,
      scriptScroll: script.scrollTop,
      pressed: document.querySelector('#pause-script').getAttribute('aria-pressed'),
      label: document.querySelector('#pause-script').textContent,
    };
  });
  expect(fresh.text).toContain('Welcome to my Video OS.');
  expect(fresh.text).not.toContain('steady volume');
  expect(fresh.line).toBe('0');
  expect(fresh.bandScroll).toBe(0);
  expect(fresh.scriptScroll).toBe(0);
  expect(fresh.pressed).toBe('false');
  expect(fresh.label).toBe('Pause script');
}

test('Given a paused script, When Retake or Back cancels the take, Then the next clip starts at the beginning', async ({ page }) => {
  await page.clock.install();
  await installRecorder(page, { infiniteDuration: true });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await soilTeleprompter(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await expectFreshTeleprompter(page);
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await page.getByRole('button', { name: 'Record video' }).click();
  await page.clock.fastForward(3_000);
  await page.clock.fastForward(3_500);
  await page.clock.fastForward(2_000);
  await page.clock.fastForward(4_000);
  await expect(page.locator('#teleprompter-script')).toContainText('natural speaking voice');
  await expect(page.locator('#recording-time')).toHaveText(/Recording 0:0\d/);
  await soilTeleprompter(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.clock.fastForward(80);
  await expect(page.locator('#video-preview')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Retake' }).click();
  await expectFreshTeleprompter(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await expectFreshTeleprompter(page);
  await page.clock.fastForward(3_000);
  await expect(page.locator('#recording-time')).toHaveText(/Recording 0:0[0-1]/);
  await soilTeleprompter(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await expectFreshTeleprompter(page);
});

test('Given a recording in progress, When Back is tapped, Then Record and Choose existing video return', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.__streams = [];
    window.__liveTracks = () => window.__streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length;
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 16, 16);
    class FakeRecorder {
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'video/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
      }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/webm' }) });
        this.onstop?.();
      }
      static isTypeSupported() { return true; }
    }
    window.MediaRecorder = FakeRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const base = canvas.captureStream(5);
          const stream = new MediaStream([base.getVideoTracks()[0], base.getVideoTracks()[0].clone()]);
          window.__streams.push(stream);
          return stream;
        },
      },
    });
  });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await page.clock.fastForward(3_000);
  await expect(page.locator('#video-recording-state')).toBeVisible();
  await expect(page.locator('#video-actions')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(2);
  await page.clock.fastForward(3_500);
  await page.clock.fastForward(2_000);
  await expect(page.locator('#recording-time')).not.toHaveText('Recording 0:00');
  await soilTeleprompter(page);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(0);
  await expectFreshTeleprompter(page);
  await expect(page.locator('#recording-time')).toHaveText('Recording 0:00');
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await expect(page.locator('#video-actions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record video' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record video' })).toBeEnabled();
  await expect(page.getByText('Choose existing video')).toBeVisible();
  await expect(page.locator('#video-recording-state')).toBeHidden();
  await expect(page.locator('#video-placeholder')).toBeVisible();
});

test('Given a live camera during the countdown, When Back or Close is used, Then no tracks stay live', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.__streams = [];
    window.__liveTracks = () => window.__streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length;
    const track = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      canvas.getContext('2d').fillRect(0, 0, 16, 16);
      return canvas.captureStream(5).getVideoTracks()[0];
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const stream = new MediaStream([track(), track()]);
          window.__streams.push(stream);
          return stream;
        },
      },
    });
  });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(2);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(0);
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="2"]')).toBeVisible();
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#countdown')).toHaveText('3');
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(2);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#close-wizard').click();
  await expect(page.locator('#wizard')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__liveTracks())).toBe(0);
});

test('Given a stopped recording, When the preview is ready, Then Retake restores the shutter and Use this video opens consent', async ({ page }) => {
  await page.clock.install();
  await installRecorder(page, { infiniteDuration: true });
  await mockApp(page);
  await openToVideo(page);
  await expect(page.locator('#next-button')).toBeHidden();
  await page.getByRole('button', { name: 'Record video' }).click();
  await page.clock.fastForward(3_000);
  await page.clock.fastForward(5_200);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.clock.fastForward(80);
  await expect(page.locator('#video-check-status')).toBeHidden();
  await expect(page.locator('#use-video')).toBeEnabled();
  await expect(page.locator('#video-actions')).toBeHidden();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(page.locator('#video-preview')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(page.locator('#record-button')).toBeVisible();
  await page.getByRole('button', { name: 'Record video' }).click();
  await page.clock.fastForward(3_000);
  await page.clock.fastForward(5_200);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.clock.fastForward(80);
  await expect(page.locator('#video-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Use this video' }).click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
  await expect(page.locator('#next-button')).toBeVisible();
  await expect(page.locator('#consent-face')).toBeVisible();
});

test('Given an uploaded file, When it is checked, Then the checking status is visible and actions are disabled until the preview appears', async ({ page }) => {
  await mockApp(page);
  await openToVideo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Choose existing video')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await Promise.all([
    page.waitForFunction(() => {
      const status = document.querySelector('#video-check-status');
      const record = document.querySelector('#record-button');
      const input = document.querySelector('#video-input');
      return Boolean(status && !status.hidden && status.textContent.includes('Checking') && record?.disabled && input?.disabled);
    }),
    page.locator('#video-input').setInputFiles(video),
  ]);
  await expect(page.locator('#video-preview')).toBeVisible();
  await expect(page.locator('#use-video')).toBeEnabled();
  await expect(page.locator('#video-actions')).toBeHidden();
  await expect(page.locator('#next-button')).toBeHidden();
});

test('Given no MediaRecorder, When the video step opens, Then the phone camera input is offered and follows the review path', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    window.MediaRecorder = undefined;
  });
  await mockApp(page);
  await openToVideo(page);
  await expect(page.locator('#native-capture-label')).toBeVisible();
  await page.locator('#video-capture-input').setInputFiles(video);
  await expect(page.locator('#video-preview')).toBeVisible();
  await expect(page.locator('#use-video')).toBeEnabled();
  await page.getByRole('button', { name: 'Use this video' }).click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
});

test('Given consent is complete, When the upload is in progress, Then percent, Cancel, and Retry are available and the file stays local', async ({ page }) => {
  await page.addInitScript(() => { window.__uploadMode = 'hang'; });
  await mockApp(page, { autoAdvance: true });
  await openToConsent(page);
  await page.locator('#identity-name').fill('Upload Owner');
  for (const id of ['consent-face', 'consent-extraction', 'consent-voice', 'consent-process', 'consent-archive']) await page.locator(`#${id}`).check();
  await page.locator('#next-button').click();
  await expect(page.locator('#consent-error')).toContainText('All six authorizations are required.');
  expect(await page.evaluate(() => window.__blobUploadCalls.length)).toBe(0);
  await page.locator('#consent-provider-exposure').check();
  await page.locator('#next-button').click();
  await expect(page.locator('#upload-progress-label')).toContainText('35%');
  await expect(page.locator('#upload-meter')).toHaveAttribute('value', '35');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#upload-progress-label')).toContainText('still on this device');
  await expect(page.locator('#retry-upload')).toBeVisible();
  await page.evaluate(() => { window.__releaseUpload = null; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enrollment is ready.' })).toBeVisible({ timeout: 12_000 });
});

test('Given a denied camera, When the browser is named, Then the message explains how to allow it without an exception name', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
  });
  await mockApp(page);
  await openToVideo(page);
  await page.getByRole('button', { name: 'Record video' }).click();
  await expect(page.locator('#video-error')).toContainText('Camera or microphone access was denied');
  await expect(page.locator('#video-error')).not.toContainText('NotAllowedError');
  await expect(page.locator('#video-error')).toContainText(/Chrome|Safari|Firefox|Edge|browser settings/);
});

test('Identity capture stays readable in light, dark, and reduced motion without recoloring the button', async ({ page }) => {
  await mockApp(page);
  await openToVideo(page);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const color = await page.locator('#record-button').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(color).toBe('rgb(36, 88, 211)');
    const target = await page.locator('#record-button').evaluate(element => element.getBoundingClientRect().height);
    expect(target).toBeGreaterThanOrEqual(44);
  }
  const pulse = await page.locator('.record-dot').evaluate(element => getComputedStyle(element).animationName);
  expect(pulse).toBe('none');
  const scriptSize = await page.locator('#teleprompter-script').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  expect(scriptSize).toBeGreaterThanOrEqual(15);
});

test('desktop Take a photo opens the camera and a denied camera falls back to Choose a portrait', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
    });
  });
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await expect(page.locator('#photo-error')).toContainText('Camera access was denied. Choose a portrait instead.');
  await expect(page.locator('#photo-drop')).toBeVisible();
  await expect(page.getByText('Choose a portrait', { exact: true })).toBeVisible();
  await expect(page.locator('#photo-camera')).toBeHidden();
});

test('Take a photo uses the phone file input when the browser has no camera API', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Take a photo' }).click(),
  ]);
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles(photo);
  await expect(page.locator('#photo-preview')).toBeVisible();
});

test('a phone Take a photo opens the native camera input instead of the in-page webcam', async ({ page }) => {
  await page.addInitScript(() => {
    window.__mediaCalls = 0;
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      if (String(query).includes('pointer') && String(query).includes('coarse')) {
        return { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
      }
      return original(query);
    };
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { mobile: true, brands: [] } });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { window.__mediaCalls += 1; throw new Error('desktop camera'); } },
    });
  });
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Take a photo' }).click(),
  ]);
  expect(chooser.isMultiple()).toBe(false);
  expect(await page.evaluate(() => window.__mediaCalls)).toBe(0);
  await expect(page.locator('#photo-camera')).toBeHidden();
});

test('an in-page portrait capture stops the camera after Use photo and after Cancel', async ({ page }) => {
  await page.addInitScript(() => {
    window.__photoStops = 0;
    const makeStream = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d');
      context.fillStyle = '#336699';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(5);
      for (const track of stream.getVideoTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { window.__photoStops += 1; stop(); };
      }
      return stream;
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => makeStream() },
    });
  });
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await expect(page.locator('#photo-live')).toBeVisible();
  const shutter = page.locator('#photo-shutter');
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.locator('#photo-preview')).toBeVisible();
  await expect(page.locator('#photo-camera')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__photoStops)).toBeGreaterThan(0);

  await page.evaluate(() => { window.__photoStops = 0; });
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await expect(page.locator('#photo-shutter')).toBeEnabled();
  await page.locator('#photo-camera-cancel').click();
  await expect(page.locator('#photo-camera')).toBeHidden();
  await expect(page.locator('#photo-drop')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__photoStops)).toBeGreaterThan(0);
});

test('a late photo permission result after closing stops its tracks', async ({ page }) => {
  await page.addInitScript(() => {
    window.__photoStops = 0;
    const track = { kind: 'video', readyState: 'live', stop() { window.__photoStops += 1; } };
    let resolveMedia;
    window.__resolvePhoto = () => resolveMedia({ getTracks: () => [track] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolve => { resolveMedia = resolve; }) },
    });
  });
  await mockApp(page);
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.getByRole('button', { name: 'Take a photo' }).click();
  await page.locator('#close-wizard').click();
  await page.evaluate(() => window.__resolvePhoto());
  await expect.poll(() => page.evaluate(() => window.__photoStops)).toBe(1);
  await expect(page.locator('#wizard')).toBeHidden();
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
  await stageVideo(page);
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
  const heldCreatePresenter = page.getByRole('button', { name: 'Create my presenter' });
  await expect(heldCreatePresenter).toBeDisabled();
  await expect(page.locator('#ready-provider-hold')).toContainText('privacy, entitlement, and cost checks');
  await expect(page.locator('#ready-use-link')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#ready-copy')).toContainText('Final presenter creation has not started');
  await expect(page.locator('#ready-media-review')).toBeVisible();
  await expect(page.locator('#ready-photo-preview')).toHaveAttribute('src', new RegExp('^/api/video-os-lite/asset'));
  await expect(page.locator('#ready-video-preview')).toHaveAttribute('src', /preview=video/);
  await expect(page.getByLabel('Extracted voice sample', { exact: true })).toHaveAttribute('src', /preview=voice/);
  await expect(page.getByText(/transcript/i)).toHaveCount(0);
  await page.getByLabel('Extracted voice sample', { exact: true }).dispatchEvent('error');
  await expect(page.locator('#ready-media-preview-status')).toContainText('extracted voice sample could not be loaded');

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
  await expect(page.getByRole('button', { name: 'Preview extracted voice sample' })).toBeVisible();
});

test('an existing ready enrollment can start provider creation once from the Ready step', async ({ page }) => {
  await page.clock.install();
  const mock = await mockApp(page, { providerEnabled: true, initialIdentities: [{ ...draft }], initialEnrollment: enrollment('IDENTITY_READY') });
  await page.addInitScript(({ id }) => localStorage.setItem('luxVideoOsEnrollmentResumeV1:owner-a', JSON.stringify({
    enrollmentId: id, createIdempotencyKey: '11111111-1111-4111-8111-111111111111', consentIdempotencyKey: null,
    retryIdempotencyKey: null, revokeIdempotencyKey: null,
  })), { id: IDS.enrollment });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  const createPresenter = page.getByRole('button', { name: 'Create my presenter' });
  await expect(createPresenter).toBeEnabled();
  await expect(createPresenter).toBeFocused();
  expect(mock.calls.filter(call => call.endpoint === 'identities' && call.body.action === 'submit')).toHaveLength(0);

  await createPresenter.evaluate(button => { button.click(); button.click(); });

  await expect.poll(() => mock.calls.filter(call => call.endpoint === 'identities' && call.body.action === 'submit').length).toBe(1);
  await expect(page.locator('#compact-step-label')).toContainText('4 of 5: Creating');
  await page.clock.fastForward(8_500);
  await expect(page.locator('#compact-step-label')).toContainText('5 of 5: Ready');
  await expect(page.locator('#ready-use-link')).toHaveAttribute('aria-disabled', 'false');
  expect(mock.calls.filter(call => call.endpoint === 'identities' && call.body.action === 'submit')).toHaveLength(1);
});

test('extracted and HeyGen cloned voice previews stay distinct and keyboard usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const readyIdentity = {
    ...draft,
    overallStatus: 'READY',
    avatarStatus: 'READY',
    voiceStatus: 'READY',
    ready: true,
    voicePreviewUrl: '/api/video-os-lite/identities?voicePreview=' + IDS.identity,
  };
  await mockApp(page, { providerEnabled: true, initialIdentities: [readyIdentity], initialEnrollment: enrollment('IDENTITY_READY') });
  await page.goto('/identity.html');

  const extracted = page.getByRole('button', { name: 'Preview extracted voice sample' });
  const extractedAudioId = await extracted.getAttribute('aria-controls');
  expect(extractedAudioId).toBe('identity-extracted-voice-' + IDS.identity);
  await expect(page.locator('#' + extractedAudioId)).toBeHidden();
  await extracted.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#' + extractedAudioId)).toHaveAttribute('src', /preview=voice/);
  await expect(extracted).toHaveAttribute('aria-expanded', 'true');

  const provider = page.getByRole('button', { name: 'Preview The Render cloned voice' });
  const providerAudioId = await provider.getAttribute('aria-controls');
  expect(providerAudioId).toBe('identity-provider-voice-' + IDS.identity);
  await provider.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#' + providerAudioId)).toHaveAttribute('src', /voicePreview=/);
  await expect(provider).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Owner Studio extracted voice sample')).toBeHidden();

  const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
});

test('extracted voice load failures collapse the control and announce a live status', async ({ page }) => {
  const readyIdentity = {
    ...draft,
    overallStatus: 'READY',
    avatarStatus: 'READY',
    voiceStatus: 'DRAFT',
    ready: false,
  };
  await mockApp(page, {
    initialIdentities: [readyIdentity],
    initialEnrollment: enrollment('IDENTITY_READY'),
    failExtractedVoicePreview: true,
  });
  await page.goto('/identity.html');
  const control = page.getByRole('button', { name: 'Preview extracted voice sample' });
  await control.click();
  await expect(page.locator('#identity-voice-preview-status-' + IDS.identity)).toContainText('extracted voice sample could not be loaded');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#identity-extracted-voice-' + IDS.identity)).toBeHidden();
  await expect(control).toBeFocused();
});

test('failed direct upload persists only resume metadata and resumes after reload with the original video reselected', async ({ page }) => {
  await mockApp(page, { autoAdvance: true, failUploadOnce: true });
  await openToConsent(page);
  await page.locator('#identity-name').fill('Resume Owner');
  await checkAllConsents(page);
  await page.locator('#next-button').click();
  await expect(page.locator('#upload-progress-label')).toContainText('Private upload interrupted');
  await expect(page.locator('#retry-upload')).toBeVisible();
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

test('zero-admission provider hold exits Creating and does not retry either component', async ({ page }) => {
  const mock = await mockApp(page, {
    providerEnabled: true,
    initialIdentities: [{ ...draft }],
    initialEnrollment: enrollment('IDENTITY_READY'),
    submitMode: 'held',
  });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Start creation' }).click();

  await expect(page.locator('#wizard')).toBeHidden();
  await expect(page.locator('#notice')).toContainText('No provider request was sent');
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  expect(mock.calls.filter(call => call.endpoint === 'identities' && call.body.action === 'submit')).toHaveLength(1);
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'refresh')).toBe(false);
});

test('ambiguous provider admission stays on an explicit reconciliation hold without retrying', async ({ page }) => {
  const mock = await mockApp(page, {
    providerEnabled: true,
    initialIdentities: [{ ...draft }],
    initialEnrollment: enrollment('IDENTITY_READY'),
    submitMode: 'reconciliation',
  });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Start creation' }).click();

  await expect(page.locator('#wizard')).toBeVisible();
  await expect(page.locator('#compact-step-label')).toContainText('4 of 5: Creating');
  await expect(page.locator('#wizard-status')).toContainText('held for reconciliation');
  expect(mock.calls.filter(call => call.endpoint === 'identities' && call.body.action === 'submit')).toHaveLength(1);
  expect(mock.calls.some(call => call.endpoint === 'identities' && call.body.action === 'refresh')).toBe(false);
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

test('a failed enrollment with no retry stops the spinner and shows recovery actions', async ({ page }) => {
  await page.clock.install();
  const failed = enrollment('FAILED', {
    failure: {
      code: 'FRAME_RATE_UNAVAILABLE',
      message: 'Enrollment source frame rate could not be verified.',
      retryable: false,
    },
    retry: null,
  });
  let detailReads = 0;
  page.on('request', request => {
    const url = request.url();
    if (request.method() === 'GET' && url.includes('/api/video-os-lite/enrollments') && url.includes('enrollmentId=')) detailReads += 1;
  });
  await mockApp(page, { initialEnrollment: failed });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Continue setup' }).click();

  const recovery = page.locator('#enrollment-recovery');
  await expect(page.locator('[data-panel="4"]')).toHaveAttribute('data-terminal', 'true');
  await expect(page.getByRole('heading', { name: 'Setup could not finish' })).toBeVisible();
  await expect(recovery).toContainText('frame rate we can verify');
  await expect(recovery).not.toContainText('FRAME_RATE_UNAVAILABLE');
  await expect(page.locator('#creating-heading')).toBeHidden();
  await expect(recovery.getByRole('button', { name: 'Cancel setup' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Start over' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Retry', exact: true })).toBeHidden();
  await expect(recovery.getByRole('button', { name: 'Check status' })).toBeHidden();
  const spinner = await page.locator('[data-panel="4"] .processing-orbit').evaluate(element => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, display: style.display };
  });
  expect(spinner.display).toBe('none');
  expect(spinner.animationName).toBe('none');

  const readsAfterPaint = detailReads;
  await page.clock.fastForward(12_000);
  expect(detailReads).toBe(readsAfterPaint);
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
