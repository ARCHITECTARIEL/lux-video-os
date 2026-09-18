import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function setup(page, outcome = 'success') {
  const writes = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') { writes.push(url.pathname); return route.abort(); }
      if (url.pathname.endsWith('/download')) {
        return route.continue();
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: false }) });
    }
    return route.continue();
  });
  await page.goto(`/?fixture=standard-contract&fixture-outcome=${outcome}`);
  await page.locator('#use-fixture-portrait').click();
  await page.locator('#use-fixture-audio').click();
  await page.locator('#video-title').fill('Contract proof');
  await page.locator('#standard-permission').check();
  await page.locator('#review-inputs').click();
  await page.locator('#review-complete').click();
  return writes;
}

test('contract uncertainty recovers, queues, retrieves accepted library, plays and downloads synthetic MP4', async ({ page }) => {
  const writes = await setup(page, 'uncertain');
  const submit = page.locator('#standard-submit');
  await submit.click();
  await expect(submit).toHaveText('Recover uncertain fixture submission');
  await expect(page.locator('#video-title')).toBeDisabled();
  await submit.click();
  await expect(page.locator('#standard-status')).toHaveAttribute('data-state', 'QUEUED');
  for (const status of ['QUEUED', 'PROCESSING', 'SUCCEEDED']) {
    await submit.click();
    await expect(page.locator('#standard-status')).toHaveAttribute('data-state', status);
  }
  await page.locator('[data-nav="videos"]:visible').first().click();
  await expect(page.locator('[data-job-id="fixture-standard-001"]')).toHaveAttribute('data-job-state', 'SUCCEEDED');
  await page.locator('.result-preview-action').click();
  const video = page.locator('#accepted-video');
  await expect(video).toBeVisible();
  await video.evaluate(el => el.play());
  await expect.poll(() => video.evaluate(el => el.currentTime)).toBeGreaterThan(0);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  expect((await readFile(await download.path())).length).toBeGreaterThan(100);
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'test-results/standard-contract-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/standard-contract-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});

test('signed-in Studio uses the actual Standard API contract and recovers the identical render request', async ({ page }) => {
  const identityId = '11111111-1111-4111-8111-111111111111';
  const audioAssetId = '22222222-2222-4222-8222-222222222222';
  const projectId = '33333333-3333-4333-8333-333333333333';
  const consentId = '44444444-4444-4444-8444-444444444444';
  const quoteId = '55555555-5555-4555-8555-555555555555';
  const captured = { upload: null, project: null, consent: null, quote: null, renders: [] };
  let readinessChecks = 0;
  let jobSubmitted = false;
  const reply = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/video-os-lite/session', route => route.fulfill(reply({
    ok: true, signedIn: true, email: 'owner@example.test',
    account: { accountId: 'owner-account', name: 'Owner', subscription: { plan: 'Owner', status: 'active' } },
    credits: { balance: 500, reserved: 0 }, entitlements: { ownerAccess: true },
  })));
  await page.route('**/api/video-os-lite/providers', route => route.fulfill(reply({ ok: true, providers: [], credits: { balance: 500 }, entitlements: { ownerAccess: true } })));
  await page.route('**/api/video-os/talent', route => route.fulfill(reply({ ok: true, talent: { avatars: [], voices: [] }, connection: { connected: false } })));
  await page.route('**/api/video-os-lite/identities*', route => route.fulfill(reply({ ok: true, identities: [{ id: identityId, displayName: 'Authorized Owner', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, portraitUrl: '' }] })));
  await page.route('**/api/video-os-lite/projects', route => {
    if (route.request().method() === 'GET') return route.fulfill(reply({ ok: true, projects: [] }));
    captured.project = route.request().postDataJSON();
    return route.fulfill(reply({ ok: true, project: { id: projectId } }, 201));
  });
  await page.route('**/api/video-os-lite/uploads', route => {
    captured.upload = route.request().postDataJSON();
    return route.fulfill(reply({ ok: true, assetId: audioAssetId }, 201));
  });
  await page.route('**/api/video-os-lite/standard*', route => {
    if (route.request().method() === 'GET') {
      readinessChecks += 1;
      return route.fulfill(reply({ ok: true, readiness: readinessChecks === 1
        ? { ready: false, reasonCode: 'standard_narration_consent_required' }
        : { ready: true, reasonCode: null } }));
    }
    const body = route.request().postDataJSON();
    if (body.operation === 'consent') {
      captured.consent = body;
      return route.fulfill(reply({ ok: true, consent: { id: consentId, projectId, identityId, audioAssetId, policyVersion: 'standard-narration-consent-v1-proposed', revokedAt: null } }, 201));
    }
    captured.quote = body;
    return route.fulfill(reply({ ok: true, quote: { id: quoteId, contractVersion: 'standard-narration-v1', projectId, identityId, audioAssetId, narrationConsentId: consentId, format: 'vertical', credits: 90 } }, 201));
  });
  await page.route('**/api/video-os-lite/render', route => {
    captured.renders.push(route.request().postDataJSON());
    if (captured.renders.length === 1) return route.abort('connectionfailed');
    jobSubmitted = true;
    return route.fulfill(reply({ ok: true, job: { id: 'standard-owner-job', title: 'Owner contract proof', tier: 'standard', status: 'QUEUED', outputAccepted: false } }, 202));
  });
  await page.route('**/api/video-os-lite/results*', route => route.fulfill(reply({ ok: true, results: jobSubmitted ? [
    { id: 'standard-owner-job', title: 'Owner contract proof', tier: 'standard', status: 'SUCCEEDED', outputAccepted: true, url: '/api/video-os-lite/download?jobId=standard-owner-job', filename: 'owner.mp4' },
    { id: 'unaccepted-owner-job', title: 'Not accepted', tier: 'standard', status: 'SUCCEEDED', outputAccepted: false, url: '/unsafe.mp4' },
  ] : [] })));

  const wav = Buffer.alloc(44 + 16000 * 2 * 5);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

  await page.goto('/#create');
  await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-in');
  await page.locator(`[data-standard-identity-id="${identityId}"]`).click();
  await page.locator('#standard-audio-file').setInputFiles({ name: 'owner.wav', mimeType: 'audio/wav', buffer: wav });
  await page.locator('#video-title').fill('Owner contract proof');
  await page.locator('#standard-permission').check();
  await page.locator('#review-inputs').click();
  await page.locator('#review-complete').click();
  await page.locator('#standard-submit').click();
  await expect(page.locator('#standard-submit')).toHaveText('Recover uncertain Standard submission');
  await page.locator('#standard-submit').click();
  await expect(page.locator('#standard-status')).toHaveAttribute('data-state', 'QUEUED');

  expect(captured.upload.kind).toBe('identity_voice');
  expect(captured.upload.name).toBe('owner.wav');
  expect(captured.project).toEqual({ tier: 'STANDARD', contractVersion: 'standard-narration-v1', title: 'Owner contract proof', identityId, narrationAudioAssetId: audioAssetId });
  expect(captured.consent).toMatchObject({ operation: 'consent', contractVersion: 'standard-narration-v1', projectId, identityId, audioAssetId, policyVersion: 'standard-narration-consent-v1-proposed', consent: true });
  expect(captured.quote).toEqual({ operation: 'quote', contractVersion: 'standard-narration-v1', projectId, identityId, audioAssetId, narrationConsentId: consentId, format: 'vertical' });
  expect(captured.renders).toHaveLength(2);
  expect(captured.renders[1]).toEqual(captured.renders[0]);
  expect(Object.keys(captured.renders[0]).sort()).toEqual(['audioReference', 'contractVersion', 'format', 'idempotencyKey', 'identityId', 'narrationConsentId', 'projectId', 'quoteId', 'tier', 'title'].sort());

  await page.locator('#standard-submit').click();
  await expect(page.locator('#standard-submit')).toHaveText('View accepted video in My Videos');
  await page.locator('[data-nav="videos"]:visible').first().click();
  await expect(page.locator('.result-preview-action')).toHaveCount(1);
  await expect(page.locator('video[src*="unsafe"], a[href*="unsafe"]')).toHaveCount(0);
});

for (const [outcome, message] of [['consent', /consent does not authorize/], ['unavailable', /rendering is disabled/]]) {
  test(`${outcome} fails closed without network mutation or output`, async ({ page }) => {
    const writes = await setup(page, outcome);
    await page.locator('#standard-submit').click();
    await expect(page.locator('#standard-status')).toContainText(message);
    await expect(page.locator('#standard-submit')).toBeDisabled();
    await expect(page.locator('#download-link')).toBeHidden();
    expect(writes).toEqual([]);
  });
}

test('invalid WAV length and missing permission prevent review; raw success remains unavailable', async ({ page }) => {
  await setup(page, 'unaccepted');
  const wav = await readFile('public/assets/studio/fixture-audio.wav');
  await page.locator('#standard-audio-file').setInputFiles({ name: 'truncated.wav', mimeType: 'audio/wav', buffer: wav.subarray(0, 100) });
  await expect(page.locator('#audio-error')).toContainText(/truncated|length/);
  await page.locator('#use-fixture-audio').click();
  await page.locator('#review-inputs').click();
  await expect(page.locator('#permission-error')).toBeVisible();
  await page.locator('#standard-permission').check();
  await page.locator('#review-inputs').click();
  await page.locator('#review-complete').click();
  for (let i = 0; i < 4; i++) {
    await page.locator('#standard-submit').click();
    await expect(page.locator('#standard-submit')).toBeEnabled();
  }
  await expect(page.locator('#standard-status')).toContainText('acceptance pending');
  await expect(page.locator('#download-link')).toBeHidden();
});
