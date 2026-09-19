import { expect, test } from '@playwright/test';

test('flagship shell loads without exposing a direct customer artifact', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Create a video' })).toBeVisible();
  await expect(page.locator('[data-nav="create"]:visible').first()).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-nav="copywriter"]:visible').first()).toHaveAccessibleName('AI Copywriter');
  await expect(page.locator('[data-nav="identities"]:visible').first()).toHaveAccessibleName('My identities');
  await expect(page.locator('[data-nav="videos"]:visible').first()).toHaveAccessibleName('My Videos');
  await expect(page.locator('body')).not.toContainText('blob.vercel-storage.com');
  await expect(page.locator('body')).not.toContainText(/1,284 avatars|2,436 voices|Argil|Tavus|D-ID/);
});
