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
