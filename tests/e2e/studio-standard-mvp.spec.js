import { expect, test } from '@playwright/test';

const SIGNED_OUT_SESSION = {
  ok: true,
  signedIn: false,
  account: {
    accountId: 'signed-out',
    name: 'Sign in to continue',
    subscription: { plan: 'Video OS', status: 'preview' },
  },
  credits: { accountId: 'signed-out', balance: 0, reserved: 0 },
  entitlements: {},
};

const SIGNED_IN_SESSION = {
  ok: true,
  signedIn: true,
  email: 'fixture@example.test',
  account: {
    accountId: 'fixture-account',
    name: 'Fixture workspace',
    subscription: { plan: 'Video OS', status: 'contained' },
  },
  credits: { accountId: 'fixture-account', balance: 0, reserved: 0 },
  entitlements: { fullAccess: true },
};

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function installWorkspaceRoutes(page, { results = [], session = SIGNED_OUT_SESSION } = {}) {
  let renderRequests = 0;
  const externalRequests = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url());
  });
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, (route) => route.abort('blockedbyclient'));
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill(json(session)));
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill(json({
    ok: true,
    signedIn: session.signedIn,
    providers: [],
    credits: session.credits,
    entitlements: session.entitlements,
  })));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill(json({ ok: true, results })));
  await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill(json({ ok: true, identities: [], providerSubmissionEnabled: false })));
  await page.route('**/api/video-os/talent', (route) => route.fulfill(json({
    ok: true,
    talent: { avatars: [], voices: [] },
    connection: { connected: false, status: 'contained' },
  })));
  await page.route('**/api/video-os-lite/projects', (route) => route.fulfill(json({ ok: true, projects: [] })));
  await page.route('**/api/video-os-lite/render', (route) => {
    renderRequests += 1;
    return route.fulfill(json({ ok: false, error: 'Provider submissions are forbidden in local fixture tests.' }, 500));
  });

  return {
    externalRequests,
    renderRequests: () => renderRequests,
  };
}

async function openStandardFixture(page, outcome = 'success') {
  await page.goto(`/?fixture=standard-lifecycle&fixture-outcome=${outcome}`);
  await expect(page.locator('#standard-panel')).toBeVisible();
  await expect(page.getByText('Local lifecycle fixture', { exact: true })).toBeVisible();
  await expect(page.locator('#standard-submit')).toHaveAccessibleName('Run local lifecycle fixture');
  await expect(page.locator('#standard-status')).toHaveAttribute('data-state', 'DRAFT');
}

async function prepareStandardFixture(page, title = 'Authorized launch update') {
  await page.locator('#use-fixture-portrait').click();
  await page.locator('#use-fixture-audio').click();
  await page.locator('#video-title').fill(title);
  await page.locator('#standard-permission').check();
  await page.locator('#review-inputs').click();
  await expect(page.locator('#review-dialog')).toBeVisible();
  await expect(page.locator('#review-summary')).toContainText(title);
  await page.locator('#review-complete').click();
  await expect(page.locator('#review-dialog')).toBeHidden();
  await expect(page.locator('#standard-submit')).toBeEnabled();
}

async function runFixtureToTerminal(page, expectedTerminal) {
  const state = page.locator('#standard-status');
  await page.locator('#standard-submit').click();
  await expect(state).toHaveAttribute('data-state', 'DRAFT');
  for (const expected of ['VALIDATING', 'QUEUED', 'SUBMITTING', 'PROCESSING', expectedTerminal]) {
    await page.clock.fastForward(410);
    await expect(state).toHaveAttribute('data-state', expected);
  }
}

test.describe('Standard local preparation', () => {
  test('signed-out first use shows no fabricated identity, fixture, quote, or live submit state', async ({ page }) => {
    const guard = await installWorkspaceRoutes(page);
    await page.goto('/#create');

    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
    await expect(page.locator('#my-cast-list')).toContainText(/sign in/i);
    await expect(page.getByRole('link', { name: 'Open Identity Studio' })).toBeVisible();
    await expect(page.locator('#use-fixture-portrait')).toBeHidden();
    await expect(page.locator('#use-fixture-audio')).toBeHidden();
    await expect(page.locator('#standard-cost')).toHaveText('Not available');
    await expect(page.locator('#standard-submit')).toBeDisabled();
    await expect(page.locator('#standard-submit')).toHaveText('Sign in to submit Standard');
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });

  test('invalid portrait and audio are field errors and preserve the other prepared input', async ({ page }) => {
    const guard = await installWorkspaceRoutes(page);
    await openStandardFixture(page);

    await page.locator('#standard-portrait-file').setInputFiles({
      name: 'portrait.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image'),
    });
    await expect(page.locator('#standard-portrait-file')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#portrait-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#portrait-error')).not.toBeEmpty();

    await page.locator('#use-fixture-portrait').click();
    await page.locator('#standard-audio-file').setInputFiles({
      name: 'narration.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not audio'),
    });
    await expect(page.locator('#standard-audio-file')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#audio-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#audio-error')).not.toBeEmpty();

    await expect(page.locator('#standard-portrait-file')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#standard-submit')).toBeDisabled();
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });

  test('review identifies each missing requirement, focuses it, and records permission only in UI state', async ({ page }) => {
    const guard = await installWorkspaceRoutes(page);
    await openStandardFixture(page);

    await page.locator('#review-inputs').click();
    await expect(page.locator('#standard-portrait-file')).toBeFocused();
    await expect(page.locator('#standard-portrait-file')).toHaveAttribute('aria-invalid', 'true');

    await page.locator('#use-fixture-portrait').click();
    await page.locator('#review-inputs').click();
    await expect(page.locator('#standard-audio-file')).toBeFocused();

    await page.locator('#use-fixture-audio').click();
    await page.locator('#review-inputs').click();
    await expect(page.locator('#video-title')).toBeFocused();

    await page.locator('#video-title').fill('Permission boundary proof');
    await page.locator('#review-inputs').click();
    await expect(page.locator('#standard-permission')).toBeFocused();
    await expect(page.locator('#permission-error')).toHaveAttribute('role', 'alert');

    await page.locator('#standard-permission').check();
    await page.locator('#review-inputs').click();
    await expect(page.locator('#review-dialog')).toBeVisible();
    await expect(page.locator('#review-summary')).toContainText(/authorized|permission/i);
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });

  test('review dialog keeps background controls inert, closes with Escape, and returns focus to its opener', async ({ page }) => {
    await installWorkspaceRoutes(page);
    await openStandardFixture(page);
    await prepareStandardFixture(page);

    await page.locator('#review-inputs').focus();
    await page.locator('#review-inputs').press('Enter');
    const dialog = page.locator('#review-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);

    await page.getByRole('button', { name: 'Close review' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#review-complete')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close review' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#review-inputs')).toBeFocused();
  });
});

test.describe('explicit Standard lifecycle fixture', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  test('shows every normalized stage and exposes media only after accepted success', async ({ page }) => {
    const guard = await installWorkspaceRoutes(page);
    await openStandardFixture(page);
    await prepareStandardFixture(page);
    await runFixtureToTerminal(page, 'SUCCEEDED');

    await page.locator('[data-nav="videos"]:visible').first().click();
    const result = page.locator('[data-job-id="fixture-standard-001"]');
    await expect(result).toHaveAttribute('data-job-state', 'SUCCEEDED');
    await result.locator('.result-preview-action').click();
    await expect(page.locator('#preview')).toHaveAttribute('data-preview-state', 'completed');
    await expect(page.locator('#accepted-video')).toBeVisible();
    await expect(page.locator('#accepted-video')).toHaveAttribute('controls', '');
    await expect(page.locator('#accepted-video')).toHaveAttribute('src', /^\/assets\/studio\/fixture-output\.mp4(?:\?fixture=1)?$/);
    await expect(page.locator('#download-link')).toBeVisible();
    await expect(page.locator('#download-link')).toHaveAttribute('href', '/assets/studio/fixture-output.mp4');
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });

  for (const [outcome, state] of [
    ['retryable', 'FAILED_RETRYABLE'],
    ['final', 'FAILED_FINAL'],
    ['cancelled', 'CANCELLED'],
  ]) {
    test(`${state} remains non-playable and retains its job context`, async ({ page }) => {
      const guard = await installWorkspaceRoutes(page);
      await openStandardFixture(page, outcome);
      await prepareStandardFixture(page, `${state} fixture`);
      await runFixtureToTerminal(page, state);

      await page.locator('[data-nav="videos"]:visible').first().click();
      await expect(page.locator('[data-job-id="fixture-standard-001"]')).toHaveAttribute('data-job-state', state);
      await expect(page.locator('#accepted-video')).toBeHidden();
      await expect(page.locator('#download-link')).toBeHidden();
      expect(guard.renderRequests()).toBe(0);
      expect(guard.externalRequests).toEqual([]);
    });
  }

  test('raw success without output acceptance remains processing and never exposes media', async ({ page }) => {
    const guard = await installWorkspaceRoutes(page);
    await openStandardFixture(page, 'unaccepted');
    await prepareStandardFixture(page, 'Acceptance pending fixture');
    await runFixtureToTerminal(page, 'PROCESSING');

    await page.locator('[data-nav="videos"]:visible').first().click();
    await expect(page.locator('[data-job-id="fixture-standard-001"]')).toHaveAttribute('data-job-state', 'PROCESSING');
    await expect(page.locator('#preview')).not.toHaveAttribute('data-preview-state', 'completed');
    await expect(page.locator('#accepted-video')).toBeHidden();
    await expect(page.locator('#download-link')).toBeHidden();
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });
});

test.describe('account-owned result presentation', () => {
  test('only an explicitly accepted SUCCEEDED result can preview or download', async ({ page }) => {
    const results = [
      {
        id: 'accepted-job',
        title: 'Accepted video',
        tier: 'standard',
        status: 'SUCCEEDED',
        outputAccepted: true,
        url: '/api/video-os-lite/download?jobId=accepted-job',
        filename: 'accepted.mp4',
      },
      {
        id: 'unaccepted-job',
        title: 'Acceptance pending',
        tier: 'standard',
        status: 'SUCCEEDED',
        outputAccepted: false,
        url: '/unsafe-unaccepted.mp4',
      },
      {
        id: 'processing-job',
        title: 'Still processing',
        tier: 'standard',
        status: 'PROCESSING',
        outputAccepted: false,
        url: '/unsafe-processing.mp4',
      },
      {
        id: 'statusless-job',
        title: 'Missing status',
        tier: 'standard',
        outputAccepted: false,
        url: '/unsafe-statusless.mp4',
      },
    ];
    const guard = await installWorkspaceRoutes(page, { results, session: SIGNED_IN_SESSION });
    await page.goto('/#videos');

    await expect(page.locator('[data-job-id="accepted-job"]')).toHaveAttribute('data-job-state', 'SUCCEEDED');
    await expect(page.locator('[data-job-id="accepted-job"] .result-preview-action')).toHaveCount(1);
    await expect(page.locator('[data-job-id="unaccepted-job"]')).toHaveAttribute('data-job-state', 'PROCESSING');
    await expect(page.locator('[data-job-id="processing-job"]')).toHaveAttribute('data-job-state', 'PROCESSING');
    await expect(page.locator('[data-job-id="statusless-job"]')).not.toHaveAttribute('data-job-state', 'SUCCEEDED');
    await expect(page.locator('video[src*="unsafe"], a[href*="unsafe"]')).toHaveCount(0);
    await expect(page.locator('.result-preview-action')).toHaveCount(1);

    await page.locator('[data-job-id="accepted-job"] .result-preview-action').click();
    await expect(page.locator('#accepted-video')).toHaveAttribute('src', /\/api\/video-os-lite\/download\?jobId=accepted-job&disposition=inline$/);
    await expect(page.locator('#download-link')).toHaveAttribute('href', '/api/video-os-lite/download?jobId=accepted-job');
    expect(guard.renderRequests()).toBe(0);
    expect(guard.externalRequests).toEqual([]);
  });

  test('video history progressively expands from six results without changing job state', async ({ page }) => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      id: `history-${index + 1}`,
      title: `History item ${index + 1}`,
      tier: 'standard',
      status: 'PROCESSING',
      outputAccepted: false,
      createdAt: `2026-09-08T14:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    await installWorkspaceRoutes(page, { results, session: SIGNED_IN_SESSION });
    await page.goto('/#videos');

    await expect(page.locator('.result-card')).toHaveCount(6);
    const toggle = page.locator('#result-gallery-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAccessibleName('View all 8 videos');
    await toggle.click();
    await expect(page.locator('.result-card')).toHaveCount(8);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.result-card[data-job-state="PROCESSING"]')).toHaveCount(8);
    await toggle.click();
    await expect(page.locator('.result-card')).toHaveCount(6);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('a newer processing job is not masked by automatic preview of an older accepted video', async ({ page }) => {
    const results = [
      {
        id: 'new-processing',
        title: 'Newest work',
        tier: 'standard',
        status: 'PROCESSING',
        outputAccepted: false,
        updatedAt: '2026-09-08T15:00:00.000Z',
      },
      {
        id: 'old-accepted',
        title: 'Older accepted video',
        tier: 'standard',
        status: 'SUCCEEDED',
        outputAccepted: true,
        url: '/api/video-os-lite/download?jobId=old-accepted',
        filename: 'older.mp4',
        updatedAt: '2026-09-08T14:00:00.000Z',
      },
    ];
    await installWorkspaceRoutes(page, { results, session: SIGNED_IN_SESSION });
    await page.goto('/#videos');

    await expect(page.locator('[data-job-id="new-processing"]')).toHaveAttribute('data-job-state', 'PROCESSING');
    await expect(page.locator('#preview')).not.toHaveAttribute('data-preview-state', 'completed');
    await expect(page.locator('#accepted-video')).toBeHidden();
    await expect(page.locator('[data-job-id="old-accepted"] .result-preview-action')).toBeVisible();

    await page.locator('[data-job-id="old-accepted"] .result-preview-action').click();
    await expect(page.locator('#preview')).toBeVisible();
    await expect(page.locator('#accepted-video')).toHaveAttribute('src', /jobId=old-accepted&disposition=inline$/);
    await expect(page.locator('#download-link')).toHaveAttribute('href', /jobId=old-accepted$/);
  });
});

test.describe('workspace loading and recovery', () => {
  test('a slow session read keeps an honest loading state before signed-out recovery', async ({ page }) => {
    let releaseSession;
    const pendingSession = new Promise((resolve) => { releaseSession = resolve; });
    await page.route('**/api/video-os-lite/session', async (route) => {
      await pendingSession;
      await route.fulfill(json(SIGNED_OUT_SESSION));
    });
    await page.route('**/api/video-os-lite/providers', (route) => route.fulfill(json({ ok: true, signedIn: false, providers: [], credits: SIGNED_OUT_SESSION.credits })));
    await page.route('**/api/video-os-lite/results*', (route) => route.fulfill(json({ ok: true, results: [] })));
    await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill(json({ ok: true, identities: [] })));

    await page.goto('/');
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'loading');
    await expect(page.locator('#connection-pill')).toContainText('Checking workspace');
    releaseSession();
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
    await expect(page.locator('#workspace-retry')).toBeHidden();
  });

  test('a failed session read offers an explicit retry and does not fabricate an account', async ({ page }) => {
    let attempts = 0;
    await page.route('**/api/video-os-lite/session', async (route) => {
      attempts += 1;
      if (attempts === 1) return route.abort('connectionfailed');
      return route.fulfill(json(SIGNED_OUT_SESSION));
    });
    await page.route('**/api/video-os-lite/providers', (route) => route.fulfill(json({ ok: true, signedIn: false, providers: [], credits: SIGNED_OUT_SESSION.credits })));
    await page.route('**/api/video-os-lite/results*', (route) => route.fulfill(json({ ok: true, results: [] })));
    await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill(json({ ok: true, identities: [] })));

    await page.goto('/');
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'error');
    await expect(page.locator('#app-notice')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#workspace-retry')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/1,500 credits|ready now/i);

    await page.locator('#workspace-retry').click();
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
    await expect(page.locator('#workspace-retry')).toBeHidden();
    expect(attempts).toBe(2);
  });
});

test.describe('account data containment', () => {
  const privateIdentity = {
    id: '4c2f26b6-cdd4-4d53-8e37-17e7858c679c',
    displayName: 'Private fixture identity',
    overallStatus: 'READY',
    avatarStatus: 'READY',
    voiceStatus: 'READY',
    ready: true,
    portraitUrl: '/api/video-os-lite/asset?assetId=private-portrait',
  };
  const privateProject = {
    id: '11111111-1111-4111-8111-111111111111',
    identityId: privateIdentity.id,
    title: 'Private Premium draft',
    script: 'This private draft must be cleared at sign out.',
    avatar: { id: `identity-avatar:${privateIdentity.id}`, name: privateIdentity.displayName, source: 'identity' },
    voice: { id: `identity-voice:${privateIdentity.id}`, name: `${privateIdentity.displayName} voice`, source: 'identity' },
  };
  const privateResult = {
    id: 'private-accepted-job',
    title: 'Private accepted video',
    tier: 'premium',
    status: 'SUCCEEDED',
    outputAccepted: true,
    url: '/api/video-os-lite/download?jobId=private-accepted-job',
    filename: 'private.mp4',
  };

  async function installPrivateWorkspace(page, { deferredReads } = {}) {
    let signedIn = true;
    await page.route('**/api/video-os-lite/session', (route) => {
      if (route.request().method() === 'POST') {
        signedIn = false;
        return route.fulfill(json({ ok: true, signedIn: false }));
      }
      return route.fulfill(json(signedIn ? SIGNED_IN_SESSION : SIGNED_OUT_SESSION));
    });
    await page.route('**/api/video-os-lite/providers', (route) => route.fulfill(json({
      ok: true,
      providers: [{ id: 'heygen', name: 'HeyGen', configured: true, cost: 90 }],
      credits: SIGNED_IN_SESSION.credits,
      entitlements: SIGNED_IN_SESSION.entitlements,
    })));
    await page.route('**/api/video-os/talent', (route) => route.fulfill(json({ ok: true, talent: { avatars: [], voices: [] }, connection: { connected: true } })));
    await page.route('**/api/video-os-lite/projects', (route) => route.fulfill(json({ ok: true, projects: [privateProject] })));
    await page.route('**/api/video-os-lite/identities*', async (route) => {
      if (deferredReads) await deferredReads;
      return route.fulfill(json({ ok: true, identities: [privateIdentity], providerSubmissionEnabled: false }));
    });
    await page.route('**/api/video-os-lite/results*', async (route) => {
      if (deferredReads) await deferredReads;
      return route.fulfill(json({ ok: true, results: [privateResult] }));
    });
    await page.route('**/api/video-os-lite/asset*', (route) => route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
    }));
  }

  async function signOutFromAccount(page) {
    await page.locator('[data-nav="account"]:visible').first().click();
    await page.locator('[data-open-login]:visible').click();
    await expect(page.locator('#sign-out')).toBeVisible();
    await page.locator('#sign-out').click();
    await expect(page.locator('#auth-modal')).toBeHidden();
  }

  test('sign out clears private identity selection, Premium draft fields, and accepted output', async ({ page }) => {
    await installPrivateWorkspace(page);
    await page.goto(`/?identityId=${privateIdentity.id}#create`);

    await expect(page.locator(`[data-standard-identity-id="${privateIdentity.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#review-identity')).toHaveText(privateIdentity.displayName);
    await page.locator('#premium-tab').click();
    await expect(page.locator('#premium-title')).toHaveValue(privateProject.title);
    await expect(page.locator('#script-input')).toHaveValue(privateProject.script);
    await page.locator('[data-nav="videos"]:visible').first().click();
    await expect(page.locator('#download-link')).toBeVisible();
    await expect(page.locator('#download-link')).toHaveAttribute('href', /jobId=private-accepted-job/);

    await signOutFromAccount(page);
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
    await expect(page.locator('#review-identity')).toHaveText('Not selected');
    await expect(page.locator('#premium-title')).toHaveValue('');
    await expect(page.locator('#script-input')).toHaveValue('');
    await expect(page.locator('#accepted-video')).toBeHidden();
    await expect(page.locator('#download-link')).toBeHidden();
    await expect(page.locator('#result-gallery')).toContainText(/sign in/i);
  });

  test('late reads from the old signed-in generation cannot repopulate data after sign out', async ({ page }) => {
    let releaseReads;
    const deferredReads = new Promise((resolve) => { releaseReads = resolve; });
    await installPrivateWorkspace(page, { deferredReads });
    await page.goto('/#create');
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-in');

    await signOutFromAccount(page);
    releaseReads();
    await expect(page.locator('#connection-pill')).toHaveAttribute('data-state', 'signed-out');
    await expect(page.locator('#result-gallery')).toContainText(/sign in/i);
    await expect(page.locator('body')).not.toContainText(privateProject.title);
    await expect(page.locator('body')).not.toContainText(privateResult.title);
    await expect(page.locator(`[data-standard-identity-id="${privateIdentity.id}"]`)).toHaveCount(0);
    await expect(page.locator('#premium-title')).toHaveValue('');
    await expect(page.locator('#accepted-video')).toBeHidden();
  });
});

test.describe('navigation, keyboard, and responsive layout', () => {
  test('hash navigation supports browser Back and keeps the active destination explicit', async ({ page }) => {
    await installWorkspaceRoutes(page);
    await page.goto('/#create');

    await page.locator('[data-nav="videos"]:visible').first().click();
    await expect(page).toHaveURL(/#videos$/);
    await expect(page.locator('[data-nav="videos"]:visible').first()).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#videos-view')).toBeVisible();
    await expect(page.locator('[data-nav="identities"]:visible').first()).toHaveAttribute('href', '#identities');

    await page.goBack();
    await expect(page).toHaveURL(/#create$/);
    await expect(page.locator('#create-view')).toBeVisible();
    await expect(page.locator('[data-nav="create"]:visible').first()).toHaveAttribute('aria-current', 'page');
  });

  test('tier tabs work with arrow keys and Standard never requires a script', async ({ page }) => {
    await installWorkspaceRoutes(page);
    await page.goto('/#create');

    await page.locator('#standard-tab').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#premium-tab')).toBeFocused();
    await expect(page.locator('#premium-tab')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#standard-tab')).toBeFocused();
    await expect(page.locator('#standard-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#standard-panel textarea, #standard-panel [name="script"]')).toHaveCount(0);
  });

  test('mobile menu is named, traps focus, closes with Escape, and restores its opener', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installWorkspaceRoutes(page);
    await page.goto('/#create');

    const opener = page.locator('#open-menu');
    await expect(opener).toBeVisible();
    await expect(opener).toHaveAccessibleName(/menu/i);
    await opener.click();
    const dialog = page.locator('#mobile-menu');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('[data-nav="account"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('[data-menu-close]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'desktop-boundary', width: 1024, height: 900 },
    { name: 'intermediate', width: 900, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'phone', width: 390, height: 844 },
    { name: 'narrow-phone', width: 320, height: 720 },
  ]) {
    test(`${viewport.name} keeps the task and controls inside the viewport`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installWorkspaceRoutes(page);
      await page.goto('/?fixture=standard-lifecycle#create');
      await expect(page.locator('#create-view')).toBeVisible();

      const layout = await page.evaluate(() => {
        const selectors = ['#create-view', '#standard-panel', '#input-preview', '#video-title', '#review-inputs'];
        const bounds = selectors.map((selector) => {
          const element = document.querySelector(selector);
          const rect = element?.getBoundingClientRect();
          return { selector, left: rect?.left, right: rect?.right, width: rect?.width };
        });
        return {
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          bounds,
        };
      });
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport + 1);
      for (const bounds of layout.bounds) {
        expect(bounds.left, bounds.selector).toBeGreaterThanOrEqual(-1);
        expect(bounds.right, bounds.selector).toBeLessThanOrEqual(layout.viewport + 1);
        expect(bounds.width, bounds.selector).toBeGreaterThan(0);
      }

      if (viewport.width <= 1023) {
        await expect(page.locator('#open-menu')).toBeVisible();
        const menuSize = await page.locator('#open-menu').evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        expect(menuSize.width).toBeGreaterThanOrEqual(44);
        expect(menuSize.height).toBeGreaterThanOrEqual(44);
      } else {
        await expect(page.locator('#open-menu')).toBeHidden();
      }
    });
  }
});
