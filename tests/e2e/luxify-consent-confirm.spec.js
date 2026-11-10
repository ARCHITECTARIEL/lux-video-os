import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Production serves /luxify-consent via a vercel.json rewrite; the static test
// server has no rewrites, so the spec serves the same HTML for that path.
const PAGE_HTML = readFileSync(new URL('../../public/luxify-consent.html', import.meta.url), 'utf8');

// CON-24: the emailed on-behalf confirmation link /luxify-consent#confirm=<token>.
const TOKEN = 'Tok_en-0123456789abcdefghijklmnopqrstuvwxyz'; // 43 chars, base64url
const NOTICE = {
  title: 'LUXIFY cinematic consent',
  paragraphs: ['You authorize cinematic LUXIFY renders of your enrolled look.'],
  acknowledgments: { cinematicGenerationAuthorization: 'I authorize generation.', providerProcessingAuthorization: 'I authorize processing.' },
};
const PENDING = { id: 'c0000000-0000-4000-8000-000000000001', identityId: 'i1', status: 'pending_confirmation', consentMode: 'operator_on_behalf', acceptedAt: '2026-11-09T12:00:00.000Z', attestedAt: '2026-11-09T11:00:00.000Z', expiresAt: '2027-11-09T12:00:00.000Z' };

const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, { getStatus = 200, confirm = [200, { ok: true, consent: { ...PENDING, status: 'active' } }] } = {}) {
  const calls = { posts: [], console: [], pageErrors: [] };
  let confirmed = false;
  page.on('console', message => calls.console.push(message.text()));
  page.on('pageerror', error => calls.pageErrors.push(error.message));
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, route => route.abort());
  await page.route(url => url.pathname === '/luxify-consent', route => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }));
  await page.route(url => url.pathname === '/api/video-os-lite/luxify-consent', async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      if (getStatus === 401) return reply(route, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' }, 401);
      return reply(route, { ok: true, notice: NOTICE, noticeSha256: 'a'.repeat(64), identities: [], consents: [{ ...PENDING, status: confirmed ? 'active' : 'pending_confirmation' }] });
    }
    calls.posts.push({ body: request.postDataJSON(), headers: request.headers() });
    const [status, body] = typeof confirm === 'function' ? confirm(calls.posts.length) : confirm;
    if (status === 200) confirmed = true;
    return reply(route, body, status);
  });
  return calls;
}

async function expectTokenGone(page, calls) {
  expect(await page.evaluate(() => location.href)).not.toContain('confirm=');
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(await page.content()).not.toContain(TOKEN);
  expect(calls.console.join('\n')).not.toContain(TOKEN);
  expect(calls.pageErrors).toEqual([]);
}

test('success: reads #confirm=, clears it from history, POSTs confirm-on-behalf as JSON, shows confirmed', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`/luxify-consent#confirm=${TOKEN}`);
  const panel = page.locator('#confirm-panel');
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await expectTokenGone(page, calls);
  expect(await page.evaluate(() => location.pathname)).toBe('/luxify-consent');
  await expect(page.locator('#confirm-pending li')).toHaveCount(1);
  await expect(page.locator('#consents')).toContainText('waiting for your confirmation');
  expect(calls.posts).toHaveLength(0); // nothing is confirmed without an explicit click
  await page.locator('#confirm').click();
  await expect(panel).toHaveAttribute('data-state', 'success');
  await expect(page.locator('#confirm-status')).toContainText('confirmed and active');
  expect(calls.posts).toHaveLength(1);
  expect(calls.posts[0].body).toEqual({ action: 'confirm-on-behalf', token: TOKEN });
  expect(calls.posts[0].headers['content-type']).toBe('application/json');
  await expect(page.locator('#confirm')).toBeHidden();
  await expect(page.locator('#consents')).toContainText('active');
  await expectTokenGone(page, calls);
});

const OUTCOMES = [
  ['expired', 409, 'LUXIFY_CONFIRMATION_EXPIRED', 'link expired'],
  ['used', 409, 'LUXIFY_CONFIRMATION_USED', 'already used'],
  ['closed', 409, 'LUXIFY_CONFIRMATION_CLOSED', 'can no longer be confirmed'],
  ['wrong_account', 404, 'LUXIFY_CONFIRMATION_INVALID', 'not for the account you are signed in to'],
  ['wrong_account', 409, 'LUXIFY_CONFIRMATION_EMAIL_MISMATCH', 'not for the account you are signed in to'],
  ['signed_out', 401, 'sign_in_required', 'Sign in with the email address'],
  ['flag_off', 503, 'luxify_consent_obo_unavailable', 'turned off right now'],
];
for (const [state, status, code, copy] of OUTCOMES) {
  test(`${code} (${status}) shows the ${state} state and drops the token`, async ({ page }) => {
    const calls = await setup(page, { confirm: [status, { ok: false, code, error: 'server text' }] });
    await page.goto(`/luxify-consent#confirm=${TOKEN}`);
    await page.locator('#confirm').click();
    await expect(page.locator('#confirm-panel')).toHaveAttribute('data-state', state);
    await expect(page.locator('#confirm-status')).toContainText(copy);
    await expect(page.locator('#confirm')).toBeHidden();
    expect(calls.posts).toHaveLength(1);
    await expectTokenGone(page, calls);
  });
}

test('generic error keeps the token in memory only and allows a retry', async ({ page }) => {
  const calls = await setup(page, { confirm: n => (n === 1 ? [500, { ok: false, code: 'luxify_consent_unavailable', error: 'boom' }] : [200, { ok: true, consent: { ...PENDING, status: 'active' } }]) });
  await page.goto(`/luxify-consent#confirm=${TOKEN}`);
  await page.locator('#confirm').click();
  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#confirm-status')).toContainText('Nothing was changed');
  await expect(page.locator('#confirm')).toBeEnabled();
  await expectTokenGone(page, calls);
  await page.locator('#confirm').click();
  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-state', 'success');
  expect(calls.posts.map(post => post.body.token)).toEqual([TOKEN, TOKEN]);
});

test('not signed in: the page load shows the sign-in state and never POSTs the token', async ({ page }) => {
  const calls = await setup(page, { getStatus: 401 });
  await page.goto(`/luxify-consent#confirm=${TOKEN}`);
  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-state', 'signed_out');
  await expect(page.locator('#confirm')).toBeHidden();
  expect(calls.posts).toHaveLength(0);
  await expectTokenGone(page, calls);
});

test('a malformed link is cleared and never sent', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/luxify-consent#confirm=short');
  await expect(page.locator('#confirm-panel')).toHaveAttribute('data-state', 'malformed');
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect(page.locator('#confirm')).toBeHidden();
  expect(calls.posts).toHaveLength(0);
});

test('without a #confirm= fragment the confirm panel stays hidden and history is untouched', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/luxify-consent#other=1');
  await expect(page.locator('#consents li')).toHaveCount(1);
  await expect(page.locator('#confirm-panel')).toBeHidden();
  expect(await page.evaluate(() => location.hash)).toBe('#other=1');
  expect(calls.posts).toHaveLength(0);
});
