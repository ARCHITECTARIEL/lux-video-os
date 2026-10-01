import { expect, test } from '@playwright/test';

const READY = {
  available: true,
  reason: 'ready',
  message: 'AI writing is available. Review suggestions before using them.',
  limits: { maxDraftCharacters: 900, maxBriefCharacters: 2000, maxRevisionCharacters: 600 },
};

const SETUP_REQUIRED = {
  ...READY,
  available: false,
  reason: 'setup_required',
  message: 'AI writing needs its server connection and usage limits configured.',
};

const SIGNED_OUT = { ok: true, signedIn: false };
const SIGNED_IN = {
  ok: true,
  signedIn: true,
  email: 'writer@example.test',
  account: {
    accountId: 'writer-account',
    name: 'Writer workspace',
    subscription: { plan: 'Contained test', status: 'active' },
  },
  credits: { accountId: 'writer-account', balance: 0, reserved: 0 },
  entitlements: { fullAccess: true },
};

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

async function installRoutes(page, {
  session: initialSession = SIGNED_IN,
  readiness = READY,
  project = null,
  results = [],
  onCopywriterPost,
} = {}) {
  let currentSession = initialSession;
  let copywriterGets = 0;
  const copywriterPosts = [];
  const projectWrites = [];
  const renderWrites = [];
  const externalRequests = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url());
  });
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, (route) => route.abort('blockedbyclient'));
  await page.route('**/api/video-os-lite/session', (route) => {
    if (route.request().method() === 'POST') {
      currentSession = SIGNED_OUT;
      return route.fulfill({ json: SIGNED_OUT });
    }
    return route.fulfill({ json: currentSession });
  });
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ json: {
    ok: true,
    providers: [],
    credits: currentSession.credits || { balance: 0, reserved: 0 },
    entitlements: currentSession.entitlements || {},
  } }));
  await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill({ json: { ok: true, identities: [], providerSubmissionEnabled: false } }));
  await page.route('**/api/video-os/talent', (route) => route.fulfill({ json: { ok: true, talent: { avatars: [], voices: [] }, connection: { connected: false } } }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({ json: { ok: true, results } }));
  await page.route('**/api/video-os-lite/projects', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, projects: project ? [project] : [] } });
    projectWrites.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, json: { ok: false, error: 'Project writes are forbidden in Copywriter tests.' } });
  });
  await page.route('**/api/video-os-lite/render', (route) => {
    renderWrites.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, json: { ok: false, error: 'Render writes are forbidden in Copywriter tests.' } });
  });
  await page.route('**/api/video-os-lite/copywriter', async (route) => {
    if (route.request().method() === 'GET') {
      copywriterGets += 1;
      if (!currentSession.signedIn) return route.fulfill({ status: 401, json: { ok: false, code: 'sign_in_required', error: 'Sign in to use AI writing.' } });
      return route.fulfill({ json: { ok: true, copywriter: readiness } });
    }
    const body = route.request().postDataJSON();
    copywriterPosts.push(body);
    if (onCopywriterPost) return onCopywriterPost(route, body, copywriterPosts.length);
    return route.fulfill({ json: { ok: true, result: { text: 'A reviewable AI candidate.', operation: body.operation, requestId: body.idempotencyKey } } });
  });

  return {
    copywriterGets: () => copywriterGets,
    copywriterPosts,
    projectWrites,
    renderWrites,
    externalRequests,
    setSession(value) { currentSession = value; },
  };
}

async function openCopywriter(page) {
  await page.goto('/#copywriter');
  await expect(page.locator('#copywriter-view')).toBeVisible();
  await expect(page.locator('[data-nav="copywriter"]').first()).toHaveAttribute('aria-current', 'page');
}

async function fillBrief(page, overrides = {}) {
  await page.locator('#copywriter-topic').fill(overrides.topic || 'A better customer welcome');
  await page.locator('#copywriter-audience').fill(overrides.audience || 'New customers');
  await page.locator('#copywriter-goal').selectOption(overrides.goal || 'sales');
  await page.locator('#copywriter-tone').selectOption(overrides.tone || 'warm');
  await page.locator('#copywriter-key-points').fill(overrides.keyPoints || 'Start quickly\nKnow where to get help');
  await page.locator('#copywriter-cta').fill(overrides.callToAction || 'Reply with your first question.');
}

test('signed-out Copywriter is honest and cannot draft', async ({ page }) => {
  const guard = await installRoutes(page, { session: SIGNED_OUT });
  await openCopywriter(page);

  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'signed-out');
  await expect(page.locator('#copywriter-status')).toContainText(/sign in/i);
  await expect(page.locator('#copywriter-draft')).toBeDisabled();
  await expect(page.locator('#copywriter-candidate-panel')).toBeHidden();
  expect(guard.copywriterPosts).toHaveLength(0);
  expect(guard.projectWrites).toHaveLength(0);
  expect(guard.renderWrites).toHaveLength(0);
});

test('missing setup stays unavailable while configured readiness enables a complete brief', async ({ page }) => {
  await installRoutes(page, { readiness: SETUP_REQUIRED });
  await openCopywriter(page);
  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'missing-setup');
  await expect(page.locator('#copywriter-availability')).toContainText(/setup|connection/i);
  await fillBrief(page);
  await expect(page.locator('#copywriter-draft')).toBeDisabled();
});

test('draft response remains a candidate until explicit acceptance', async ({ page }) => {
  const candidate = 'Welcome. Here is the one thing to do first. Reply when you are ready.';
  const guard = await installRoutes(page, {
    onCopywriterPost: (route, body) => route.fulfill({ json: { ok: true, result: { text: candidate, operation: body.operation, requestId: body.idempotencyKey } } }),
  });
  await openCopywriter(page);
  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'ready');
  await fillBrief(page);
  await page.locator('#copywriter-draft').click();

  await expect(page.locator('#copywriter-candidate-panel')).toBeVisible();
  await expect(page.locator('#copywriter-candidate-state')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#copywriter-candidate')).toHaveValue(candidate);
  await expect(page.locator('#copywriter-working-draft')).toHaveValue('');
  const request = guard.copywriterPosts[0];
  expect(request).toMatchObject({
    operation: 'draft',
    brief: {
      topic: 'A better customer welcome',
      audience: 'New customers',
      goal: 'sales',
      tone: 'warm',
      keyPoints: 'Start quickly\nKnow where to get help',
      callToAction: 'Reply with your first question.',
    },
  });
  expect(request.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(request).not.toHaveProperty('accountId');
  expect(request).not.toHaveProperty('projectId');
  await page.locator('#copywriter-accept').click();
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(candidate);
  await expect(page.locator('#copywriter-candidate-state')).toHaveAttribute('data-state', 'accepted');
  await expect(page.locator('#copywriter-accept')).toBeDisabled();
  expect(guard.projectWrites).toHaveLength(0);
  expect(guard.renderWrites).toHaveLength(0);
  expect(guard.externalRequests).toEqual([]);
});

test('candidate markup is rendered only as editable text and cannot create active DOM', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__copywriterXss=true"><script>window.__copywriterXss=true</script>Keep this as text.';
  await installRoutes(page, {
    onCopywriterPost: (route, body) => route.fulfill({ json: { ok: true, result: { text: hostile, operation: body.operation, requestId: body.idempotencyKey } } }),
  });
  await openCopywriter(page);
  await fillBrief(page);
  await page.locator('#copywriter-draft').click();

  await expect(page.locator('#copywriter-candidate')).toHaveValue(hostile);
  await expect(page.locator('#copywriter-candidate-panel img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__copywriterXss)).toBeUndefined();
  await page.locator('#copywriter-accept').click();
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(hostile);
  expect(await page.evaluate(() => window.__copywriterXss)).toBeUndefined();
});

test('a candidate with a mismatched request identity is rejected without touching the draft', async ({ page }) => {
  await installRoutes(page, {
    onCopywriterPost: (route, body) => route.fulfill({ json: {
      ok: true,
      result: { text: 'Wrong response identity', operation: body.operation, requestId: '22222222-2222-4222-8222-222222222222' },
    } }),
  });
  await openCopywriter(page);
  await fillBrief(page);
  const draft = 'Keep this working draft.';
  await page.locator('#copywriter-working-draft').fill(draft);
  await page.locator('#copywriter-hook').click();

  await expect(page.locator('#copywriter-candidate-panel')).toBeHidden();
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(draft);
  await expect(page.locator('#copywriter-status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#copywriter-status')).toContainText(/incomplete candidate/i);
});

for (const [button, operation, instructions] of [
  ['#copywriter-shorten', 'shorten', ''],
  ['#copywriter-hook', 'improve_hook', ''],
  ['#copywriter-revise', 'revise', 'Make the ending more direct.'],
]) {
  test(`${operation} proposes a review candidate without replacing the edited draft`, async ({ page }) => {
    const guard = await installRoutes(page);
    await openCopywriter(page);
    await fillBrief(page);
    const edited = 'My manually edited working draft must remain until I accept a candidate.';
    await page.locator('#copywriter-working-draft').fill(edited);
    if (instructions) await page.locator('#copywriter-instructions').fill(instructions);
    await page.locator(button).click();

    await expect(page.locator('#copywriter-candidate-panel')).toBeVisible();
    await expect(page.locator('#copywriter-working-draft')).toHaveValue(edited);
    expect(guard.copywriterPosts).toHaveLength(1);
    expect(guard.copywriterPosts[0]).toMatchObject({ operation, draft: edited });
    if (instructions) expect(guard.copywriterPosts[0].instructions).toBe(instructions);
    else expect(guard.copywriterPosts[0]).not.toHaveProperty('instructions');
    await page.locator('#copywriter-discard').click();
    await expect(page.locator('#copywriter-candidate-panel')).toBeHidden();
    await expect(page.locator('#copywriter-working-draft')).toHaveValue(edited);
  });
}

test('a response becomes stale when its brief or working draft changes in flight', async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await installRoutes(page, {
    onCopywriterPost: async (route, body) => {
      await pending;
      return route.fulfill({ json: { ok: true, result: { text: 'Late candidate', operation: body.operation, requestId: body.idempotencyKey } } });
    },
  });
  await openCopywriter(page);
  await fillBrief(page);
  await page.locator('#copywriter-working-draft').fill('Keep this edited draft.');
  await page.locator('#copywriter-shorten').click();
  await page.locator('#copywriter-working-draft').fill('Newer edit while the response is pending.');
  release();

  await expect(page.locator('#copywriter-candidate-panel')).toBeVisible();
  await expect(page.locator('#copywriter-candidate-state')).toHaveAttribute('data-state', 'stale');
  await expect(page.locator('#copywriter-accept')).toBeDisabled();
  await expect(page.locator('#copywriter-working-draft')).toHaveValue('Newer edit while the response is pending.');
});

test('copying and active-tier handoff preserve separate Standard and Premium drafts', async ({ page }) => {
  await page.addInitScript(() => {
    window.__copiedText = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__copiedText.push(text); } },
    });
  });
  const project = {
    id: PROJECT_ID,
    title: 'Existing Premium title',
    script: 'Keep this existing Premium script until overwrite is confirmed.',
    avatar: { id: 'shared:avatar:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Presenter', source: 'heygen' },
    voice: { id: 'shared:voice:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Voice', source: 'heygen' },
  };
  const guard = await installRoutes(page, { project });
  await page.goto('/#create');
  await page.locator('[data-nav="copywriter"]:visible').first().click();
  await expect(page.locator('#copywriter-view')).toBeVisible();
  const draft = 'Use this approved draft only after an explicit handoff.';
  await page.locator('#copywriter-working-draft').fill(draft);
  expect(await page.evaluate(() => window.__copiedText)).toEqual([]);
  await page.locator('#copywriter-copy').click();
  expect(await page.evaluate(() => window.__copiedText)).toEqual([draft]);

  await page.locator('#copywriter-use-premium').click();
  await expect(page).toHaveURL(/#create$/);
  await expect(page.locator('#standard-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#standard-scripted-script')).toHaveValue(draft);
  await expect(page.locator('#script-input')).toHaveValue(project.script);
  await expect(page.locator('#copywriter-status')).toContainText('moved to Standard');

  await page.locator('#premium-tab').click();
  await page.locator('[data-nav="copywriter"]:visible').first().click();
  await page.locator('#copywriter-use-premium').click();
  await expect(page.locator('#premium-handoff-dialog')).toBeVisible();
  await expect(page.locator('#script-input')).toHaveValue(project.script);
  await page.getByRole('button', { name: 'Keep current script' }).click();
  await expect(page.locator('#script-input')).toHaveValue(project.script);
  await page.locator('#copywriter-use-premium').click();
  await page.locator('#premium-handoff-confirm').click();
  await expect(page).toHaveURL(/#create$/);
  await expect(page.locator('#premium-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#script-input')).toHaveValue(draft);
  await expect(page.locator('#copywriter-status')).toContainText('moved to Premium');
  expect(guard.projectWrites).toHaveLength(0);
  expect(guard.renderWrites).toHaveLength(0);
});

test('an active Premium job blocks handoff only when Premium is the active tier', async ({ page }) => {
  const project = {
    id: PROJECT_ID,
    title: 'Active Premium project',
    script: 'Existing active script.',
    avatar: { id: 'shared:avatar:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Presenter', source: 'heygen' },
    voice: { id: 'shared:voice:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Voice', source: 'heygen' },
  };
  await installRoutes(page, {
    project,
    results: [{ id: 'active-premium-job', projectId: PROJECT_ID, tier: 'premium', status: 'PROCESSING', outputAccepted: false, title: project.title }],
  });
  await page.goto('/#create');
  await page.locator('#premium-tab').click();
  await page.locator('[data-nav="copywriter"]:visible').first().click();
  await page.locator('#copywriter-working-draft').fill('A new draft that must not overwrite active work.');
  await expect(page.locator('#copywriter-use-premium')).toBeDisabled();
  await expect(page.locator('#copywriter-premium-note')).toBeVisible();
  await expect(page.locator('#copywriter-premium-note')).toContainText(/active tier is locked/i);
});

test('errors preserve the working draft, do not retry automatically, and a new attempt uses a new key', async ({ page }) => {
  const guard = await installRoutes(page, {
    onCopywriterPost: (route, body, attempt) => attempt === 1
      ? route.fulfill({ status: 502, json: { ok: false, code: 'generation_failed', error: 'AI writing could not complete this request. Your draft is unchanged.' } })
      : route.fulfill({ json: { ok: true, result: { text: 'Second explicit candidate', operation: body.operation, requestId: body.idempotencyKey } } }),
  });
  await openCopywriter(page);
  await fillBrief(page);
  const draft = 'Preserve this draft through the failed request.';
  await page.locator('#copywriter-working-draft').fill(draft);
  await page.locator('#copywriter-hook').click();
  await expect(page.locator('#copywriter-status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#copywriter-status')).toContainText(/unchanged/i);
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(draft);
  expect(guard.copywriterPosts).toHaveLength(1);
  await page.waitForTimeout(50);
  expect(guard.copywriterPosts).toHaveLength(1);

  await page.locator('#copywriter-hook').click();
  await expect(page.locator('#copywriter-candidate')).toHaveValue('Second explicit candidate');
  expect(guard.copywriterPosts).toHaveLength(2);
  expect(guard.copywriterPosts[1].idempotencyKey).not.toBe(guard.copywriterPosts[0].idempotencyKey);
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(draft);
});

test('rate limiting becomes an explicit alert and preserves the local draft', async ({ page }) => {
  const guard = await installRoutes(page, {
    onCopywriterPost: (route) => route.fulfill({ status: 429, json: {
      ok: false,
      code: 'rate_limited',
      error: 'The daily AI-writing limit has been reached. Your draft is unchanged.',
    } }),
  });
  await openCopywriter(page);
  await fillBrief(page);
  const draft = 'This local text survives the usage-limit response.';
  await page.locator('#copywriter-working-draft').fill(draft);
  await page.locator('#copywriter-shorten').click();

  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'rate-limited');
  await expect(page.locator('#copywriter-status')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#copywriter-status')).toContainText(/daily.*limit.*unchanged/i);
  await expect(page.locator('#copywriter-working-draft')).toHaveValue(draft);
  await expect(page.locator('#copywriter-candidate-panel')).toBeHidden();
  expect(guard.copywriterPosts).toHaveLength(1);
});

test('the exact localhost Copywriter fixture is deterministic and sends no mutation request', async ({ page }) => {
  const guard = await installRoutes(page);
  const mutations = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) mutations.push(request.url());
  });
  await page.goto('/?fixture=copywriter#copywriter');
  await expect(page.locator('#copywriter-fixture-banner')).toBeVisible();
  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'fixture');
  await fillBrief(page);
  await page.locator('#copywriter-draft').click();
  await expect(page.locator('#copywriter-candidate-panel')).toBeVisible();
  await expect(page.locator('#copywriter-candidate')).not.toHaveValue('');
  await page.locator('#copywriter-accept').click();
  await expect(page.locator('#copywriter-working-draft')).not.toHaveValue('');
  expect(guard.copywriterPosts).toHaveLength(0);
  expect(guard.projectWrites).toHaveLength(0);
  expect(guard.renderWrites).toHaveLength(0);
  expect(mutations).toEqual([]);
});

test('sign out clears Copywriter state and a late old-account response cannot restore it', async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await installRoutes(page, {
    onCopywriterPost: async (route, body) => {
      await pending;
      return route.fulfill({ json: { ok: true, result: { text: 'Private late candidate', operation: body.operation, requestId: body.idempotencyKey } } });
    },
  });
  await openCopywriter(page);
  await fillBrief(page);
  await page.locator('#copywriter-working-draft').fill('Private working draft');
  await page.locator('#copywriter-shorten').click();
  await page.locator('[data-nav="account"]:visible').first().click();
  await page.locator('#open-login').click();
  await page.locator('#sign-out').click();
  release();

  await expect(page.locator('#copywriter-working-draft')).toHaveValue('');
  await expect(page.locator('#copywriter-topic')).toHaveValue('');
  await expect(page.locator('#copywriter-candidate-panel')).toBeHidden();
  await expect(page.locator('#copywriter-availability')).toHaveAttribute('data-state', 'signed-out');
  await expect(page.locator('body')).not.toContainText('Private late candidate');
});

test('Copywriter navigation and workbench remain keyboard usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page);
  await openCopywriter(page);
  await expect(page.getByLabel('Title or topic')).toHaveAttribute('maxlength', '120');
  await expect(page.getByLabel('Audience')).toHaveAttribute('maxlength', '160');
  await page.locator('#copywriter-topic').focus();
  await page.keyboard.type('Keyboard topic');
  await page.keyboard.press('Tab');
  await expect(page.locator('#copywriter-audience')).toBeFocused();
  await page.locator('#open-menu').click();
  await expect(page.locator('#mobile-menu [data-nav="copywriter"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('#mobile-menu [data-nav="copywriter"]').press('Enter');
  await expect(page.locator('#mobile-menu')).toBeHidden();
  await expect(page.locator('#main')).toBeFocused();

  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 720 : 900 });
    const bounds = await page.evaluate(() => {
      const view = document.querySelector('#copywriter-view').getBoundingClientRect();
      const form = document.querySelector('#copywriter-form').getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewLeft: view.left,
        viewRight: view.right,
        formLeft: form.left,
        formRight: form.right,
      };
    });
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.viewLeft).toBeGreaterThanOrEqual(-1);
    expect(bounds.viewRight).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.formLeft).toBeGreaterThanOrEqual(-1);
    expect(bounds.formRight).toBeLessThanOrEqual(bounds.viewport + 1);
  }
});
