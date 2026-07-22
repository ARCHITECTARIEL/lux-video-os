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

async function installAppRoutes(page, { results = [], project = null, omitVoiceId = null } = {}) {
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
  await page.route('**/api/video-os-lite/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, projects: project ? [project] : [] }) }));
  await page.route('**/api/video-os-lite/render', (route) => { renderRequests += 1; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Render forbidden in CEO UX test' }) }); });
  return { renderRequests: () => renderRequests };
}

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

  const cover = page.locator('#featured-cast-list [data-featured-key]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredKey))).toEqual(FEATURED.map((item) => item.key));

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
  await page.locator(`[data-featured-key="${ARIEL.key}"]`).click();
  await expect(page.locator('[data-voice-id="other-voice"]')).toHaveClass(/selected/);

  await page.reload();
  await expect(page.locator(`[data-featured-key="${KD.key}"]`)).toHaveClass(/selected/);
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
  await page.locator(`[data-featured-key="${KD.key}"]`).click();
  await page.locator('#voice-search').fill('Late 24');
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-voice-id="late-24"]')).toHaveAttribute('aria-pressed', 'true');
  expect(guard.renderRequests()).toBe(0);
});

test('a featured presenter fails visibly when its exact matched voice is unavailable', async ({ page }) => {
  await installAppRoutes(page, { omitVoiceId: KD.voiceId });
  await page.goto('/');
  const kd = page.locator(`[data-featured-key="${KD.key}"]`);
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
  const cover = page.locator('#featured-cast-list [data-featured-key]');
  await expect(cover).toHaveCount(3);
  expect(await cover.evaluateAll((nodes) => nodes.map((node) => node.dataset.featuredKey))).toEqual(FEATURED.map((item) => item.key));
  for (const item of FEATURED) await expect(page.locator(`[data-featured-key="${item.key}"]`)).toBeVisible();
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
