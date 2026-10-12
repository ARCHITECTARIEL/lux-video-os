import { expect, test } from '@playwright/test';

const LOOKS = [
  { identityId: '11111111-1111-4111-8111-111111111111', displayName: 'Ariel cinematic look' },
  { identityId: '22222222-2222-4222-8222-222222222222', displayName: 'Studio alternate' },
  { identityId: '33333333-3333-4333-8333-333333333333', displayName: 'Campaign look' },
  { identityId: '44444444-4444-4444-8444-444444444444', displayName: 'Fourth look' },
];

const reply = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function setup(page, {
  available = true,
  failFirstRender = false,
  recoverExisting = false,
  workspaceProjects = [],
  workspaceResults = [],
  scriptedPremiumAvailable = false,
} = {}) {
  const calls = { saves: [], quotes: [], renders: [], recoveries: [], pageErrors: [] };
  const projects = new Map();
  let quoteCount = 0;
  let renderCount = 0;
  let uncertainKey = null;
  page.on('pageerror', error => calls.pageErrors.push(error.message));

  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, route => route.abort());
  await page.route('**/api/video-os-lite/session', route => reply(route, {
    ok: true,
    signedIn: true,
    account: { accountId: 'luxify-owner', name: 'LUXIFY Owner' },
    credits: { balance: 500, reserved: 0 },
    entitlements: { fullAccess: true },
  }));
  await page.route('**/api/video-os-lite/identities*', route => reply(route, { ok: true, identities: [] }));
  await page.route('**/api/video-os-lite/projects*', route => reply(route, { ok: true, projects: workspaceProjects }));
  await page.route('**/api/video-os-lite/results*', route => reply(route, { ok: true, results: workspaceResults }));
  await page.route('**/api/video-os-lite/copywriter*', route => reply(route, { ok: true, available: false }));
  await page.route('**/api/video-os-lite/scripted-photo*', route => reply(route, {
    ok: true,
    contractVersion: 'scripted-photo-v1',
    capabilities: {
      enabled: false,
      tiers: {
        STANDARD: { available: false, credits: null, reasons: ['feature_disabled'] },
        PREMIUM: { available: scriptedPremiumAvailable, credits: 90, reasons: scriptedPremiumAvailable ? [] : ['feature_disabled'] },
      },
    },
  }));
  await page.route('**/api/video-os-lite/luxify*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.searchParams.has('idempotencyKey')) {
      const query = Object.fromEntries(url.searchParams);
      calls.recoveries.push(query);
      const existingJob = recoverExisting && query.idempotencyKey === uncertainKey
        ? {
          id: 'job-luxify-existing',
          projectId: query.projectId,
          mode: 'luxify',
          tier: 'premium',
          title: projects.get(query.projectId)?.title || 'Recovered LUXIFY',
          status: 'workflow_started',
          outputAccepted: false,
        }
        : null;
      return reply(route, { ok: true, existingJob });
    }
    if (request.method() === 'GET') {
      return reply(route, {
        ok: true,
        contractVersion: 'luxify-cinematic-v1',
        capabilities: {
          available,
          reasons: available ? [] : ['feature_disabled'],
          eligibleLooks: available ? LOOKS : [],
        },
      });
    }
    const body = request.postDataJSON();
    if (body.action === 'save-project') {
      calls.saves.push(body);
      projects.set(body.projectId, body);
      return reply(route, { ok: true, project: { id: body.projectId } });
    }
    if (body.action === 'quote') {
      calls.quotes.push(body);
      quoteCount += 1;
      const saved = projects.get(body.projectId);
      return reply(route, {
        ok: true,
        quote: {
          token: ('luxify-quote-' + quoteCount + '-').padEnd(52, 'q'),
          credits: saved?.resolution === '1080p' ? 97 : 41,
          currency: 'lux_credits',
          pricingVersion: 'luxify-cinematic-pricing-v1',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
        project: { id: body.projectId },
      }, 201);
    }
    return reply(route, { ok: false, error: 'Unexpected LUXIFY action.' }, 400);
  });
  await page.route('**/api/video-os-lite/render', route => {
    const body = route.request().postDataJSON();
    calls.renders.push(body);
    renderCount += 1;
    uncertainKey = body.idempotencyKey;
    if (failFirstRender && renderCount === 1) return route.abort('failed');
    return reply(route, {
      ok: true,
      job: {
        id: 'job-luxify-' + renderCount,
        projectId: body.projectId,
        mode: 'luxify',
        tier: 'premium',
        title: body.title,
        status: 'workflow_started',
        outputAccepted: false,
      },
    }, 202);
  });

  await page.goto('/#luxify');
  await expect(page.locator('#luxify-view')).toBeVisible();
  return calls;
}

async function completeDraft(page) {
  await page.locator('#luxify-video-title').fill('Blue hour product reveal');
  await page.locator('#luxify-prompt').fill('A founder crosses a quiet rooftop at blue hour while the camera makes a slow orbit and the city ambience rises.');
  await page.locator('[data-luxify-look-identity-id="' + LOOKS[0].identityId + '"]').click();
}

test('LUXIFY is a separate capability-gated view and leaves Standard/Premium tabs unchanged', async ({ page }) => {
  await setup(page, { available: false });
  await expect(page.locator('#luxify-availability')).toContainText('unavailable');
  await expect(page.locator('#luxify-submit')).toBeDisabled();
  await expect(page.locator('#luxify-status')).toContainText('not enabled');
  await expect(page.locator('.luxify-truth-note')).toContainText('No synthetic preview');
  await expect(page.locator('#luxify-view canvas, #luxify-view video')).toHaveCount(0);

  await page.locator('.primary-nav [data-nav="create"]').click();
  await expect(page.locator('.tier-tabs [role="tab"]')).toHaveCount(2);
  await expect(page.locator('#standard-tab')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#premium-tab').click();
  await expect(page.locator('#premium-panel')).toBeVisible();
  await expect(page.locator('#luxify-view')).toBeHidden();
});

test('saved LUXIFY and unavailable records never restore into or lock Premium Presenter', async ({ page }) => {
  const unavailableProject = {
    id: '77777777-7777-4777-8777-777777777777',
    mode: 'unavailable',
    tier: null,
    provider: { id: 'heygen' },
    title: 'Ambiguous cinematic project',
    script: 'Conflicting persisted markers require reconciliation.',
    settings: {},
  };
  const luxifyProject = {
    id: '55555555-5555-4555-8555-555555555555',
    mode: 'luxify',
    provider: { id: 'heygen' },
    title: 'Cinematic project must stay separate',
    script: 'A prompt must never become a Presenter script.',
    settings: {},
  };
  const presenterProject = {
    id: '66666666-6666-4666-8666-666666666666',
    mode: 'premium',
    provider: { id: 'heygen' },
    title: 'Saved Presenter project',
    script: 'This exact Presenter script is the only draft that may restore here.',
    identityId: null,
    avatar: null,
    voice: null,
    settings: {},
  };
  const luxifyJob = {
    id: 'job-live-luxify',
    projectId: luxifyProject.id,
    mode: 'luxify',
    tier: 'premium',
    title: luxifyProject.title,
    status: 'PROCESSING',
    outputAccepted: false,
  };
  const unavailableJob = {
    id: 'job-unavailable-marker',
    projectId: unavailableProject.id,
    mode: 'unavailable',
    tier: null,
    provider: { id: 'heygen' },
    title: unavailableProject.title,
    status: 'PROCESSING',
    outputAccepted: false,
  };
  await setup(page, {
    workspaceProjects: [unavailableProject, luxifyProject, presenterProject],
    workspaceResults: [unavailableJob, luxifyJob],
    scriptedPremiumAvailable: true,
  });

  await page.getByRole('link', { name: 'Create video', exact: true }).first().click();
  await page.locator('#premium-tab').click();
  await expect(page.locator('#premium-title')).toHaveValue(presenterProject.title);
  await expect(page.locator('#script-input')).toHaveValue(presenterProject.script);
  await expect(page.locator('#premium-title')).toBeEnabled();
  await expect(page.locator('#script-input')).toBeEnabled();
  await expect(page.locator('#export-format')).toBeEnabled();

  await page.getByRole('link', { name: 'My Videos', exact: true }).first().click();
  const unavailableCard = page.locator('.result-card').filter({ hasText: unavailableJob.title });
  await expect(unavailableCard).toBeVisible();
  await expect(unavailableCard.locator('.result-meta')).toContainText('Unavailable (reconciliation required)');
  await expect(unavailableCard.locator('.result-meta')).not.toContainText('Premium');
  await expect(unavailableCard.locator('.result-meta')).not.toContainText('LUXIFY');
});

test('available LUXIFY quotes and submits the exact prompt-led contract without provider fields', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await setup(page);
  await completeDraft(page);
  await page.locator('[data-luxify-look-identity-id="' + LOOKS[1].identityId + '"]').click();
  await page.locator('#luxify-aspect').selectOption('9:16');
  await page.locator('#luxify-resolution').selectOption('1080p');
  await page.locator('#luxify-duration').selectOption('15');
  await expect(page.locator('#luxify-summary-looks')).toContainText('Ariel cinematic look');
  await expect(page.locator('#luxify-summary-aspect')).toHaveText('Vertical 9:16');
  await expect(page.locator('#luxify-submit')).toBeEnabled();

  await page.locator('#luxify-submit').click();
  await expect(page.locator('#luxify-quote-dialog')).toBeVisible();
  await expect(page.locator('#luxify-quote-summary')).toContainText('97 LUX credits');
  await expect(page.locator('#luxify-quote-summary')).toContainText('Generated from the prompt');
  await page.screenshot({ path: testInfo.outputPath('luxify-desktop-quote.png') });
  await page.locator('#luxify-quote-confirm').click();
  await expect.poll(() => calls.renders.length).toBe(1);

  expect(calls.saves[0]).toEqual({
    action: 'save-project',
    contractVersion: 'luxify-cinematic-v1',
    projectId: expect.any(String),
    title: 'Blue hour product reveal',
    prompt: 'A founder crosses a quiet rooftop at blue hour while the camera makes a slow orbit and the city ambience rises.',
    lookIdentityIds: [LOOKS[0].identityId, LOOKS[1].identityId],
    aspectRatio: '9:16',
    resolution: '1080p',
    durationSeconds: 15,
  });
  expect(calls.quotes[0]).toEqual({
    action: 'quote',
    contractVersion: 'luxify-cinematic-v1',
    projectId: calls.saves[0].projectId,
    idempotencyKey: expect.any(String),
  });
  expect(calls.renders[0]).toEqual({
    contractVersion: 'luxify-cinematic-v1',
    projectId: calls.saves[0].projectId,
    idempotencyKey: calls.quotes[0].idempotencyKey,
    title: calls.saves[0].title,
    prompt: calls.saves[0].prompt,
    lookIdentityIds: calls.saves[0].lookIdentityIds,
    aspectRatio: '9:16',
    resolution: '1080p',
    durationSeconds: 15,
    quoteToken: expect.stringMatching(/^luxify-quote-/),
  });
  for (const key of ['provider', 'providerLookId', 'renderMode', 'providerCapability', 'model', 'script', 'voice']) {
    expect(calls.renders[0]).not.toHaveProperty(key);
  }
  await expect(page.locator('#luxify-status')).toContainText(/accepted|My Videos/i);
  await expect(page.locator('#result-gallery')).toContainText('LUXIFY');
  expect(calls.pageErrors).toEqual([]);
});

test('look selection preserves order and prevents a fourth selection', async ({ page }) => {
  await setup(page);
  for (const look of LOOKS.slice(0, 3)) {
    await page.locator('[data-luxify-look-identity-id="' + look.identityId + '"]').click();
  }
  await expect(page.locator('#luxify-look-count')).toHaveText('3 of 3');
  await page.locator('[data-luxify-look-identity-id="' + LOOKS[3].identityId + '"]').click();
  await expect(page.locator('#luxify-look-error')).toContainText('no more than three');
  await expect(page.locator('[data-luxify-look-identity-id="' + LOOKS[3].identityId + '"]')).toHaveAttribute('aria-pressed', 'false');
});

test('uncertain submission reloads its exact draft and recovers without a second render', async ({ page }) => {
  const calls = await setup(page, { failFirstRender: true, recoverExisting: true });
  await completeDraft(page);
  await page.locator('#luxify-submit').click();
  await page.locator('#luxify-quote-confirm').click();
  await expect(page.locator('#luxify-recovery')).toBeVisible();
  await page.reload();
  await expect(page.locator('#luxify-view')).toBeVisible();
  await expect(page.locator('#luxify-video-title')).toHaveValue('Blue hour product reveal');
  await expect(page.locator('#luxify-prompt')).toHaveValue(/founder crosses a quiet rooftop/);
  await expect(page.locator('[data-luxify-look-identity-id="' + LOOKS[0].identityId + '"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#luxify-recovery')).toBeVisible();
  await page.locator('#luxify-check').click();
  await expect(page.locator('#luxify-status')).toContainText('Existing LUXIFY render found');
  expect(calls.renders).toHaveLength(1);
  expect(calls.recoveries[0]).toEqual({
    contractVersion: 'luxify-cinematic-v1',
    projectId: calls.saves[0].projectId,
    idempotencyKey: calls.renders[0].idempotencyKey,
  });
});

test('LUXIFY remains readable and overflow-free at 390px', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await setup(page);
  await completeDraft(page);
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.viewport);
  const submit = await page.locator('#luxify-submit').boundingBox();
  expect(submit.height).toBeGreaterThanOrEqual(44);
  expect(calls.pageErrors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('luxify-mobile.png'), fullPage: true });
});
