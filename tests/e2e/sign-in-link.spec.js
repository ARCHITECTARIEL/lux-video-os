import { expect, test } from '@playwright/test';

const reasons = [
  ['expired', 'This sign-in link expired.'],
  ['used', 'This sign-in link was already used.'],
  ['invalid', "This sign-in link isn't valid."],
  ['google', "Google sign-in was cancelled or isn't available."],
];

for (const [reason, heading] of reasons) {
  test(`sign-in link page explains ${reason} and can request a new link`, async ({ page }) => {
    let posted = null;
    await page.route('**/api/video-os-lite/auth-request', async route => {
      posted = { accept: route.request().headers().accept, body: route.request().postDataJSON() };
      await route.fulfill({ json: { ok: true, email: 'person@example.com', message: 'Check your email for a secure sign-in link.' } });
    });
    await page.goto(`/sign-in-link.html?reason=${reason}&token=should-not-stay`);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/sign-in-link\\.html\\?reason=${reason}$`));
    await page.locator('#resend-email').fill('person@example.com');
    await page.getByRole('button', { name: 'Send me a new link' }).click();
    await expect(page.locator('#resend-status')).toHaveText('Check your email for a secure sign-in link.');
    expect(posted.body).toEqual({ email: 'person@example.com' });
    expect(posted.accept).toContain('application/json');
  });
}

test('an unknown sign-in reason is treated as an invalid link', async ({ page }) => {
  await page.goto('/sign-in-link.html?reason=token-secret');
  await expect(page.getByRole('heading', { name: "This sign-in link isn't valid." })).toBeVisible();
  await expect(page).toHaveURL(/reason=invalid$/);
  await expect(page.locator('body')).not.toContainText('token-secret');
});
