import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const OUTPUT_DIR = path.resolve('.design/bridge-consent-screenshots');
const photoBytes = await readFile(new URL('../../public/lux-logo.png', import.meta.url));
const videoBytes = await readFile(new URL('../../public/assets/showcase/example-faq.mp4', import.meta.url));
const IDS = {
  enrollment: '0d566634-5887-4b5d-b1a0-51f2137da97d',
  identity: '4eb35c45-8427-4237-b098-d5485b8b7808',
  photo: '9ba00bd4-81b7-40ad-a28b-b625c33242e3',
};

const identity = {
  id: IDS.identity,
  displayName: 'Owner Studio',
  overallStatus: 'DRAFT',
  avatarStatus: 'DRAFT',
  voiceStatus: 'DRAFT',
  portraitUrl: `/api/video-os-lite/asset?assetId=${IDS.photo}`,
  voicePreviewUrl: null,
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  ready: false,
};

function legacyEnrollment() {
  return {
    id: IDS.enrollment,
    displayName: identity.displayName,
    status: 'IDENTITY_READY',
    stateVersion: 9,
    photo: { assetId: IDS.photo, sha256: 'c'.repeat(64), previewUrl: `/api/video-os-lite/asset?assetId=${IDS.photo}` },
    sourceVideo: { state: 'VALIDATED', sha256: 'a'.repeat(64), previewUrl: `/api/video-os-lite/enrollments?enrollmentId=${IDS.enrollment}&preview=video` },
    derivedAudio: { state: 'READY', sha256: 'd'.repeat(64) },
    consent: { required: false, status: 'active', policyVersion: 'identity-video-audio-extraction-v1', purpose: 'identity-voice-enrollment' },
    providerBridgeConsent: {
      required: true,
      status: 'missing',
      policyVersion: 'identity-provider-bridge-v2',
      temporaryPublicProviderExposureAuthorized: false,
      reconsentAvailable: true,
    },
    providerLifecycle: { state: 'not_started', blockers: [] },
    identity,
    failure: null,
    retry: null,
    createdAt: '2026-09-30T12:00:00.000Z',
    updatedAt: '2026-09-30T12:00:00.000Z',
  };
}

async function mockIdentityStudio(page, { legacy }) {
  const providerMutations = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/video-os-lite/session', route => route.fulfill({ json: {
    ok: true,
    signedIn: true,
    email: 'owner@example.com',
    account: { accountId: 'visual-owner', name: 'Owner' },
  } }));
  await page.route('**/api/video-os-lite/asset?*', route => route.fulfill({ contentType: 'image/png', body: photoBytes }));
  await page.route('**/api/video-os-lite/identities*', route => {
    if (route.request().method() !== 'GET') providerMutations.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, identities: legacy ? [identity] : [], providerSubmissionEnabled: true } });
  });
  await page.route('**/api/video-os-lite/enrollments*', route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('preview') === 'video') return route.fulfill({ contentType: 'video/mp4', body: videoBytes });
    if (route.request().method() !== 'GET') providerMutations.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      ok: true,
      enabled: true,
      extractionEnabled: true,
      limits: { sourceVideo: { maximumSizeInBytes: 104857600, minimumDurationSeconds: 5, maximumDurationSeconds: 60, maximumDimensionPx: 4096, allowedContentTypes: ['video/mp4', 'video/quicktime', 'video/webm'] } },
      enrollments: legacy ? [legacyEnrollment()] : [],
    } });
  });
  return { providerMutations, pageErrors };
}

async function openFreshConsent(page) {
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.locator('#photo-input').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: photoBytes });
  await page.locator('#next-button').click();
  await page.locator('#video-input').setInputFiles({ name: 'phone-video.mp4', mimeType: 'video/mp4', buffer: videoBytes });
  await expect(page.locator('#video-metadata')).toContainText('seconds');
  await page.getByRole('button', { name: 'Use this video' }).click();
  await page.locator('#next-button').click();
  await expect(page.locator('[data-panel="3"]')).toBeVisible();
  await page.locator('#identity-name').fill('My studio presenter');
}

async function openLegacyReconsent(page) {
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Review provider consent' }).click();
  await expect(page.getByRole('heading', { name: 'Review provider consent' })).toBeVisible();
}

async function captureConsentPair(page, basename) {
  await page.evaluate(() => document.fonts.ready);
  const panel = page.locator('[data-panel="3"]');
  await panel.evaluate(element => { element.scrollTop = 0; });
  if (await page.locator('#provider-reconsent-note').isVisible()) {
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${basename}-owned-sources.png`) });
  }
  const disclosure = page.locator('.provider-exposure-disclosure');
  await panel.evaluate(element => {
    const target = element.querySelector('.provider-exposure-disclosure');
    const delta = target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTop = Math.max(0, element.scrollTop + delta - 16);
    window.scrollTo(0, 0);
  });
  await expect(disclosure).toBeInViewport();
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${basename}-disclosure.png`) });

  const exposureConsent = page.locator('.provider-exposure-consent');
  await panel.evaluate(element => {
    const target = element.querySelector('.provider-exposure-consent');
    const delta = target.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
    element.scrollTop = Math.max(0, element.scrollTop + delta + 28);
  });
  await expect(exposureConsent).toBeInViewport();
  await page.screenshot({ path: path.join(OUTPUT_DIR, `${basename}-authorization.png`) });

  const layout = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogWidth: document.querySelector('#wizard').scrollWidth }));
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.dialogWidth).toBeLessThanOrEqual(layout.viewport + 1);
  for (const checkbox of await page.locator('.consent-list input').all()) await expect(checkbox).not.toBeChecked();
}

test.describe('provider bridge consent visual evidence', () => {
  test.skip(process.env.BRIDGE_CONSENT_VISUALS !== '1', 'Run explicitly to refresh scoped design evidence.');

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`fresh consent ${viewport.name}`, async ({ page }) => {
      await mkdir(OUTPUT_DIR, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const evidence = await mockIdentityStudio(page, { legacy: false });
      await openFreshConsent(page);
      await captureConsentPair(page, `fresh-consent-${viewport.name}`);
      expect(evidence.providerMutations).toEqual([]);
      expect(evidence.pageErrors).toEqual([]);
    });

    test(`legacy reconsent ${viewport.name}`, async ({ page }) => {
      await mkdir(OUTPUT_DIR, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const evidence = await mockIdentityStudio(page, { legacy: true });
      await openLegacyReconsent(page);
      await expect(page.locator('#provider-reconsent-note')).toBeVisible();
      await captureConsentPair(page, `legacy-reconsent-${viewport.name}`);
      expect(evidence.providerMutations).toEqual([]);
      expect(evidence.pageErrors).toEqual([]);
    });
  }
});
