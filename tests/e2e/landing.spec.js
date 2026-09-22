import { expect, test } from '@playwright/test';

test('landing page renders the hero, examples, presentation choices, pricing, and FAQ, and every CTA opens the real sign-in flow', async ({ page }) => {
  await page.goto('/landing.html');
  await expect(page.locator('h1')).toContainText('Professional business videos.');

  for (const cta of await page.locator('a.button', { hasText: /Create my free video|Start free|Choose (Starter|Growth|Studio)/ }).all()) {
    await expect(cta).toHaveAttribute('href', '/?signin=1');
  }
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toHaveAttribute('href', '/?signin=1');

  await expect(page.locator('.lp-example-card')).toHaveCount(3);
  await expect(page.locator('.lp-tier-card')).toHaveCount(2);
  await expect(page.locator('.lp-price-card')).toHaveCount(3);
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

test('nav "Examples" link scrolls to the examples section', async ({ page }) => {
  await page.goto('/landing.html');
  await page.locator('.lp-nav-links a', { hasText: 'Examples' }).click();
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
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Start free' })).toBeVisible();
});
