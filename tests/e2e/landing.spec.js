import { expect, test } from '@playwright/test';

test('landing page renders the hero, tiers, pricing, and FAQ, and every CTA opens the real sign-in flow', async ({ page }) => {
  await page.goto('/landing.html');
  await expect(page.locator('h1')).toContainText('Your face. Your voice.');

  for (const cta of await page.locator('a.button', { hasText: /Get started free|Choose (Starter|Growth|Studio)/ }).all()) {
    await expect(cta).toHaveAttribute('href', '/?signin=1');
  }
  await expect(page.locator('.lp-nav-actions a', { hasText: 'Log in' })).toHaveAttribute('href', '/?signin=1');

  await expect(page.locator('.lp-tier-card')).toHaveCount(2);
  await expect(page.locator('.lp-price-card')).toHaveCount(3);
  await expect(page.locator('.lp-compare-table tbody tr')).toHaveCount(5);
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
