import { expect, test } from '@playwright/test';

const account = { ok: true, signedIn: true, email: 'owner@example.com', account: { accountId: 'owner-a', name: 'Owner' } };
const draft = {
  id: '4eb35c45-8427-4237-b098-d5485b8b7808', displayName: 'Owner Studio', overallStatus: 'DRAFT', avatarStatus: 'DRAFT', voiceStatus: 'DRAFT',
  portraitUrl: '/portrait.png', voicePreviewUrl: null, createdAt: '2026-07-17T12:00:00.000Z', updatedAt: '2026-07-17T12:00:00.000Z', archivedAt: null, ready: false,
};

async function identityApi(page, { enabled = false, initial = [] } = {}) {
  let identities = [...initial];
  const calls = [];
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/uploads', async (route) => {
    const body = route.request().postDataJSON(); calls.push(body.kind);
    await route.fulfill({ status: 201, json: { ok: true, assetId: body.kind === 'identity_photo' ? '9ba00bd4-81b7-40ad-a28b-b625c33242e3' : 'aefca12d-a7eb-4833-bb66-e48b53e4fc42', previewUrl: '/private-asset' } });
  });
  await page.route('**/api/video-os-lite/identities*', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, identities, providerSubmissionEnabled: enabled } });
    const body = route.request().postDataJSON(); calls.push(body.action + (body.component ? `:${body.component}` : ''));
    if (body.action === 'create') identities = [{ ...draft, displayName: body.displayName }];
    if (body.action === 'retry') identities = identities.map((item) => ({ ...item, overallStatus: 'PROCESSING', [`${body.component}Status`]: 'PROCESSING', [`${body.component}Failure`]: null }));
    if (body.action === 'refresh') identities = identities.map((item) => ({ ...item, overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, voicePreviewUrl: `/api/video-os-lite/identities?voicePreview=${item.id}` }));
    if (body.action === 'archive') identities = identities.filter((item) => item.id !== body.identityId);
    return route.fulfill({ json: { ok: true, identity: identities[0] || { ...draft, archivedAt: new Date().toISOString() } } });
  });
  await page.route('**/portrait.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from([137, 80, 78, 71]) }));
  return { calls, identities: () => identities };
}

test('Identity Studio requires the existing authenticated workspace session', async ({ page }) => {
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ status: 401, json: { ok: false, error: 'Sign in to render videos.' } }));
  await page.goto('/identity.html');
  await expect(page.getByRole('heading', { name: 'Sign in to open your Identity Studio.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to secure sign in' })).toHaveAttribute('href', '/?signin=1');
});

test('photo, voice, and all four consents create a durable held identity without provider mutation', async ({ page }) => {
  const mock = await identityApi(page, { enabled: false });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Create Identity' }).click();
  await page.locator('#photo-input').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 1]) });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#voice-input').setInputFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVE') });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#identity-name').fill('Owner Studio');
  for (const selector of ['#consent-face', '#consent-voice', '#consent-process']) {
    await page.locator(selector).check();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#notice')).toContainText('All four authorizations are required.');
  await page.locator('#consent-archive').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#notice')).toContainText('Identity draft and consent saved.');
  await expect(page.getByRole('heading', { name: 'Owner Studio' })).toBeVisible();
  expect(mock.calls).toEqual(['identity_photo', 'identity_voice', 'create', 'consent']);
  await expect(page.getByRole('button', { name: 'Start creation' })).toBeDisabled();
});

test('processing resumes after refresh and stops at ready with authenticated voice preview', async ({ page }) => {
  await page.clock.install();
  const processing = { ...draft, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING', voiceStatus: 'PROCESSING' };
  const mock = await identityApi(page, { enabled: true, initial: [processing] });
  await page.goto('/identity.html');
  await expect(page.getByText('Processing').first()).toBeVisible();
  await page.clock.fastForward(8_500);
  await expect(page.getByText('Ready').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use in Video OS' })).toHaveAttribute('href', `/?identityId=${draft.id}`);
  expect(mock.calls).toContain('refresh');
  await page.getByRole('button', { name: 'Preview voice' }).click();
  await expect(page.locator('.identity-card audio')).toHaveAttribute('src', new RegExp('voicePreview'));
});

test('partial failure retries only the failed component and archive removes it from My Cast', async ({ page }) => {
  const failed = { ...draft, overallStatus: 'PARTIAL_FAILURE', avatarStatus: 'READY', voiceStatus: 'FAILED', voiceFailure: { code: 'PROVIDER_REJECTED', message: 'This voice could not be created.' } };
  const mock = await identityApi(page, { enabled: true, initial: [failed] });
  await page.goto('/identity.html');
  await page.getByRole('button', { name: 'Retry voice' }).click();
  expect(mock.calls).toContain('retry:voice');
  expect(mock.calls).not.toContain('retry:avatar');
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('heading', { name: 'Owner Studio' })).toHaveCount(0);
});

test('invalid photo and voice files expose focused field errors without an upload request', async ({ page }) => {
  const mock = await identityApi(page, { enabled: false });
  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();

  const photo = page.locator('#photo-input');
  await photo.setInputFiles({ name: 'portrait.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(photo).toHaveAttribute('aria-invalid', 'true');
  await expect(photo).toBeFocused();
  await expect(page.locator('#photo-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#photo-error')).not.toBeEmpty();

  await photo.setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 1]) });
  await page.locator('#next-button').click();
  const voice = page.locator('#voice-input');
  await voice.setInputFiles({ name: 'voice.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  await expect(voice).toHaveAttribute('aria-invalid', 'true');
  await expect(voice).toBeFocused();
  await expect(page.locator('#voice-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#voice-error')).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wizard')).toBeHidden();
  await expect(page.locator('#notice')).toBeHidden();
  expect(mock.calls).toEqual([]);
});

test('identity wizard traps keyboard focus, closes with Escape, and returns to its opener', async ({ page }) => {
  await identityApi(page, { enabled: false });
  await page.goto('/identity.html');
  const opener = page.locator('#empty-create-button');
  await opener.click();
  const wizard = page.locator('#wizard');
  await expect(wizard).toBeVisible();
  await expect(page.locator('#photo-input')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#close-wizard')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#next-button')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
  await expect(opener).toBeFocused();
});

test('mobile identity navigation is named, modal, and restores focus when dismissed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await identityApi(page, { enabled: false });
  await page.goto('/identity.html');
  const opener = page.locator('#open-menu');
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAccessibleName(/menu/i);
  await opener.click();

  const menu = page.locator('#mobile-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: 'My identities' })).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('link', { name: 'Create video' })).toHaveAttribute('href', '/#create');
  await expect(menu.getByRole('link', { name: 'AI Copywriter' })).toHaveAttribute('href', '/#copywriter');
  await expect(menu.getByRole('link', { name: 'My Videos' })).toHaveAttribute('href', '/#videos');
  await expect(menu.getByRole('link', { name: 'Create video' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#close-menu')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();
});

test('identity loading failure offers a retry and never substitutes an empty private workspace', async ({ page }) => {
  let identityReads = 0;
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/identities*', (route) => {
    identityReads += 1;
    if (identityReads === 1) return route.abort('connectionfailed');
    return route.fulfill({ json: { ok: true, identities: [], providerSubmissionEnabled: false } });
  });
  await page.goto('/identity.html');

  await expect(page.locator('#load-error')).toBeVisible();
  await expect(page.locator('#studio')).toBeHidden();
  await expect(page.locator('#notice')).toHaveAttribute('role', 'alert');
  await page.locator('#retry-load').click();
  await expect(page.locator('#studio')).toBeVisible();
  await expect(page.locator('#empty-state')).toBeVisible();
  expect(identityReads).toBe(2);
});

test('a stalled identity session read reaches the bounded timeout and actionable error state', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/video-os-lite/session') {
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      return originalFetch(input, options);
    };
  });
  await page.goto('/identity.html');
  await expect(page.locator('#loading-state')).toBeVisible();

  await page.clock.fastForward(30_010);
  await expect(page.locator('#loading-state')).toBeHidden();
  await expect(page.locator('#load-error')).toBeVisible();
  await expect(page.locator('#notice')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#notice')).toContainText('request took too long');
  await expect(page.locator('#retry-load')).toBeVisible();
});

test('an uncertain identity create locks the wizard until My Identities is checked', async ({ page }) => {
  let createAttempts = 0;
  let created = null;
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/uploads', async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { ok: true, assetId: body.kind === 'identity_photo' ? '9ba00bd4-81b7-40ad-a28b-b625c33242e3' : 'aefca12d-a7eb-4833-bb66-e48b53e4fc42' } });
  });
  await page.route('**/api/video-os-lite/identities*', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, identities: created ? [created] : [], providerSubmissionEnabled: false } });
    const body = route.request().postDataJSON();
    if (body.action === 'create') {
      createAttempts += 1;
      created = { ...draft, id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', displayName: body.displayName };
      return route.abort('connectionfailed');
    }
    return route.fulfill({ json: { ok: true, identity: created } });
  });

  await page.goto('/identity.html');
  await page.locator('#empty-create-button').click();
  await page.locator('#photo-input').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 1]) });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#voice-input').setInputFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVE') });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#identity-name').fill('Recovered Identity');
  for (const selector of ['#consent-face', '#consent-voice', '#consent-process', '#consent-archive']) await page.locator(selector).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('#commit-uncertain')).toBeVisible();
  await expect(page.locator('#next-button')).toBeDisabled();
  expect(createAttempts).toBe(1);

  await page.getByRole('button', { name: 'Check My Identities' }).click();
  await expect(page.locator('#commit-uncertain')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Recovered Identity' })).toBeVisible();
  expect(createAttempts).toBe(1);
});

test('polling stops after 45 rounds and offers a manual resume', async ({ page }) => {
  await page.clock.install();
  let refreshCount = 0;
  const processing = { ...draft, overallStatus: 'PROCESSING', avatarStatus: 'PROCESSING', voiceStatus: 'PROCESSING' };
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: account }));
  await page.route('**/api/video-os-lite/identities*', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, identities: [processing], providerSubmissionEnabled: true } });
    const body = route.request().postDataJSON();
    if (body.action === 'refresh') refreshCount += 1;
    return route.fulfill({ json: { ok: true, identity: processing } });
  });
  await page.goto('/identity.html');
  await expect(page.getByText('Processing').first()).toBeVisible();
  await expect(page.locator('#polling-exhausted')).toBeHidden();

  for (let round = 0; round < 45; round++) {
    await page.clock.fastForward(8_000);
    await page.waitForTimeout(20);
  }
  await expect(page.locator('#polling-exhausted')).toBeVisible({ timeout: 2000 });
  await expect.poll(() => refreshCount).toBe(45);

  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('#polling-exhausted')).toBeHidden();
  await page.clock.fastForward(8_500);
  await expect.poll(() => refreshCount).toBe(46);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'desktop-boundary', width: 1024, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'narrow phone', width: 320, height: 720 },
]) {
  test(`identity wizard does not clip its ${viewport.name} step tracker`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await identityApi(page, { enabled: false });
    await page.goto('/identity.html');
    await page.locator('#empty-create-button').click();

    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('#wizard');
      const steps = document.querySelector('#wizard .steps');
      const dialogRect = dialog.getBoundingClientRect();
      const stepsRect = steps.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
        dialogClientWidth: dialog.clientWidth,
        dialogScrollWidth: dialog.scrollWidth,
        stepsLeft: stepsRect.left,
        stepsRight: stepsRect.right,
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.dialogLeft).toBeGreaterThanOrEqual(-1);
    expect(layout.dialogRight).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.dialogScrollWidth).toBeLessThanOrEqual(layout.dialogClientWidth + 1);
    expect(layout.stepsLeft).toBeGreaterThanOrEqual(layout.dialogLeft - 1);
    expect(layout.stepsRight).toBeLessThanOrEqual(layout.dialogRight + 1);
  });
}
