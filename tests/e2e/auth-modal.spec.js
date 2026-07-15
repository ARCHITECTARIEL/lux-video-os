import { expect, test } from '@playwright/test';

async function stubShell(page, session = { ok: true, signedIn: false }) {
  await page.route('**/api/video-os-lite/session', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: false }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
  });
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, providers: [], credits: { balance: 0 } }),
  }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, results: [] }),
  }));
}

test('auth modal openers, close controls, and focus restoration work', async ({ page }) => {
  await stubShell(page);
  await page.goto('/');
  const opener = page.locator('#open-login');
  await opener.click();
  await expect(page.locator('#auth-modal')).toBeVisible();
  await expect(page.locator('#password-username')).toBeFocused();
  await expect(page.locator('#sign-out')).toBeHidden();
  await page.locator('#close-login').click();
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('password errors are actionable and retry succeeds', async ({ page }) => {
  await stubShell(page);
  let attempts = 0;
  await page.route('**/api/video-os-lite/password-login', async (route) => {
    attempts += 1;
    if (attempts === 1) { await route.abort('connectionfailed'); return; }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, signedIn: true, email: 'demo@luxvideoos.local', message: 'Demo workspace unlocked.', account: { accountId: 'demo', name: 'LUX Demo', subscription: { plan: 'Demo', status: 'active' } }, credits: { accountId: 'demo', balance: 5000 } }),
    });
  });
  await page.goto('/');
  await page.locator('#open-login').click();
  await page.locator('#password-username').fill('luxdemo');
  await page.locator('#password-password').fill('luxdemo');
  await page.locator('#password-login').click();
  await expect(page.locator('#auth-status')).toContainText('We couldn’t reach Video OS');
  await expect(page.locator('#auth-retry')).toBeVisible();
  await page.locator('#auth-retry').click();
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(page.locator('#open-login')).toContainText('Account');
});

test('email form submits with Enter and exposes provider failure', async ({ page }) => {
  await stubShell(page);
  await page.route('**/api/video-os-lite/auth-request', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, code: 'email_delivery_failed', error: 'We could not send the sign-in email. Check the address and try again.' }),
  }));
  await page.goto('/');
  await page.locator('#open-login').click();
  await page.locator('#auth-email').fill('ariel@luxmarketingcompany.com');
  await page.locator('#auth-email').press('Enter');
  await expect(page.locator('#auth-status')).toContainText('could not send');
  await expect(page.locator('#auth-retry')).toBeVisible();
  await expect(page.locator('#send-magic-link')).toBeEnabled();
});
