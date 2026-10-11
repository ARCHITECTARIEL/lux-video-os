import { expect, test } from '@playwright/test';

test('landing page renders the current Welcome offer and every creation CTA opens sign-in', async ({ page }) => {
  await page.goto('/landing.html');
  await expect(page.locator('h1')).toContainText('Professional business videos.');

  const creationLinks = page.locator('a.button', { hasText: /Create a video|Choose (Starter|Growth|Studio)/ });
  await expect(creationLinks).toHaveCount(7);
  for (const cta of await creationLinks.all()) {
    await expect(cta).toHaveAttribute('href', '/?signin=1');
  }
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toHaveAttribute('href', '/?signin=1');

  await expect(page.locator('.lp-example-card')).toHaveCount(1);
  await expect(page.locator('.lp-tier-card')).toHaveCount(2);
  await expect(page.locator('.lp-price-card')).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText(/first video is free|free trial credits|create my free video/i);
});

test('Welcome videos use the new media and the owner video includes captions', async ({ page, request }) => {
  await page.goto('/landing.html');
  const media = [
    ['lp-hero-video', 'product-preview'],
    ['lp-example-faq', 'customer-qa'],
    ['lp-walkthrough-video', 'how-to'],
    ['lp-ceo-video', 'owner-kristian'],
  ];
  for (const [id, basename] of media) {
    const video = page.locator(`#${id}`);
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

test('mobile header stays on one line at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/landing.html');
  const nav = page.locator('.lp-nav');
  const box = await nav.boundingBox();
  // A wrapped header (logo + actions on separate rows) roughly doubles this
  // height; a single-line header stays comfortably under 80px regardless of
  // exact font metrics.
  expect(box.height).toBeLessThan(80);
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toBeVisible();
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Create a video' })).toBeVisible();
});
