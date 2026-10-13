import { expect, test } from '@playwright/test';
import { createServer } from '../../server/index.js';

async function withRouteAdapter(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('landing page renders conservative workflow and credit copy with working sign-in CTAs', async ({ page, request }) => {
  await withRouteAdapter(async (baseUrl) => {
    const welcome = await request.get(`${baseUrl}/welcome`);
    expect(welcome.ok()).toBe(true);
    expect(welcome.headers()['cache-control']).toBe('no-store');
    expect(await welcome.text()).toContain('<title>LUX Video OS');
  });

  await page.goto('/landing.html');
  await expect(page.locator('h1')).toContainText('Professional business videos.');

  const startLinks = page.getByRole('link', { name: 'Sign in to start' });
  await expect(startLinks).toHaveCount(4);
  for (const cta of await startLinks.all()) {
    await expect(cta).toHaveAttribute('href', '/?signin=1');
  }
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toHaveAttribute('href', '/?signin=1');
  await expect(page.getByRole('link', { name: 'Sign in to review your workspace' })).toHaveAttribute('href', '/?signin=1');
  expect((await request.get('/?signin=1')).ok()).toBe(true);

  await expect(page.locator('.lp-example-card')).toHaveCount(1);
  await expect(page.locator('.lp-tier-card')).toHaveCount(1);
  await expect(page.locator('.lp-price-card')).toHaveCount(0);
  await expect(page.locator('body')).toContainText('Rendering requires credits; no complimentary render or automatic trial credits are included.');
  await expect(page.locator('body')).toContainText('Regular new accounts start with zero render credits.');
  await expect(page.locator('body')).toContainText('Studio shows a server-issued credit quote for the workflow and format you select before you confirm a render.');
  await expect(page.locator('body')).toContainText('An optional AI Copywriter may be available separately in your workspace.');
  await expect(page.locator('body')).toContainText('Credit purchasing is not available from this Welcome page.');
  await expect(page.locator('body')).not.toContainText(/90 credits|≈\s*\d+ videos|\$\s*\d+(?:[.,]\d{1,2})?|Choose (Starter|Growth|Studio)/i);
  await expect(page.locator('body')).not.toContainText(/owned by you|you own|belongs to you|never shared|nothing is shared|not shared with anyone|used to train other models|tied to that render only|do I own/i);

  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: { ok: true, signedIn: false } }));
  await startLinks.first().click();
  await expect(page).toHaveURL(/\/\?signin=1$/);
  await expect(page.locator('#auth-modal')).toBeVisible();
  await expect(page.locator('#auth-modal-title')).toHaveText('Welcome back');
});

test('Welcome videos use the new media and the owner video includes captions', async ({ page, request }) => {
  await page.goto('/landing.html');
  const media = [
    ['lp-hero-video', 'product-preview', 'Product preview video'],
    ['lp-example-faq', 'customer-qa', 'Customer question and answer example video'],
    ['lp-walkthrough-video', 'how-to', 'LUX Video OS how-to video'],
    ['lp-ceo-video', 'owner-kristian', 'Kristian welcome video'],
  ];
  for (const [id, basename, accessibleName] of media) {
    const video = page.locator(`#${id}`);
    await expect(video).toHaveAccessibleName(accessibleName);
    await expect(video).toHaveAttribute('poster', `/assets/showcase/${basename}.webp`);
    await expect(video.locator('source')).toHaveAttribute('src', `/assets/showcase/${basename}.mp4`);
    await expect(page.locator(`[data-play="${id}"]`)).toBeVisible();
    expect((await request.get(`/assets/showcase/${basename}.webp`)).ok()).toBe(true);
    expect((await request.get(`/assets/showcase/${basename}.mp4`)).ok()).toBe(true);
  }
  await expect(page.locator('#lp-ceo-video track')).toHaveAttribute('src', '/assets/showcase/owner-kristian.vtt');
  expect((await request.get('/assets/showcase/owner-kristian.vtt')).ok()).toBe(true);
});

test('FAQ accordion opens and closes independently', async ({ page }) => {
  await page.goto('/landing.html');
  const first = page.locator('.lp-faq-item').first();
  const second = page.locator('.lp-faq-item').nth(1);
  await expect(first).not.toHaveJSProperty('open', true);

  await first.locator('summary').click();
  await expect(first).toHaveJSProperty('open', true);
  await expect(second).not.toHaveJSProperty('open', true);

  await second.locator('summary').click();
  await expect(second).toHaveJSProperty('open', true);
});

test('nav "How it works" link scrolls to the steps section', async ({ page }) => {
  await page.goto('/landing.html');
  await page.locator('.lp-nav-links a', { hasText: 'How it works' }).click();
  await expect(page.locator('#how-it-works')).toBeInViewport();
});

test('nav "Q&A example" link scrolls to the example section', async ({ page }) => {
  await page.goto('/landing.html');
  await page.locator('.lp-nav-links a', { hasText: 'Q&A example' }).click();
  await expect(page.locator('#examples')).toBeInViewport();
});

test('mobile header stays on one line with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/landing.html');
  const nav = page.locator('.lp-nav');
  const box = await nav.boundingBox();
  // A wrapped header (logo + actions on separate rows) roughly doubles this
  // height; a single-line header stays comfortably under 80px regardless of
  // exact font metrics.
  expect(box.height).toBeLessThan(80);
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toBeVisible();
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Sign in to start' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
