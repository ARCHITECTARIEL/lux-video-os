import { expect, test } from '@playwright/test';

const ARIEL = { avatarId: 'ddd0cccc81334e50b493a12c34fb47b1', voiceId: 'ae2cee128a094fb4b9ea3f669ee46099', label: 'Ariel' };
const OSO = { avatarId: 'e8083119a1024dd0814b6ba7e9addfc4', voiceId: 'b874056efca4441aaa8befa518076eee', label: 'OSO' };
const KD = { avatarId: '880ad1223ca84f9590f21a0df4bf66b2', voiceId: 'ef08711aa68b400ba0213075e8d0b421', label: 'KD' };
const FEATURED = [ARIEL, OSO, KD];

function avatar(item, overrides = {}) {
  return {
    id: item.avatarId,
    name: item.label,
    source: 'heygen',
    shared: false,
    active: true,
    providerReady: true,
    archived: false,
    blocked: false,
    previewUrl: `https://images.example/${item.label.toLowerCase()}.jpg`,
    ...overrides,
  };
}

function voice(item, overrides = {}) {
  return { id: item.voiceId, name: `${item.label} voice`, source: 'heygen', providerReady: true, archived: false, blocked: false, ...overrides };
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
  await page.route('**/api/video-os-lite/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, signedIn: true, email: 'proof@example.test', account: { accountId: 'acct-proof', name: 'CEO Proof' }, credits: { accountId: 'acct-proof', balance: 180, reserved: 0 } }) }));
  await page.route('**/api/video-os-lite/providers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, providers: [{ id: 'heygen', name: 'HeyGen', configured: true, cost: 90 }], credits: { accountId: 'acct-proof', balance: 180, reserved: 0 } }) }));
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

  const privateCard = page.locator(`#my-cast-list [data-identity-id="${identity.id}"]`);
  await expect(privateCard).toHaveCount(1);
  await expect(privateCard).toHaveClass(/selected/);
  await expect(page.locator('#voice-list [data-voice-id]').first()).toHaveAttribute('data-voice-id', `identity-voice:${identity.id}`);
  await expect(page.locator(`[data-voice-id="identity-voice:${identity.id}"] .recommended-badge`)).toHaveText('Recommended');
  expect(await page.evaluate(() => Boolean(document.querySelector('#my-cast-list')?.compareDocumentPosition(document.querySelector('#avatar-list')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  await page.reload();
  await expect(page.locator(`#my-cast-list [data-identity-id="${identity.id}"]`)).toHaveClass(/selected/);
  await expect(page.locator('#voice-list [data-voice-id]').first()).toHaveAttribute('data-voice-id', `identity-voice:${identity.id}`);
  expect(guard.renderRequests()).toBe(0);
});

test('featured cast, curated list, voice priority, persistence, and completed Final Cut are connected', async ({ page }) => {
  const ready = {
    id: 'job-existing',
    status: 'ready',
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

  const cover = page.locator('#featured-cast-list [data-featured-avatar-id]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredAvatarId))).toEqual(FEATURED.map((item) => item.avatarId));

  const cast = page.locator('#avatar-list [data-avatar-id]');
  await expect(cast).toHaveCount(20);
  expect(await cast.evaluateAll((nodes) => nodes.map((node) => node.dataset.avatarId).slice(0, 3))).toEqual(FEATURED.map((item) => item.avatarId));
  expect(new Set(await cast.evaluateAll((nodes) => nodes.map((node) => node.dataset.avatarId))).size).toBe(20);
  await expect(page.locator('[data-avatar-id="private-user"]')).toHaveCount(0);

  await expect(page.locator(`[data-voice-id="${KD.voiceId}"]`)).toHaveClass(/selected/);
  await expect(page.locator(`[data-voice-id="${KD.voiceId}"] .recommended-badge`)).toHaveText('Recommended');
  expect(await page.locator('#voice-list [data-voice-id]').first().getAttribute('data-voice-id')).toBe(KD.voiceId);

  await page.locator('input[name="title"]').fill('Existing CEO proof');
  await page.locator('input[name="audience"]').fill('CEO team');
  await page.locator('textarea[name="objective"]').fill('Review the contained experience');
  await page.locator('textarea[name="script"]').fill('No provider submission is permitted.');
  await page.locator('[data-step-jump="1"]').click();
  await page.locator('#voice-search').fill('Other voice');
  await page.locator('[data-voice-id="other-voice"]').click();
  await page.locator(`[data-featured-avatar-id="${ARIEL.avatarId}"]`).click();
  await expect(page.locator('[data-voice-id="other-voice"]')).toHaveClass(/selected/);

  await page.reload();
  await expect(page.locator(`[data-featured-avatar-id="${KD.avatarId}"]`)).toHaveClass(/selected/);
  await expect(page.locator(`[data-voice-id="${KD.voiceId}"]`)).toHaveClass(/selected/);

  await expect(page.locator('#preview')).toHaveAttribute('data-preview-state', 'completed');
  const player = page.locator('#preview .final-preview-media');
  await expect(player).toHaveCount(1);
  await expect(player).toHaveAttribute('controls', '');
  await expect(player).toHaveAttribute('src', /jobId=job-existing.*disposition=inline/);
  await expect(page.locator('#download-link')).toHaveAttribute('href', /jobId=job-existing/);
  expect(guard.renderRequests()).toBe(0);
});


test('an explicit valid voice beyond the first 20 survives restoration and avatar changes', async ({ page }) => {
  const lateVoice = { id: 'late-24', name: 'Late 24', source: 'heygen', providerReady: true };
  const project = { id: 'project-late-voice', title: 'Explicit voice proof', script: 'Preserve the selected voice.', avatar: avatar(ARIEL), voice: lateVoice };
  const guard = await installAppRoutes(page, { project });
  await page.goto('/');
  await page.locator('input[name="title"]').fill('Explicit voice proof');
  await page.locator('input[name="audience"]').fill('CEO team');
  await page.locator('textarea[name="objective"]').fill('Preserve the selected voice');
  await page.locator('textarea[name="script"]').fill('Preserve the selected voice.');
  await page.locator('[data-step-jump="1"]').click();
  await page.locator(`[data-featured-avatar-id="${KD.avatarId}"]`).click();
  await page.locator('#voice-search').fill('Late 24');
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});

test('a featured presenter fails visibly when its exact matched voice is unavailable', async ({ page }) => {
  await installAppRoutes(page, { omitVoiceId: KD.voiceId });
  await page.goto('/');
  const kd = page.locator(`[data-featured-avatar-id="${KD.avatarId}"]`);
  await expect(kd).toBeDisabled();
  await expect(kd).toContainText("KD's matched voice is unavailable");
  await expect(kd).toHaveAttribute('aria-pressed', 'false');
});

test('the newest in-progress job is not masked by an older completed video', async ({ page }) => {
  await installAppRoutes(page, { results: [
    { id: 'job-new', status: 'rendering', title: 'Newest proof' },
    { id: 'job-old', status: 'ready', title: 'Older proof', url: '/api/video-os-lite/download?jobId=job-old' },
  ] });
  await page.goto('/');
  await expect(page.locator('#preview')).toHaveAttribute('data-preview-state', 'rendering');
  await expect(page.locator('#preview-empty')).toContainText(/Newest proof.*still rendering/i);
  await expect(page.locator('#preview .final-preview-media')).toHaveCount(0);
});

test('mobile keeps Ariel, OSO, and KD visible and ordered', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAppRoutes(page);
  await page.goto('/');
  const cover = page.locator('#featured-cast-list [data-featured-avatar-id]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredAvatarId))).toEqual(FEATURED.map((item) => item.avatarId));
  for (const item of FEATURED) await expect(page.locator(`[data-featured-avatar-id="${item.avatarId}"]`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const [name, results, state, copy] of [
  ['empty', [], 'empty', /No video yet/i],
  ['rendering', [{ id: 'job-rendering', status: 'rendering', title: 'CEO proof' }], 'rendering', /still rendering/i],
  ['failed', [{ id: 'job-failed', status: 'failed', title: 'CEO proof' }], 'failed', /could not be completed/i],
]) {
  test(`Final Cut exposes the ${name} state without submitting a render`, async ({ page }) => {
    const guard = await installAppRoutes(page, { results });
    await page.goto('/');
    await expect(page.locator('#preview')).toHaveAttribute('data-preview-state', state);
    await expect(page.locator('#preview-empty')).toContainText(copy);
    await expect(page.locator('#preview .final-preview-media')).toHaveCount(0);
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
  const identity = { id: '6e5c233e-f798-4b74-8605-9e45e06fe831', displayName: 'Private Pair', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', portraitUrl: '/api/video-os-lite/asset?assetId=portrait-pair' };
  const project = { id: 'project-public-voice', title: 'Existing project', script: 'Use the requested private pair.', avatar: avatar(KD), voice: { id: 'other-voice', name: 'Other voice', source: 'heygen' } };
  const guard = await installAppRoutes(page, { identities: [identity], project });
  await page.route('**/api/video-os-lite/asset*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));

  await page.goto('/?identityId=' + identity.id);

  await expect(page).toHaveURL('/');
  await expect(page.locator('#my-cast-list [data-identity-id="' + identity.id + '"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-voice-id="identity-voice:' + identity.id + '"]')).toHaveClass(/selected/);
  expect(guard.renderRequests()).toBe(0);
});

test('unavailable Identity Studio handoff is consumed without selecting private media', async ({ page }) => {
  const guard = await installAppRoutes(page);
  await page.goto('/?identityId=6e5c233e-f798-4b74-8605-9e45e06fe899');

  await expect(page).toHaveURL('/');
  await expect(page.locator('#toast')).toContainText('unavailable for this account');
  await expect(page.locator('#my-cast-list .selected')).toHaveCount(0);
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

  await expect(page.locator('#my-cast-list .selected')).toHaveCount(0);
  await expect(page.locator('#avatar-list [data-avatar-id^="identity-avatar:"]')).toHaveCount(0);
  await expect(page.locator('#voice-list [data-voice-id^="identity-voice:"]')).toHaveCount(0);
  await expect(page.locator('[data-featured-avatar-id="' + ARIEL.avatarId + '"]')).toHaveClass(/selected/);
  expect(guard.renderRequests()).toBe(0);
});