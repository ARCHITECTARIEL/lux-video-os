import { expect, test } from '@playwright/test';

test('flagship shell loads without exposing a direct customer artifact', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('AI videos');
  await expect(page.locator('body')).not.toContainText('blob.vercel-storage.com');
});
