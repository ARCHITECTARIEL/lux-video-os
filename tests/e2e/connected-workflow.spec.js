import { expect, test } from '@playwright/test';

const projectIdPattern = /^[0-9a-f-]{36}$/i;
const identityId = '4c2f26b6-cdd4-4d53-8e37-17e7858c679c';
const identity = { id: identityId, displayName: 'Authorized Premium identity', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', ready: true, archivedAt: null };
const session = { ok: true, signedIn: true, email: 'redacted@example.test', account: { accountId: 'acct-demo', name: 'Contained Demo', subscription: { plan: 'Demo', status: 'contained' } }, credits: { accountId: 'acct-demo', balance: 180, reserved: 0 }, entitlements: { fullAccess: true } };

async function installPremiumRoutes(page, renderHandler, { available = true } = {}) {
  let projectBody;
  const quoteBodies = [];
  const renderBodies = [];
  const recoveryKeys = [];
  const results = [];
  await page.route('**/api/video-os-lite/session', route => route.fulfill({ json: session }));
  await page.route('**/api/video-os-lite/identities*', route => route.fulfill({ json: { ok: true, identities: [identity] } }));
  await page.route('**/api/video-os-lite/results*', route => route.fulfill({ json: { ok: true, results } }));
  await page.route('**/api/video-os-lite/projects*', route => route.fulfill({ json: { ok: true, projects: [] } }));
  await page.route('**/api/video-os-lite/copywriter*', route => route.fulfill({ json: { ok: true, available: false } }));
  await page.route('**/api/video-os-lite/providers', route => route.fulfill({ json: { ok: true, providers: [], credits: session.credits, entitlements: session.entitlements } }));
  await page.route('**/api/video-os/talent', route => route.fulfill({ json: { ok: true, talent: { avatars: [], voices: [] }, connection: { connected: false } } }));
  await page.route('**/api/video-os-lite/scripted-photo*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      const key = url.searchParams.get('idempotencyKey');
      if (key) recoveryKeys.push(key);
      return route.fulfill({ json: { ok: true, contractVersion: 'scripted-photo-v1', pricingVersion: 'scripted-photo-pricing-v1', quoteTtlSeconds: 300, capabilities: { enabled: available, tiers: { STANDARD: { available, credits: available ? 37 : null, reasons: available ? [] : ['feature_disabled'] }, PREMIUM: { available, credits: 90, reasons: available ? [] : ['feature_disabled'] } } }, existingJob: null } });
    }
    const body = request.postDataJSON();
    if (body.action === 'save-project') {
      projectBody = body;
      return route.fulfill({ json: { ok: true, project: { id: body.projectId, identityId: body.identityId, title: body.title, script: body.script, tier: body.tier, format: body.format, contractVersion: body.contractVersion } } });
    }
    quoteBodies.push(body);
    return route.fulfill({ status: 201, json: { ok: true, quote: { token: 'premium-quote-token', credits: 90, expiresAt: new Date(Date.now() + 300_000).toISOString(), pricingVersion: 'scripted-photo-pricing-v1' }, project: { id: body.projectId, identityId, title: projectBody.title, script: projectBody.script, tier: body.tier, format: body.format, contractVersion: 'scripted-photo-v1' } } });
  });
  await page.route('**/api/video-os-lite/render-v2', async route => {
    const body = route.request().postDataJSON();
    renderBodies.push(body);
    const response = await renderHandler(route, body, renderBodies.length, results);
    return response;
  });
  return { projectBody: () => projectBody, quoteBodies, renderBodies, recoveryKeys };
}

async function preparePremium(page) {
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('Contained Premium proof');
  await page.locator('#script-input').fill('This is the exact authorized Premium script.');
  await page.locator(`[data-premium-identity-id="${identityId}"]`).click();
  await expect(page.locator('#generate-video')).toBeEnabled();
}

test('Premium preserves its strict project contract, submits once, and locks while processing', async ({ page }) => {
  const captured = await installPremiumRoutes(page, async (route, body, _attempt, results) => {
    await new Promise(resolve => setTimeout(resolve, 120));
    const job = { id: 'job-contained', title: body.title, tier: 'premium', status: 'workflow_started', outputAccepted: false, format: body.format };
    results.unshift(job);
    return route.fulfill({ status: 202, json: { ok: true, job, status: 'workflow_started', message: 'Premium job accepted.' } });
  });
  await preparePremium(page);
  await page.locator('#generate-video').click();
  await expect(page.locator('#scripted-photo-quote-dialog')).toBeVisible();
  const confirm = page.locator('#scripted-photo-quote-confirm');
  await confirm.dblclick();
  await expect.poll(() => captured.renderBodies.length).toBe(1);
  await expect(page.locator('#premium-title')).toBeDisabled();
  await expect(page.locator('#script-input')).toBeDisabled();

  const project = captured.projectBody();
  const quote = captured.quoteBodies[0];
  const request = captured.renderBodies[0];
  expect(project).toEqual({ action: 'save-project', contractVersion: 'scripted-photo-v1', projectId: expect.stringMatching(projectIdPattern), tier: 'PREMIUM', title: 'Contained Premium proof', script: 'This is the exact authorized Premium script.', identityId, format: 'vertical' });
  expect(quote).toEqual({ action: 'quote', projectId: project.projectId, tier: 'PREMIUM', format: 'vertical', idempotencyKey: expect.stringMatching(projectIdPattern) });
  expect(request).toEqual({ contractVersion: 'scripted-photo-v1', tier: 'PREMIUM', title: project.title, script: project.script, identityId, format: 'vertical', projectId: project.projectId, idempotencyKey: quote.idempotencyKey, quoteToken: 'premium-quote-token' });
  expect(request).not.toHaveProperty('provider');
  expect(request).not.toHaveProperty('productionKit');
  await expect(page.locator('[data-job-id="job-contained"]')).toHaveAttribute('data-job-state', 'QUEUED');
  await expect(page.locator('#accepted-video')).toBeHidden();
  await expect(page.locator('#download-link')).toBeHidden();
});

test('Premium recovery checks the same intent and reuses its exact idempotency key after an unknown outcome', async ({ page }) => {
  const captured = await installPremiumRoutes(page, (route, body, attempt, results) => {
    if (attempt === 1) return route.abort('connectionfailed');
    const job = { id: 'job-recovered', title: body.title, tier: 'premium', status: 'workflow_started', outputAccepted: false, format: body.format };
    results.unshift(job);
    return route.fulfill({ status: 202, json: { ok: true, job, status: 'workflow_started', message: 'Existing render workflow recovered.' } });
  });
  await preparePremium(page);
  await page.locator('#generate-video').click();
  await page.locator('#scripted-photo-quote-confirm').click();
  await expect(page.locator('#premium-scripted-recovery')).toBeVisible();
  await expect(page.locator('#premium-title')).toBeDisabled();
  await expect(page.locator('#script-input')).toBeDisabled();

  await page.locator('#premium-scripted-check').click();
  await expect(page.locator('#premium-scripted-retry')).toBeEnabled();
  await page.locator('#premium-scripted-retry').click();
  await expect.poll(() => captured.renderBodies.length).toBe(2);
  expect(captured.renderBodies[1]).toEqual(captured.renderBodies[0]);
  expect(new Set(captured.recoveryKeys)).toEqual(new Set([captured.renderBodies[0].idempotencyKey]));
});

test('Premium treats unavailable capability as draft-only and never submits', async ({ page }) => {
  const captured = await installPremiumRoutes(page, route => route.fulfill({ status: 500, json: { ok: false } }), { available: false });
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('No quote');
  await page.locator('#script-input').fill('This remains a local draft.');
  await page.locator(`[data-premium-identity-id="${identityId}"]`).click();
  await expect(page.locator('#provider-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#finish-render-cost')).toHaveText('Not available');
  await expect(page.locator('#generate-video')).toBeDisabled();
  expect(captured.projectBody()).toBeUndefined();
  expect(captured.renderBodies).toHaveLength(0);
});

test('the localhost Standard fixture boundary blocks Premium and account mutations', async ({ page }) => {
  const captured = await installPremiumRoutes(page, route => route.fulfill({ status: 500, json: { ok: false } }));
  const mutationRequests = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) mutationRequests.push(request.url()); });
  await page.goto('/?fixture=standard-lifecycle#create');
  await expect(page.locator('#fixture-banner')).toContainText(/No upload, provider request, credit use, or saved account data/i);
  await page.locator('#premium-tab').click();
  await expect(page.locator('#provider-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#generate-video')).toBeDisabled();
  expect(captured.projectBody()).toBeUndefined();
  expect(captured.renderBodies).toHaveLength(0);
  await page.locator('[data-nav="account"]:visible').first().click();
  await page.locator('#open-login').click();
  await expect(page.locator('#auth-modal')).toBeVisible();
  await expect(page.locator('#sign-out')).toBeDisabled();
  await expect(page.locator('#auth-status')).toContainText(/disabled in the local lifecycle fixture/i);
  expect(mutationRequests).toEqual([]);
});
