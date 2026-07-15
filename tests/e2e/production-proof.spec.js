import { expect, test } from '@playwright/test';

test('new-job production receipt gate', async ({ page, request, browser }) => {
  test.skip(!process.env.VIDEO_OS_PROOF_BASE_URL || !process.env.VIDEO_OS_PROOF_USERNAME || !process.env.VIDEO_OS_PROOF_PASSWORD, 'Production proof credentials and origin are required.');
  const marker = `P0-PROOF-${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  const preflight = await request.get('/api/video-os-lite/results');
  expect(preflight.status()).toBe(401);
  await page.goto('/');
  await page.getByRole('button', { name: /sign in/i }).first().click();
  await page.locator('input[name="username"]').fill(process.env.VIDEO_OS_PROOF_USERNAME);
  await page.locator('input[name="password"]').fill(process.env.VIDEO_OS_PROOF_PASSWORD);
  await page.getByRole('button', { name: /continue|sign in/i }).last().click();
  await expect(page.getByText(/signed in|account/i).first()).toBeVisible();
  test.info().annotations.push({ type: 'proof-marker', description: marker });
  const fresh = await browser.newContext();
  expect((await fresh.cookies()).length).toBe(0);
  await fresh.close();
  test.fail(true, 'This gate remains intentionally incomplete until the workflow-backed render controls expose a test-only proof driver.');
});
