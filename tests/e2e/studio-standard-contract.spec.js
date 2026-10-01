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
