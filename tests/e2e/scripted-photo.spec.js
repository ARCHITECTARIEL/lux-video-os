import { expect, test } from '@playwright/test';

const READY_ID = '11111111-1111-4111-8111-111111111111';
const WAITING_ID = '22222222-2222-4222-8222-222222222222';

const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, options = {}) {
  const calls = { saves: [], quotes: [], renders: [], recoveries: [], recoveryQueries: [] };
  const results = [];
  const identities = options.identities || [
    { id: READY_ID, displayName: 'Ready owner', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, archivedAt: null },
    { id: WAITING_ID, displayName: 'Still processing', overallStatus: 'PROCESSING', avatarStatus: 'READY', voiceStatus: 'PROCESSING', ready: false, archivedAt: null },
  ];
  const capabilities = options.capabilities || {
    enabled: true,
    tiers: {
      STANDARD: { available: true, credits: 37, reasons: [] },
      PREMIUM: { available: true, credits: 90, reasons: [] },
    },
  };
  let quoteCount = 0;
  let renderCount = 0;

  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, route => route.abort('blockedbyclient'));
  await page.route('**/api/video-os-lite/session', route => reply(route, {
    ok: true, signedIn: true, email: 'owner@example.test',
    account: { accountId: 'fixture-owner', name: 'Fixture owner', subscription: { plan: 'Video OS', status: 'contained' } },
    credits: { accountId: 'fixture-owner', balance: 500, reserved: 0 }, entitlements: { fullAccess: true },
  }));
  await page.route('**/api/video-os-lite/identities*', route => reply(route, { ok: true, identities, providerSubmissionEnabled: false }));
  await page.route('**/api/video-os-lite/projects*', route => reply(route, { ok: true, projects: [] }));
  await page.route('**/api/video-os-lite/results*', route => reply(route, { ok: true, results }));
  await page.route('**/api/video-os-lite/copywriter*', route => reply(route, { ok: true, available: false }));
  await page.route('**/api/video-os-lite/scripted-photo*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const key = url.searchParams.get('idempotencyKey');
      if (key) {
        calls.recoveries.push(key);
        calls.recoveryQueries.push(Object.fromEntries(url.searchParams));
      }
      const existingJob = key ? (await options.recover?.({ key, calls })) || null : null;
      return reply(route, {
        ok: true,
        contractVersion: 'scripted-photo-v1', pricingVersion: 'scripted-photo-pricing-v1', quoteTtlSeconds: 300,
        capabilities, existingJob,
      });
    }
    const body = request.postDataJSON();
    if (body.action === 'save-project') {
      calls.saves.push(body);
      return reply(route, { ok: true, project: { id: body.projectId, identityId: body.identityId, title: body.title, script: body.script, tier: body.tier, format: body.format, contractVersion: body.contractVersion } });
    }
    if (body.action === 'quote') {
      calls.quotes.push(body);
      quoteCount += 1;
      const recovered = await options.quoteExisting?.({ body, quoteCount, calls });
      if (recovered) return reply(route, { ok: true, recovered: true, quote: null, project: null, existingJob: recovered });
      const credits = capabilities.tiers[body.tier].credits;
      const quote = options.quote?.({ body, quoteCount, credits }) || {
        token: `quote-token-${body.tier.toLowerCase()}-${quoteCount}`,
        credits,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        pricingVersion: 'scripted-photo-pricing-v1',
      };
      const saved = [...calls.saves].reverse().find(item => item.projectId === body.projectId);
      return reply(route, { ok: true, quote, project: { id: body.projectId, identityId: saved.identityId, title: saved.title, script: saved.script, tier: body.tier, format: body.format, contractVersion: 'scripted-photo-v1' } }, 201);
    }
    return reply(route, { ok: false, code: 'invalid_request', error: 'Invalid request.' }, 400);
  });
  await page.route('**/api/video-os-lite/render-v2', async route => {
    const body = route.request().postDataJSON();
    calls.renders.push(body);
    renderCount += 1;
    if (options.render) return options.render({ route, body, renderCount, calls, results });
    const job = { id: `job-${body.tier.toLowerCase()}-${renderCount}`, title: body.title, tier: body.tier.toLowerCase(), status: 'workflow_started', stage: 'workflow_started', outputAccepted: false, format: body.format };
    results.unshift(job);
    return reply(route, { ok: true, job }, 202);
  });

  await page.goto('/#create');
  await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-in');
  return calls;
}

async function prepareTier(page, tier, { title, script, format = 'vertical' }) {
  const standard = tier === 'STANDARD';
  if (!standard) await page.locator('#premium-tab').click();
  await page.locator(standard ? '#standard-scripted-title' : '#premium-title').fill(title);
  await page.locator(standard ? '#standard-scripted-script' : '#script-input').fill(script);
  await page.locator(standard ? `[data-scripted-standard-identity-id="${READY_ID}"]` : `[data-premium-identity-id="${READY_ID}"]`).click();
  await page.locator(standard ? '#standard-scripted-format' : '#export-format').selectOption(format);
  await expect(page.locator(standard ? '#standard-scripted-submit' : '#generate-video')).toBeEnabled();
}

test('Standard uses strict saved-project, quote and render reference payloads with server price confirmation', async ({ page }) => {
  const calls = await setup(page);
  await prepareTier(page, 'STANDARD', { title: 'Standard owner update', script: 'This exact Standard script uses the enrolled presenter.', format: 'square' });
  await page.locator('#standard-scripted-submit').click();
  await expect(page.locator('#scripted-photo-quote-dialog')).toBeVisible();
  await expect(page.locator('#scripted-photo-quote-summary')).toContainText('37 credits');
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect.poll(() => calls.renders.length).toBe(1);

  expect(calls.saves[0]).toEqual({ action: 'save-project', contractVersion: 'scripted-photo-v1', projectId: expect.any(String), tier: 'STANDARD', title: 'Standard owner update', script: 'This exact Standard script uses the enrolled presenter.', identityId: READY_ID, format: 'square' });
  expect(calls.quotes[0]).toEqual({ action: 'quote', projectId: calls.saves[0].projectId, tier: 'STANDARD', format: 'square', idempotencyKey: expect.any(String) });
  expect(calls.quotes[0].idempotencyKey).toBe(calls.renders[0].idempotencyKey);
  expect(calls.renders[0]).toEqual({ contractVersion: 'scripted-photo-v1', tier: 'STANDARD', title: calls.saves[0].title, script: calls.saves[0].script, identityId: READY_ID, format: 'square', projectId: calls.saves[0].projectId, idempotencyKey: expect.any(String), quoteToken: 'quote-token-standard-1' });
  expect(calls.renders[0]).not.toHaveProperty('provider');
  expect(calls.renders[0]).not.toHaveProperty('costCredits');
  expect(calls.renders[0]).not.toHaveProperty('productionKit');
  await expect(page.locator('#standard-scripted-status')).toContainText(/accepted|My Videos/i);
});

test('tier switching preserves separate drafts and Premium hides unsupported controls with honest copy', async ({ page }) => {
  const calls = await setup(page);
  await page.locator('#standard-scripted-title').fill('Standard draft');
  await page.locator('#standard-scripted-script').fill('Standard words stay here.');
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('Premium draft');
  await page.locator('#script-input').fill('Premium words stay separate.');
  await page.locator(`[data-premium-identity-id="${READY_ID}"]`).click();
  await expect(page.locator('.contract-limit-note').filter({ hasText: 'Backgrounds, layouts' })).toBeVisible();
  await expect(page.locator('#premium-composition-enabled')).toBeHidden();
  await expect(page.locator('#studio-preview-card')).toBeHidden();
  await page.locator('#standard-tab').click();
  await expect(page.locator('#standard-scripted-title')).toHaveValue('Standard draft');
  await expect(page.locator('#standard-scripted-script')).toHaveValue('Standard words stay here.');
  await page.locator('#premium-tab').click();
  await expect(page.locator('#premium-title')).toHaveValue('Premium draft');
  await expect(page.locator('#script-input')).toHaveValue('Premium words stay separate.');
  await page.locator('#generate-video').click();
  await expect(page.locator('#scripted-photo-quote-summary')).toContainText('90 credits');
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect.poll(() => calls.renders.length).toBe(1);
  expect(calls.renders[0].tier).toBe('PREMIUM');
  expect(calls.renders[0]).not.toHaveProperty('productionKit');
});

test('cross-tier availability and identity readiness fail closed without erasing drafts', async ({ page }) => {
  await setup(page, { capabilities: { enabled: true, tiers: { STANDARD: { available: true, credits: 37, reasons: [] }, PREMIUM: { available: false, credits: 90, reasons: ['feature_disabled'] } } } });
  await expect(page.locator(`[data-scripted-standard-identity-id="${WAITING_ID}"]`)).toBeDisabled();
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('Unavailable premium draft');
  await page.locator('#script-input').fill('This draft remains editable while rendering is unavailable.');
  await page.locator(`[data-premium-identity-id="${READY_ID}"]`).click();
  await expect(page.locator('#generate-video')).toBeDisabled();
  await expect(page.locator('#premium-status')).toContainText(/not enabled|not currently available/i);
  await expect(page.locator('#script-input')).toHaveValue('This draft remains editable while rendering is unavailable.');
  await page.locator('#standard-tab').click();
  await expect(page.locator('#standard-scripted-price')).toHaveText('37 credits');
});

test('editing an exact intent invalidates its quote and expired requotes preserve a usable request', async ({ page }) => {
  const calls = await setup(page, {
    quote: ({ body, quoteCount, credits }) => ({ token: `quote-${quoteCount}`, credits, expiresAt: quoteCount === 1 ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 300_000).toISOString(), pricingVersion: 'scripted-photo-pricing-v1' }),
  });
  await prepareTier(page, 'STANDARD', { title: 'Expiry proof', script: 'The first quote is already expired.' });
  await page.locator('#standard-scripted-submit').click();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect(page.locator('#scripted-photo-quote-error')).toContainText(/expired/i);
  expect(calls.renders).toHaveLength(0);
  await page.locator('#scripted-photo-requote').click();
  await expect(page.locator('#scripted-photo-quote-dialog')).toBeVisible();
  await page.locator('[data-scripted-quote-close]').first().click();
  await page.locator('#standard-scripted-script').fill('Editing this script invalidates every earlier token.');
  await page.locator('#standard-scripted-submit').click();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect.poll(() => calls.renders.length).toBe(1);
  expect(calls.quotes).toHaveLength(3);
  expect(calls.quotes[1].idempotencyKey).toBe(calls.quotes[0].idempotencyKey);
  expect(calls.quotes[2].idempotencyKey).not.toBe(calls.quotes[0].idempotencyKey);
  expect(calls.renders[0].script).toBe('Editing this script invalidates every earlier token.');
  expect(calls.renders[0].quoteToken).toBe('quote-3');
});

test('uncertain submission performs read-only recovery and retries with the same idempotency key', async ({ page }) => {
  const calls = await setup(page, {
    render: ({ route, body, renderCount, results }) => {
      if (renderCount === 1) return route.abort('failed');
      const job = { id: 'job-recovered-retry', title: body.title, tier: 'standard', status: 'workflow_started', outputAccepted: false, format: body.format };
      results.unshift(job);
      return reply(route, { ok: true, job }, 202);
    },
  });
  await prepareTier(page, 'STANDARD', { title: 'Uncertain request', script: 'Retry this exact request only after read-only recovery.' });
  await page.locator('#standard-scripted-submit').click();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect(page.locator('#standard-scripted-recovery')).toBeVisible();
  await page.reload();
  await expect(page.locator('#standard-scripted-recovery')).toBeVisible();
  await expect(page.locator('#standard-scripted-title')).toHaveValue('Uncertain request');
  await expect(page.locator('#standard-scripted-script')).toHaveValue('Retry this exact request only after read-only recovery.');
  await page.locator('#standard-scripted-check').click();
  await expect(page.locator('#standard-scripted-retry')).toBeEnabled();
  await page.locator('#standard-scripted-retry').click();
  await expect(page.locator('#scripted-photo-quote-dialog')).toBeVisible();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect.poll(() => calls.renders.length).toBe(2);
  expect(calls.recoveries.length).toBeGreaterThanOrEqual(2);
  expect(new Set(calls.recoveries)).toEqual(new Set([calls.renders[0].idempotencyKey]));
  expect(calls.recoveryQueries[0]).toEqual({ contractVersion: 'scripted-photo-v1', projectId: calls.saves[0].projectId, tier: 'STANDARD', idempotencyKey: calls.renders[0].idempotencyKey });
  expect(calls.renders[1].idempotencyKey).toBe(calls.renders[0].idempotencyKey);
  await expect(page.locator('#standard-scripted-recovery')).toBeHidden();
});

test('read-only recovery returns an existing job without a second render submission', async ({ page }) => {
  let firstKey;
  const calls = await setup(page, {
    render: ({ route, body }) => { firstKey = body.idempotencyKey; return route.abort('failed'); },
    recover: ({ key }) => key === firstKey ? { id: 'job-existing', title: 'Recovered', tier: 'standard', status: 'workflow_started', outputAccepted: false, format: 'vertical' } : null,
  });
  await prepareTier(page, 'STANDARD', { title: 'Recover me', script: 'The server already owns this same request.' });
  await page.locator('#standard-scripted-submit').click();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect(page.locator('#standard-scripted-recovery')).toBeVisible();
  await page.locator('#standard-scripted-check').click();
  await expect(page.locator('#standard-scripted-recovery')).toBeHidden();
  expect(calls.renders).toHaveLength(1);
  await expect(page.locator('#standard-scripted-status')).toContainText(/existing render|My Videos/i);
});

test('quote replay returns the existing exact-intent job without issuing a new quote or render', async ({ page }) => {
  const existingJob = { id: 'job-quote-replay', title: 'Already accepted', tier: 'standard', status: 'workflow_started', outputAccepted: false, format: 'vertical' };
  const calls = await setup(page, { quoteExisting: async () => existingJob });
  await prepareTier(page, 'STANDARD', { title: 'Already accepted', script: 'This same request already has a durable job.' });
  await page.locator('#standard-scripted-submit').click();
  await expect(page.locator('#scripted-photo-quote-dialog')).toBeHidden();
  await expect(page.locator('#standard-scripted-status')).toContainText(/existing render|My Videos/i);
  expect(calls.quotes).toHaveLength(1);
  expect(calls.renders).toHaveLength(0);
});

test('shared scripted form fits a narrow mobile viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.locator('#scripted-standard-form')).toBeVisible();
  const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.viewport);
  const button = await page.locator('#standard-scripted-submit').boundingBox();
  expect(button.height).toBeGreaterThanOrEqual(44);
});
