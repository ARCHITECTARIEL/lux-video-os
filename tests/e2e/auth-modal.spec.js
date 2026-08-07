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


test('sign-in loads authorized talent and sign-out clears it without a provider submission', async ({ page }) => {
  await stubShell(page);
  let talentRequests = 0;
  let renderRequests = 0;
  await page.route('**/api/video-os/talent', (route) => {
    talentRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        talent: {
          avatars: [{ id: 'featured:ariel', name: 'Ariel', source: 'heygen', featuredKey: 'ariel', matchedVoiceId: 'featured:ariel:voice', active: true, providerReady: true, previewUrl: 'https://images.example/ariel.jpg' }],
          voices: [{ id: 'featured:ariel:voice', name: 'Ariel voice', source: 'heygen', featuredKey: 'ariel', active: true, providerReady: true }],
        },
        connection: { connected: true, status: 'connected' },
      }),
    });
  });
  await page.route('https://images.example/ariel.jpg', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));
  await page.route('**/api/video-os-lite/render', (route) => { renderRequests += 1; return route.abort(); });
  await page.route('**/api/video-os-lite/password-login', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, signedIn: true, email: 'proof@example.test', message: 'Signed in.', account: { accountId: 'proof', name: 'Proof' }, credits: { accountId: 'proof', balance: 0 } }),
  }));

  await page.goto('/');
  expect(talentRequests).toBe(0);
  await page.locator('#open-login').click();
  await page.locator('#password-username').fill('proof');
  await page.locator('#password-password').fill('local-only');
  await page.locator('#password-login').click();
  await expect(page.locator('[data-avatar-id="featured:ariel"]')).toHaveCount(1);
  expect(talentRequests).toBe(1);

  await page.locator('#download-link').evaluate((link) => { link.href = '/api/video-os-lite/download?jobId=private-job'; link.hidden = false; });
  await page.locator('.video-stage').evaluate((stage) => { const video = document.createElement('video'); video.className = 'final-preview-media'; video.src = '/api/video-os-lite/download?jobId=private-job&disposition=inline'; stage.prepend(video); });
  await page.locator('#open-login').click();
  await page.locator('#sign-out').click();
  await expect(page.locator('#avatar-list [data-avatar-id]')).toHaveCount(0);
  await expect(page.locator('#connection-pill')).toHaveText('Sign in to view provider talent');
  await expect(page.locator('#download-link')).toBeHidden();
  await expect(page.locator('#download-link')).not.toHaveAttribute('href');
  await expect(page.locator('.final-preview-media')).toHaveCount(0);
  expect(talentRequests).toBe(1);
  expect(renderRequests).toBe(0);
});
