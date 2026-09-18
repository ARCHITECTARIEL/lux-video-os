import { expect, test } from '@playwright/test';

const projectId = '11111111-1111-4111-8111-111111111111';
const identityId = '4c2f26b6-cdd4-4d53-8e37-17e7858c679c';

const identity = {
  id: identityId,
  displayName: 'Authorized Premium identity',
  overallStatus: 'READY',
  avatarStatus: 'READY',
  voiceStatus: 'READY',
  ready: true,
  portraitUrl: '/api/video-os-lite/asset?assetId=portrait-proof',
};

const session = {
  ok: true,
  signedIn: true,
  email: 'redacted@example.test',
  account: {
    accountId: 'acct-demo',
    name: 'Contained Demo',
    subscription: { plan: 'Demo', status: 'contained' },
  },
  credits: { accountId: 'acct-demo', balance: 180, reserved: 0 },
  entitlements: { fullAccess: true },
};

async function installPremiumRoutes(page, renderHandler, { providerCost = 90 } = {}) {
  let projectBody;
  const renderBodies = [];
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ json: {
    ok: true,
    signedIn: true,
    providers: [{ id: 'heygen', name: 'HeyGen', configured: true, cost: providerCost }],
    credits: session.credits,
    entitlements: session.entitlements,
  } }));
  await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill({ json: { ok: true, identities: [identity] } }));
  await page.route('**/api/video-os/talent', (route) => route.fulfill({ json: { ok: true, talent: { avatars: [], voices: [] }, connection: { connected: true } } }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({ json: { ok: true, results: [] } }));
  await page.route('**/api/video-os-lite/projects', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, projects: [] } });
    projectBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { ok: true, project: { id: projectId, ...projectBody } } });
  });
  await page.route('**/api/video-os-lite/asset*', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
  }));
  await page.route('**/api/video-os-lite/finalize', (route) => route.fulfill({ status: 202, json: {
    ok: true,
    ready: false,
    id: 'job-contained',
    status: 'PROCESSING',
    outputAccepted: false,
    message: 'Premium render is still processing.',
  } }));
  await page.route('**/api/video-os-lite/render', async (route) => {
    const body = route.request().postDataJSON();
    renderBodies.push(body);
    return renderHandler(route, body, renderBodies.length);
  });
  return {
    projectBody: () => projectBody,
    renderBodies,
  };
}

async function preparePremium(page) {
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('Contained Premium proof');
  await page.locator('#script-input').fill('This is the exact authorized Premium script.');
  await page.locator(`[data-premium-identity-id="${identityId}"]`).click();
  await expect(page.locator('#generate-video')).toBeEnabled();
}

test('Premium preserves its project contract, submits once, and locks while processing', async ({ page }) => {
  const captured = await installPremiumRoutes(page, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({ status: 202, json: {
      ok: true,
      provider: { id: 'premium', name: 'Premium' },
      credits: { balance: 180, reserved: 90 },
      job: {
        id: 'job-contained',
        title: 'Contained Premium proof',
        tier: 'premium',
        status: 'PROCESSING',
        outputAccepted: false,
      },
      status: 'PROCESSING',
      message: 'Premium job accepted.',
    } });
  });
  await preparePremium(page);

  const create = page.locator('#generate-video');
  await create.dblclick();
  await expect(create).toBeDisabled();
  await expect(create).toHaveText('Premium render in progress');
  await create.click({ force: true });
  expect(captured.renderBodies).toHaveLength(1);

  const project = captured.projectBody();
  const request = captured.renderBodies[0];
  expect(project.identityId).toBe(identityId);
  expect(project.avatar.id).toBe(`identity-avatar:${identityId}`);
  expect(project.voice.id).toBe(`identity-voice:${identityId}`);
  expect(project.settings).toEqual({ format: 'vertical' });
  expect(project).not.toHaveProperty('accountId');
  expect(request).toMatchObject({
    projectId,
    identityId,
    provider: 'heygen',
    tier: 'PREMIUM',
    title: 'Contained Premium proof',
    script: 'This is the exact authorized Premium script.',
    format: 'vertical',
    productionKit: {},
  });
  expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(request).not.toHaveProperty('accountId');
  expect(request).not.toHaveProperty('userId');
  expect(request).not.toHaveProperty('ownerId');
  expect(request).not.toHaveProperty('avatar');
  expect(request).not.toHaveProperty('voice');
  expect(JSON.stringify(request)).not.toMatch(/providerRenderable|providerVoiceId|portrait-proof/);
  await expect(page.locator('[data-job-id="job-contained"]')).toHaveAttribute('data-job-state', 'PROCESSING');
  await expect(page.locator('#accepted-video')).toBeHidden();
  await expect(page.locator('#download-link')).toBeHidden();
});

test('Premium recovery reuses the exact request and idempotency key after an unknown POST outcome', async ({ page }) => {
  const captured = await installPremiumRoutes(page, (route, _body, attempt) => {
    if (attempt === 1) return route.abort('connectionfailed');
    return route.fulfill({ status: 202, json: {
      ok: true,
      provider: { id: 'premium', name: 'Premium' },
      job: { id: 'job-recovered', title: 'Contained Premium proof', tier: 'premium', status: 'QUEUED', outputAccepted: false },
      status: 'QUEUED',
      message: 'Existing render workflow recovered.',
    } });
  });
  await preparePremium(page);

  await page.locator('#generate-video').click();
  await expect(page.locator('#generate-video')).toHaveText('Recover Premium submission');
  await expect(page.locator('#premium-status')).toContainText(/same request key/i);
  await expect(page.locator('#premium-title')).toBeDisabled();
  await expect(page.locator('#script-input')).toBeDisabled();

  await page.locator('#generate-video').click();
  await expect(page.locator('#generate-video')).toBeDisabled();
  await expect(page.locator('#generate-video')).toHaveText('Premium render in progress');
  expect(captured.renderBodies).toHaveLength(2);
  expect(captured.renderBodies[1]).toEqual(captured.renderBodies[0]);
  expect(captured.renderBodies[1].idempotencyKey).toBe(captured.renderBodies[0].idempotencyKey);
});

test('Premium treats a null quote as unavailable and never submits', async ({ page }) => {
  const captured = await installPremiumRoutes(page, (route) => route.fulfill({ status: 500, json: { ok: false } }), { providerCost: null });
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
  await page.locator('#premium-title').fill('No quote');
  await page.locator('#script-input').fill('This should remain a local draft.');
  await page.locator(`[data-premium-identity-id="${identityId}"]`).click();

  await expect(page.locator('#provider-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#finish-render-cost')).toHaveText('Not available');
  await expect(page.locator('#generate-video')).toBeDisabled();
  await page.locator('#generate-video').click({ force: true });
  expect(captured.renderBodies).toHaveLength(0);
});

test('the localhost Standard fixture boundary blocks eligible Premium and account mutations', async ({ page }) => {
  const captured = await installPremiumRoutes(page, (route) => route.fulfill({ status: 500, json: { ok: false } }));
  const mutationRequests = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) mutationRequests.push(request.url());
  });
  await page.goto('/?fixture=standard-lifecycle#create');
  await expect(page.locator('#fixture-banner')).toContainText(/No upload, provider request, credit use, or saved account data/i);

  await page.locator('#premium-tab').click();
  await expect(page.locator('#provider-status')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#generate-video')).toBeDisabled();
  await page.locator('#generate-video').click({ force: true });
  expect(captured.projectBody()).toBeUndefined();
  expect(captured.renderBodies).toHaveLength(0);

  await page.locator('[data-nav="account"]:visible').first().click();
  await page.locator('#open-login').click();
  await expect(page.locator('#auth-modal')).toBeVisible();
  await expect(page.locator('#sign-out')).toBeDisabled();
  await expect(page.locator('#auth-status')).toContainText(/disabled in the local lifecycle fixture/i);
  await expect(page.locator('#close-login')).toBeEnabled();
  expect(mutationRequests).toEqual([]);
});
