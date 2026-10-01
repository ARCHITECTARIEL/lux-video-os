import { expect, test } from '@playwright/test';

const IDENTITY_ID = '4c2f26b6-cdd4-4d53-8e37-17e7858c679c';
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, { premiumAvailable = true } = {}) {
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, route => route.abort());
  await page.route('**/api/video-os-lite/session', route => reply(route, { ok: true, signedIn: true, account: { accountId: 'fixture-owner', name: 'Local owner' }, credits: { balance: 500, reserved: 0 }, entitlements: { fullAccess: true } }));
  await page.route('**/api/video-os-lite/identities*', route => reply(route, { ok: true, identities: [{ id: IDENTITY_ID, displayName: 'Fixture presenter', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, archivedAt: null }] }));
  await page.route('**/api/video-os-lite/projects*', route => reply(route, { ok: true, projects: [] }));
  await page.route('**/api/video-os-lite/results*', route => reply(route, { ok: true, results: [] }));
  await page.route('**/api/video-os-lite/copywriter*', route => reply(route, { ok: true, available: false }));
  await page.route('**/api/video-os-lite/scripted-photo*', route => reply(route, { ok: true, contractVersion: 'scripted-photo-v1', pricingVersion: 'scripted-photo-pricing-v1', quoteTtlSeconds: 300, capabilities: { enabled: premiumAvailable, tiers: { STANDARD: { available: premiumAvailable, credits: premiumAvailable ? 37 : null, reasons: premiumAvailable ? [] : ['feature_disabled'] }, PREMIUM: { available: premiumAvailable, credits: 90, reasons: premiumAvailable ? [] : ['feature_disabled'] } } }, existingJob: null }));
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
}

test('unsupported Premium composition and separate talent controls are hidden with explicit contract copy', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#premium-composition-enabled')).toBeHidden();
  await expect(page.locator('#premium-composition-options')).toBeHidden();
  await expect(page.locator('#studio-preview-card')).toBeHidden();
  await expect(page.locator('.cast-columns')).toBeHidden();
  await expect(page.locator('.contract-limit-note').filter({ hasText: 'Backgrounds, layouts' })).toBeVisible();
  await expect(page.locator('.contract-limit-note').filter({ hasText: 'Additional presenter' })).toBeVisible();
});

test('Premium capability can disable render without clearing its title or script draft', async ({ page }) => {
  await setup(page, { premiumAvailable: false });
  await page.locator('#premium-title').fill('Preserved Premium draft');
  await page.locator('#script-input').fill('This script remains editable while the tier is unavailable.');
  await page.locator(`[data-premium-identity-id="${IDENTITY_ID}"]`).click();
  await expect(page.locator('#generate-video')).toBeDisabled();
  await expect(page.locator('#premium-status')).toContainText(/not enabled|not currently available/i);
  await expect(page.locator('#premium-title')).toHaveValue('Preserved Premium draft');
  await expect(page.locator('#script-input')).toHaveValue('This script remains editable while the tier is unavailable.');
});

test('Premium scripted controls fit a narrow screen without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.viewport);
  const button = await page.locator('#generate-video').boundingBox();
  expect(button.height).toBeGreaterThanOrEqual(44);
});
