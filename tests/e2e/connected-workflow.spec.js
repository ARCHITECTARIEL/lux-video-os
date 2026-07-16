import { expect, test } from '@playwright/test';

test('real UI preserves the project contract and submits one contained render', async ({ page }) => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  let projectBody;
  let renderBody;
  let renderRequests = 0;
  await page.route('**/api/video-os/talent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, talent: { avatars: [{ id: 'avatar-real', name: 'Avery', source: 'heygen', previewUrl: 'https://images.example/avatar.jpg' }], voices: [{ id: 'voice-real', name: 'Claire', source: 'heygen' }] }, connection: { connected: true } }) }));
  await page.route('https://images.example/avatar.jpg', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: true, email: 'redacted@example.test', account: { accountId: 'acct-demo', name: 'Contained Demo', subscription: { plan: 'Demo', status: 'contained' } }, credits: { accountId: 'acct-demo', balance: 180, reserved: 0 } }) }));
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: true, providers: [{ id: 'heygen', name: 'HeyGen', configured: true, cost: 90 }], credits: { accountId: 'acct-demo', balance: 180, reserved: 0 } }) }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results: [] }) }));
  await page.route('**/api/video-os-lite/projects', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, projects: [] }) });
    projectBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, project: { id: projectId, ...projectBody } }) });
  });
  await page.route('**/api/video-os-lite/render', async (route) => {
    renderRequests += 1;
    renderBody = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, provider: { id: 'heygen', name: 'HeyGen' }, credits: { balance: 180, reserved: 90 }, job: { id: 'job-contained' }, status: 'workflow_started' }) });
  });
  await page.route('**/api/video-os-lite/finalize', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ready: true, id: 'job-contained', status: 'ready', filename: 'final.mp4', url: '/api/video-os-lite/download?jobId=job-contained' }) }));

  await page.goto('/');
  await page.locator('input[name=title]').fill('Contained proof');
  await page.locator('input[name=audience]').fill('CEO');
  await page.locator('textarea[name=objective]').fill('Approve the controlled workflow');
  await page.locator('textarea[name=script]').fill('This is a complete contained Video OS interface proof.');
  await page.locator('[data-step-jump]').nth(1).click();
  await expect(page.locator('#avatar-list .option-card')).toHaveCount(1);
  await page.locator('[data-step-jump]').nth(2).click();
  const create = page.locator('#generate-video');
  await create.dblclick();
  await expect(page.locator('#download-link')).toHaveAttribute('href', /job-contained/);
  expect(renderRequests).toBe(1);
  expect(projectBody.avatar.id).toBe('avatar-real');
  expect(projectBody.voice.id).toBe('voice-real');
  expect(renderBody.projectId).toBe(projectId);
  expect(renderBody.avatar.avatarId).toBe('avatar-real');
  expect(renderBody.voice.voiceId).toBe('voice-real');
});
