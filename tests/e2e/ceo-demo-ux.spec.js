import { expect, test } from '@playwright/test';

const ARIEL = { key: 'ariel', avatarId: 'featured:ariel', voiceId: 'featured:ariel:voice', label: 'Ariel' };
const OSO = { key: 'oso', avatarId: 'featured:oso', voiceId: 'featured:oso:voice', label: 'OSO' };
const KD = { key: 'kd', avatarId: 'featured:kd', voiceId: 'featured:kd:voice', label: 'KD' };
const FEATURED = [ARIEL, OSO, KD];

function avatar(item, overrides = {}) {
  return {
    id: item.avatarId,
    name: item.label,
    source: 'heygen',
    shared: false,
    active: true,
    providerReady: true,
    ...(item.key ? { featuredKey: item.key, matchedVoiceId: item.voiceId } : {}),
    archived: false,
    blocked: false,
    previewUrl: `https://images.example/${item.label.toLowerCase()}.jpg`,
    ...overrides,
  };
}

function voice(item, overrides = {}) {
  return { id: item.voiceId, name: `${item.label} voice`, source: 'heygen', providerReady: true, ...(item.key ? { featuredKey: item.key } : {}), archived: false, blocked: false, ...overrides };
}

async function installAppRoutes(page, { results = [], project = null, identities = [], omitVoiceId = null } = {}) {
  const shared = Array.from({ length: 24 }, (_, index) => ({
    id: `shared-${String(index).padStart(2, '0')}`,
    name: `Shared ${String(index).padStart(2, '0')}`,
    source: 'heygen',
    shared: true,
    active: true,
    providerReady: true,
    archived: false,
    blocked: false,
    providerOrder: index,
    previewUrl: `https://images.example/shared-${index}.jpg`,
  }));
  const avatars = [...FEATURED.map((item) => avatar(item)), ...shared, avatar({ avatarId: 'private-user', label: 'Private User' }, { shared: false })];
  const voices = [...FEATURED.map((item) => voice(item)), { id: 'duplicate-kd-name', name: 'KD voice', source: 'heygen', providerReady: true }, { id: 'other-voice', name: 'Other voice', source: 'heygen', providerReady: true }, ...Array.from({ length: 25 }, (_, index) => ({ id: `late-${index}`, name: `Late ${index}`, source: 'heygen', providerReady: true }))].filter((item) => item.id !== omitVoiceId);
  let renderRequests = 0;

  await page.route('https://images.example/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#d9c8a9"/></svg>' }));
  await page.route('**/api/video-os/talent', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, talent: { avatars, voices }, connection: { connected: true } }) }));
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: true, email: 'proof@example.test', account: { accountId: 'acct-proof', name: 'CEO Proof' }, credits: { accountId: 'acct-proof', balance: 180, reserved: 0 }, entitlements: { fullAccess: true } }) }));
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [{ id: 'heygen', name: 'HeyGen', configured: true, cost: 90 }], credits: { accountId: 'acct-proof', balance: 180, reserved: 0 }, entitlements: { fullAccess: true } }) }));
  await page.route('**/api/video-os-lite/results*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, results }) }));
  await page.route('**/api/video-os-lite/identities*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, identities }) }));
  await page.route('**/api/video-os-lite/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, projects: project ? [project] : [] }) }));
  await page.route('**/api/video-os-lite/render', (route) => { renderRequests += 1; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Render forbidden in CEO UX test' }) }); });
  return { renderRequests: () => renderRequests };
}

test('ready private identity appears before shared Cast and restores its recommended cloned voice', async ({ page }) => {
  const identity = { id: '4c2f26b6-cdd4-4d53-8e37-17e7858c679c', displayName: 'CEO Identity', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', portraitUrl: '/api/video-os-lite/asset?assetId=portrait-proof', ready: true };
  const project = {
    id: 'project-identity',
    identityId: identity.id,
    title: 'Private identity proof',
    script: 'Use only the internal identity reference.',
    avatar: { id: `identity-avatar:${identity.id}`, identityId: identity.id, name: identity.displayName, source: 'identity' },
    voice: { id: `identity-voice:${identity.id}`, identityId: identity.id, name: `${identity.displayName} cloned voice`, source: 'identity' },
  };
  const guard = await installAppRoutes(page, { identities: [identity], project });
  await page.route('**/api/video-os-lite/asset*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));
  await page.goto('/');

  await page.locator('#premium-tab').click();
  const privateCard = page.locator(`#premium-identity-list [data-premium-identity-id="${identity.id}"]`);
  await expect(privateCard).toHaveCount(1);
  await expect(privateCard).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#premium-title')).toHaveValue(project.title);
  await expect(page.locator('#script-input')).toHaveValue(project.script);
  await expect(page.locator('#generate-video')).toBeEnabled();
  expect(await page.evaluate(() => Boolean(document.querySelector('#my-cast-list')?.compareDocumentPosition(document.querySelector('#avatar-list')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  await page.reload();
  await page.locator('#premium-tab').click();
  await expect(page.locator(`#premium-identity-list [data-premium-identity-id="${identity.id}"]`)).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});

test('featured cast, curated list, voice priority, persistence, and completed Final Cut are connected', async ({ page }) => {
  const ready = {
    id: 'job-existing',
    status: 'SUCCEEDED',
    outputAccepted: true,
    title: 'Existing CEO proof',
    filename: 'existing-proof.mp4',
    url: '/api/video-os-lite/download?jobId=job-existing',
    avatar: { id: KD.avatarId, avatarId: KD.avatarId, name: 'KD' },
    voice: { id: KD.voiceId, voiceId: KD.voiceId, name: 'KD voice' },
    updatedAt: '2026-07-16T18:00:00Z',
  };
  const project = { id: 'project-existing', title: 'Existing CEO proof', script: 'No provider submission is permitted.', avatar: avatar(KD), voice: voice(KD) };
  const guard = await installAppRoutes(page, { results: [ready], project });
  await page.goto('/');
  await page.locator('#premium-tab').click();

  const cover = page.locator('#featured-cast-list [data-featured-key]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredKey))).toEqual(FEATURED.map((item) => item.key));

  const cast = page.locator('#avatar-list [data-avatar-id]');
  await expect(cast).toHaveCount(17);
  expect(new Set(await cast.evaluateAll((nodes) => nodes.map((node) => node.dataset.avatarId))).size).toBe(17);
  await expect(page.locator('[data-avatar-id="private-user"]')).toHaveCount(0);

  await expect(page.locator(`[data-voice-id="${KD.voiceId}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-voice-id="${KD.voiceId}"]`)).toContainText('Matched voice');
  expect(await page.locator('#voice-list [data-voice-id]').first().getAttribute('data-voice-id')).toBe(KD.voiceId);

  await page.locator('#voice-search').fill('Other voice');
  await page.locator('[data-voice-id="other-voice"]').click();
  await page.locator(`[data-featured-key="${ARIEL.key}"]`).click();
  await expect(page.locator('[data-voice-id="other-voice"]')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await page.locator('#premium-tab').click();
  await expect(page.locator(`[data-featured-key="${KD.key}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-voice-id="${KD.voiceId}"]`)).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-nav="videos"]:visible').first().click();
  await expect(page.locator('#download-link')).toHaveAttribute('href', /jobId=job-existing/);
  expect(guard.renderRequests()).toBe(0);
});


test('an explicit valid voice beyond the first 20 survives restoration and avatar changes', async ({ page }) => {
  const lateVoice = { id: 'late-24', name: 'Late 24', source: 'heygen', providerReady: true };
  const project = { id: 'project-late-voice', title: 'Explicit voice proof', script: 'Preserve the selected voice.', avatar: avatar(ARIEL), voice: lateVoice };
  const guard = await installAppRoutes(page, { project });
  await page.goto('/');
  await page.locator('#premium-tab').click();
  await page.locator(`[data-featured-key="${KD.key}"]`).click();
  await page.locator('#voice-search').fill('Late 24');
  await page.locator('[data-voice-id="late-24"]').click();
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#avatar-search').fill('Ariel');
  await page.locator(`[data-featured-key="${ARIEL.key}"]`).click();
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});

test('a featured presenter fails visibly when its exact matched voice is unavailable', async ({ page }) => {
  await installAppRoutes(page, { omitVoiceId: KD.voiceId });
  await page.goto('/');
  await page.locator('#premium-tab').click();
  const kd = page.locator(`[data-featured-key="${KD.key}"]`);
  await expect(kd).toBeDisabled();
  await expect(kd).toHaveAttribute('title', /matched voice.*unavailable/i);
  await expect(kd).toHaveAttribute('aria-pressed', 'false');
});

test('the newest in-progress job is not masked by an older completed video', async ({ page }) => {
  await installAppRoutes(page, { results: [
    { id: 'job-new', status: 'PROCESSING', outputAccepted: false, title: 'Newest proof' },
    { id: 'job-old', status: 'SUCCEEDED', outputAccepted: true, title: 'Older proof', url: '/api/video-os-lite/download?jobId=job-old' },
  ] });
  await page.goto('/#videos');
  await expect(page.locator('[data-job-id="job-new"]')).toHaveAttribute('data-job-state', 'PROCESSING');
  await expect(page.locator('#preview')).not.toHaveAttribute('data-preview-state', 'completed');
  await expect(page.locator('#accepted-video')).toBeHidden();
});

test('mobile keeps Ariel, OSO, and KD visible and ordered', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAppRoutes(page);
  await page.goto('/');
  await page.locator('#premium-tab').click();
  const cover = page.locator('#featured-cast-list [data-featured-key]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredKey))).toEqual(FEATURED.map((item) => item.key));
  for (const item of FEATURED) await expect(page.locator(`[data-featured-key="${item.key}"]`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const [name, results, state, copy] of [
  ['empty', [], null, /first video starts here/i],
  ['rendering', [{ id: 'job-rendering', status: 'PROCESSING', outputAccepted: false, title: 'CEO proof' }], 'PROCESSING', /processing/i],
  ['failed', [{ id: 'job-failed', status: 'FAILED_FINAL', outputAccepted: false, title: 'CEO proof' }], 'FAILED_FINAL', /failed/i],
]) {
  test(`Final Cut exposes the ${name} state without submitting a render`, async ({ page }) => {
    const guard = await installAppRoutes(page, { results });
    await page.goto('/#videos');
    if (state) await expect(page.locator('.result-card')).toHaveAttribute('data-job-state', state);
    await expect(page.locator('#result-gallery')).toContainText(copy);
    await expect(page.locator('#accepted-video')).toBeHidden();
    expect(guard.renderRequests()).toBe(0);
  });
}

test('anonymous and cross-account media responses remain denied', async ({ page }) => {
  await page.route('**/api/video-os-lite/download*', (route) => {
    const account = route.request().headers()['x-test-account'];
    return route.fulfill({ status: account === 'other-account' ? 404 : 401, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
  });
  await page.goto('/');
  const statuses = await page.evaluate(async () => {
    const anonymous = await fetch('/api/video-os-lite/download?jobId=job-existing');
    const crossAccount = await fetch('/api/video-os-lite/download?jobId=job-existing', { headers: { 'x-test-account': 'other-account' } });
    return [anonymous.status, crossAccount.status];
  });
  expect(statuses).toEqual([401, 404]);
});

test('Identity Studio handoff overrides a restored public voice with the ready paired voice', async ({ page }) => {
  const identity = { id: '6e5c233e-f798-4b74-8605-9e45e06fe831', displayName: 'Private Pair', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', portraitUrl: '/api/video-os-lite/asset?assetId=portrait-pair', ready: true };
  const project = { id: 'project-public-voice', title: 'Existing project', script: 'Use the requested private pair.', avatar: avatar(KD), voice: { id: 'other-voice', name: 'Other voice', source: 'heygen' } };
  const guard = await installAppRoutes(page, { identities: [identity], project });
  await page.route('**/api/video-os-lite/asset*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));

  await page.goto('/?identityId=' + identity.id);

  await expect(page).toHaveURL('/');
  await expect(page.locator('[data-standard-identity-id="' + identity.id + '"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#premium-tab').click();
  await expect(page.locator('[data-premium-identity-id="' + identity.id + '"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});

test('unavailable Identity Studio handoff is consumed without selecting private media', async ({ page }) => {
  const guard = await installAppRoutes(page);
  await page.goto('/?identityId=6e5c233e-f798-4b74-8605-9e45e06fe899');

  await expect(page).toHaveURL('/');
  await expect(page.locator('#toast')).toContainText('unavailable for this account');
  await expect(page.locator('#my-cast-list [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#voice-list [data-voice-id^="identity-voice:"]')).toHaveCount(0);
  expect(guard.renderRequests()).toBe(0);
});

test('a stale saved private identity fails closed to the authorized shared Cast', async ({ page }) => {
  const staleId = '6e5c233e-f798-4b74-8605-9e45e06fe877';
  const project = {
    id: 'project-stale-identity',
    identityId: staleId,
    title: 'Stale identity project',
    script: 'The archived identity must not restore.',
    avatar: { id: 'identity-avatar:' + staleId, identityId: staleId, name: 'Archived identity', source: 'identity' },
    voice: { id: 'identity-voice:' + staleId, identityId: staleId, name: 'Archived identity voice', source: 'identity' },
  };
  const guard = await installAppRoutes(page, { project, identities: [] });

  await page.goto('/');

  await expect(page.locator('#my-cast-list [aria-pressed="true"]')).toHaveCount(0);
  await page.locator('#premium-tab').click();
  await expect(page.locator('#avatar-list [data-avatar-id^="identity-avatar:"]')).toHaveCount(0);
  await expect(page.locator('#voice-list [data-voice-id^="identity-voice:"]')).toHaveCount(0);
  await expect(page.locator('[data-featured-key="' + ARIEL.key + '"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});
