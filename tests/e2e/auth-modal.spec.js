import { expect, test } from '@playwright/test';

const signedOut = { ok: true, signedIn: false };

const signedInSession = (overrides = {}) => ({
  ok: true,
  signedIn: true,
  email: 'proof@example.test',
  account: {
    accountId: 'proof',
    name: 'Proof workspace',
    subscription: { plan: 'Contained test', status: 'active' },
  },
  credits: { accountId: 'proof', balance: 0, reserved: 0 },
  entitlements: { fullAccess: true },
  ...overrides,
});

async function stubShell(page, initialSession = signedOut) {
  let session = initialSession;
  await page.route('**/api/video-os-lite/session', async (route) => {
    if (route.request().method() === 'POST') {
      session = signedOut;
      return route.fulfill({ json: signedOut });
    }
    return route.fulfill({ json: session });
  });
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ json: {
    ok: true,
    signedIn: session.signedIn,
    providers: [],
    credits: session.credits || { balance: 0, reserved: 0 },
    entitlements: session.entitlements || {},
  } }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({ json: { ok: true, results: [] } }));
  await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill({ json: { ok: true, identities: [], providerSubmissionEnabled: false } }));
  await page.route('**/api/video-os-lite/projects', (route) => route.fulfill({ json: { ok: true, projects: [] } }));
  await page.route('**/api/video-os/talent', (route) => route.fulfill({ json: { ok: true, talent: { avatars: [], voices: [] }, connection: { connected: false } } }));
  return { setSession(value) { session = value; } };
}

async function openAccountDialog(page) {
  await page.locator('[data-nav="account"]:visible').first().click();
  const opener = page.locator('#open-login');
  await expect(opener).toBeVisible();
  await opener.click();
  return opener;
}

test('auth dialog openers, close controls, and focus restoration work', async ({ page }) => {
  await stubShell(page);
  await page.goto('/');
  const opener = await openAccountDialog(page);
  await expect(page.locator('#auth-modal')).toBeVisible();
  await expect(page.locator('#password-username')).toBeFocused();
  await expect(page.locator('#sign-out')).toBeHidden();
  await page.locator('#close-login').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#send-magic-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#close-login')).toBeFocused();
  await page.locator('#close-login').click();
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('password errors are actionable and retry succeeds without losing credentials', async ({ page }) => {
  const shell = await stubShell(page);
  let attempts = 0;
  await page.route('**/api/video-os-lite/password-login', async (route) => {
    attempts += 1;
    if (attempts === 1) return route.abort('connectionfailed');
    const active = signedInSession({
      email: 'workspace@luxvideoos.local',
      account: { accountId: 'workspace', name: 'LUX Workspace', subscription: { plan: 'Workspace', status: 'active' } },
      credits: { accountId: 'workspace', balance: 5000, reserved: 0 },
      entitlements: { liveRendering: true },
    });
    shell.setSession(active);
    return route.fulfill({ json: { ...active, message: 'Workspace unlocked.' } });
  });
  await page.goto('/');
  await openAccountDialog(page);
  await page.locator('#password-username').fill('luxworkspace');
  await page.locator('#password-password').fill('local-only');
  await page.locator('#password-login').click();
  await expect(page.locator('#auth-status')).toContainText(/could not reach/i);
  await expect(page.locator('#auth-retry')).toBeVisible();
  await expect(page.locator('#password-username')).toHaveValue('luxworkspace');
  await page.locator('#auth-retry').click();
  await expect(page.locator('#auth-modal')).toBeHidden();
  await expect(page.locator('#account-nav-label')).toContainText('LUX Workspace');
  expect(attempts).toBe(2);
});

test('email form submits with Enter and exposes delivery failure without closing the dialog', async ({ page }) => {
  await stubShell(page);
  await page.route('**/api/video-os-lite/auth-request', (route) => route.fulfill({
    status: 502,
    json: { ok: false, code: 'email_delivery_failed', error: 'We could not send the sign-in email. Check the address and try again.' },
  }));
  await page.goto('/');
  await openAccountDialog(page);
  await page.locator('#auth-email').fill('ariel@example.test');
  await page.locator('#auth-email').press('Enter');
  await expect(page.locator('#auth-status')).toContainText('could not send');
  await expect(page.locator('#auth-retry')).toBeVisible();
  await expect(page.locator('#send-magic-link')).toBeEnabled();
  await expect(page.locator('#auth-modal')).toBeVisible();
});

test('sign-in loads authorized talent and sign-out clears it without a provider submission', async ({ page }) => {
  const shell = await stubShell(page);
  let talentRequests = 0;
  let renderRequests = 0;
  await page.route('**/api/video-os/talent', (route) => {
    talentRequests += 1;
    return route.fulfill({ json: {
      ok: true,
      talent: {
        avatars: [{ id: 'featured:ariel', name: 'Ariel', source: 'heygen', featuredKey: 'ariel', matchedVoiceId: 'featured:ariel:voice', active: true, providerReady: true, previewUrl: 'https://images.example/ariel.svg' }],
        voices: [{ id: 'featured:ariel:voice', name: 'Ariel voice', source: 'heygen', featuredKey: 'ariel', active: true, providerReady: true }],
      },
      connection: { connected: true, status: 'connected' },
    } });
  });
  await page.route('https://images.example/ariel.svg', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
  }));
  await page.route('**/api/video-os-lite/render', (route) => {
    renderRequests += 1;
    return route.abort('blockedbyclient');
  });
  await page.route('**/api/video-os-lite/password-login', (route) => {
    const active = signedInSession();
    shell.setSession(active);
    return route.fulfill({ json: { ...active, message: 'Signed in.' } });
  });

  await page.goto('/');
  expect(talentRequests).toBe(0);
  await openAccountDialog(page);
  await page.locator('#password-username').fill('proof');
  await page.locator('#password-password').fill('local-only');
  await page.locator('#password-login').click();
  await page.locator('[data-nav="create"]:visible').first().click();
  await page.locator('#premium-tab').click();
  await expect(page.locator('[data-avatar-id="featured:ariel"]')).toHaveCount(1);
  expect(talentRequests).toBe(1);

  await page.locator('[data-nav="account"]:visible').first().click();
  await expect(page.locator('#open-login')).toHaveText('Manage session');
  await page.locator('#open-login').click();
  await page.locator('#sign-out').click();
  await expect(page.locator('#featured-cast-list [data-avatar-id]')).toHaveCount(0);
  await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
  await expect(page.locator('#download-link')).toBeHidden();
  await expect(page.locator('#download-link')).not.toHaveAttribute('href');
  await expect(page.locator('#accepted-video')).toBeHidden();
  expect(talentRequests).toBe(1);
  expect(renderRequests).toBe(0);
});
