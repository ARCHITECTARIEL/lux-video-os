import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

import {
  LUXIFY_CONSENT_NOTICE,
  LUXIFY_CONSENT_NOTICE_SHA256,
  LUXIFY_OPERATOR_ATTESTATION_VERSION,
  renderLuxifyOperatorAttestation,
} from '../../lib/luxify-consent-policy.js';

// Production serves /luxify-operator via a vercel.json rewrite; the static test
// server has no rewrites, so the spec serves the same HTML for that path.
const PAGE_HTML = readFileSync(new URL('../../public/luxify-operator.html', import.meta.url), 'utf8');

const ACCOUNT = 'user-subject-obo-1110';
const EMAIL = 'subject.obo@example.com';
const COOKIE = 'vos-session-secret-cookie-value';
const CHALLENGE_A = 'challenge-a.not-a-dom-token-aaaaaaaaaaaaaaaa';
const CHALLENGE_B = 'challenge-b.not-a-dom-token-bbbbbbbbbbbbbbbb';
const IDENTITY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDENTITY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVIDENCE = `video-os/consent-evidence/${'ab'.repeat(32)}/11111111-1111-4111-8111-111111111111.pdf`;
const CONSENT_PENDING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONSENT_ACTIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONSENT_SELF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NAME = 'Quincy Attestor';
const ATTESTED = '2026-11-09T11:00';
const FLAG_PROBE = 'luxify-obo-flag-check';
const SECRETS = [CHALLENGE_A, CHALLENGE_B, COOKIE, 'operator-should-not-be-sent'];

const IDENTITIES = [
  { identityId: IDENTITY_A, displayName: 'Look A', challenge: CHALLENGE_A },
  { identityId: IDENTITY_B, displayName: 'Look B', challenge: CHALLENGE_B },
];
const pendingConsent = { id: CONSENT_PENDING, identityId: IDENTITY_B, status: 'pending_confirmation', consentMode: 'operator_on_behalf', acceptedAt: '2026-11-09T12:00:00.000Z', attestedAt: '2026-11-09T16:00:00.000Z', expiresAt: '2027-11-09T16:00:00.000Z' };
const activeConsent = { id: CONSENT_ACTIVE, identityId: IDENTITY_A, status: 'active', consentMode: 'operator_on_behalf', acceptedAt: '2026-11-01T12:00:00.000Z', attestedAt: '2026-11-01T12:00:00.000Z', expiresAt: '2027-11-01T12:00:00.000Z' };
const selfConsent = { id: CONSENT_SELF, identityId: IDENTITY_A, status: 'active', acceptedAt: '2026-10-01T12:00:00.000Z', expiresAt: '2027-10-01T12:00:00.000Z' };

const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function contextBody(consents) {
  return {
    ok: true,
    notice: LUXIFY_CONSENT_NOTICE,
    noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
    attestationVersion: LUXIFY_OPERATOR_ATTESTATION_VERSION,
    identities: IDENTITIES,
    consents,
  };
}

function assertNoOperator(body) {
  expect(body).not.toHaveProperty('operatorAccountId');
  expect(body).not.toHaveProperty('operatorId');
  expect(body).not.toHaveProperty('staffAccountId');
  expect(JSON.stringify(body)).not.toContain('vos_session');
  expect(JSON.stringify(body)).not.toContain(COOKIE);
}

async function setup(page, onPost) {
  const calls = { posts: [], console: [], pageErrors: [] };
  page.on('console', message => calls.console.push(message.text()));
  page.on('pageerror', error => calls.pageErrors.push(error.message));
  await page.context().addCookies([{ name: 'vos_session', value: COOKIE, url: 'http://127.0.0.1:4187' }]);
  await page.route(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/|localhost(?::\d+)?\/).+/, route => route.abort());
  await page.route(url => url.pathname === '/luxify-operator', route => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }));
  await page.route(url => url.pathname === '/api/video-os-lite/luxify-consent', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    calls.posts.push({ body, headers: request.headers() });
    const [status, payload] = await onPost(body, calls.posts.length);
    return reply(route, payload, status);
  });
  return calls;
}

function assertQuiet(calls, extra = []) {
  const log = calls.console.join('\n');
  for (const secret of [...SECRETS, ...extra]) expect(log).not.toContain(secret);
  expect(calls.pageErrors).toEqual([]);
  for (const post of calls.posts) {
    assertNoOperator(post.body);
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.headers.cookie || '').toContain(`vos_session=${COOKIE}`);
  }
}

test('flag off hides the forms and shows not enabled', async ({ page }) => {
  const calls = await setup(page, () => [503, { ok: false, code: 'luxify_consent_obo_unavailable', error: 'On-behalf LUXIFY consent is turned off.' }]);
  await page.goto('/luxify-operator');
  await expect(page.locator('#operator')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#obo-state')).toContainText('not enabled');
  await expect(page.locator('#status')).toContainText('not enabled');
  await expect(page.locator('#lookup-panel')).toBeHidden();
  await expect(page.locator('#context-panel')).toBeHidden();
  await expect(page.locator('#find-subject')).toBeDisabled();
  await expect(page.locator('#load-context')).toBeDisabled();
  await expect(page.locator('#grant')).toBeDisabled();
  expect(await page.evaluate(() => location.search)).toBe('');
  expect(calls.posts.map(post => post.body)).toEqual([{ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE }]);
  assertQuiet(calls, [ACCOUNT, EMAIL, FLAG_PROBE]);
});

test('lookup then grant sends grant-on-behalf with no operator id', async ({ page }) => {
  const calls = await setup(page, body => {
    if (body.action === 'staff-lookup') return [200, { ok: true, accountId: ACCOUNT, accountRef: '…1110', emailVerified: true, identities: [] }];
    if (body.action === 'operator-context') return [200, contextBody([pendingConsent, activeConsent, selfConsent])];
    if (body.action === 'grant-on-behalf') {
      return [201, { ok: true, replayed: false, confirmationEmail: 'sent', confirmationExpiresAt: '2026-11-16T16:00:00.000Z', consent: { ...pendingConsent } }];
    }
    return [500, { ok: false, code: 'unexpected', error: 'Unexpected action.' }];
  });
  await page.goto('/luxify-operator');
  await expect(page.locator('#operator')).toHaveAttribute('data-state', 'enabled');
  await expect(page.locator('#lookup-panel')).toBeVisible();
  await expect(page.locator('#context-panel')).toBeHidden();
  await expect(page.locator('#find-subject')).toBeEnabled();
  expect(calls.posts.map(post => post.body)).toEqual([{ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE }]);
  await page.locator('#subject-email').fill(EMAIL);
  await page.locator('#find-subject').click();
  await expect(page.locator('#operator')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#attestation-version')).toContainText(LUXIFY_OPERATOR_ATTESTATION_VERSION);
  await expect(page.locator('#context-summary')).toContainText('1 waiting for the subject');
  await expect(page.locator('#context-summary')).toContainText('1 confirmed by the subject');
  await expect(page.locator('#subject-summary')).toContainText('…1110');
  await expect(page.locator('#subject-summary')).not.toContainText(EMAIL);
  await expect(page.locator('#subject-summary')).not.toContainText(ACCOUNT);
  await page.locator('#look').selectOption(IDENTITY_B);
  await page.locator('#subject-name').fill(NAME);
  await page.locator('#method').selectOption('recorded_verbal');
  await page.locator('#attested-at').fill(ATTESTED);
  await page.locator('#evidence-ref').fill(EVIDENCE);
  await page.locator('#ack-generation').check();
  await page.locator('#ack-processing').check();
  await expect(page.locator('#grant')).toBeDisabled();
  await page.locator('#attestation-confirmed').check();
  const expectedText = renderLuxifyOperatorAttestation({ subjectName: NAME, method: 'recorded_verbal', attestedAt: ATTESTED, identityId: IDENTITY_B }).text;
  await expect(page.locator('#attestation-text')).toHaveText(expectedText);
  await expect(page.locator('#grant')).toBeEnabled();
  await page.locator('#grant').click();
  await expect(page.locator('#status')).toContainText('Confirmation email sent');
  const grant = calls.posts.find(post => post.body.action === 'grant-on-behalf');
  expect(grant.body).toEqual({
    action: 'grant-on-behalf',
    onBehalfOfAccountId: ACCOUNT,
    identityId: IDENTITY_B,
    idempotencyKey: grant.body.idempotencyKey,
    challenge: CHALLENGE_B,
    noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
    cinematicGenerationAuthorization: true,
    providerProcessingAuthorization: true,
    subjectName: NAME,
    attestationMethod: 'recorded_verbal',
    attestedAt: new Date(ATTESTED).toISOString(),
    attestationEvidenceRef: EVIDENCE,
    attestationConfirmed: true,
  });
  expect(grant.body.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(calls.posts.map(post => post.body.action)).toEqual(['operator-context', 'staff-lookup', 'operator-context', 'grant-on-behalf', 'operator-context']);
  expect(calls.posts[0].body).toEqual({ action: 'operator-context', onBehalfOfAccountId: FLAG_PROBE });
  expect(calls.posts[1].body).toEqual({ action: 'staff-lookup', email: EMAIL });
  await expect(page.locator('#evidence-ref')).toHaveValue('');
  await expect(page.locator('#subject-name')).toHaveValue('');
  const rendered = await page.content();
  for (const secret of [CHALLENGE_A, CHALLENGE_B, COOKIE, EVIDENCE, NAME, ACCOUNT]) expect(rendered).not.toContain(secret);
  assertQuiet(calls, [ACCOUNT, EMAIL, EVIDENCE, NAME]);
});

test('a server error is rendered and the form stays open', async ({ page }) => {
  const calls = await setup(page, body => {
    if (body.action === 'operator-context') return [200, contextBody([])];
    return [409, { ok: false, code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', error: 'This look is not recorded in the subject account\'s own space.' }];
  });
  await page.goto('/luxify-operator');
  await page.locator('#subject-account').fill(ACCOUNT);
  await page.locator('#load-context').click();
  await expect(page.locator('#consents')).toContainText('No LUXIFY consents');
  await page.locator('#subject-name').fill(NAME);
  await page.locator('#method').selectOption('written');
  await page.locator('#attested-at').fill(ATTESTED);
  await page.locator('#evidence-ref').fill(EVIDENCE);
  await page.locator('#ack-generation').check();
  await page.locator('#ack-processing').check();
  await page.locator('#attestation-confirmed').check();
  await expect(page.locator('#grant')).toBeEnabled();
  await page.locator('#grant').click();
  await expect(page.locator('#status')).toContainText('not recorded in the subject account\'s own space');
  await expect(page.locator('#status')).toContainText('LUXIFY_LOOK_OWNERSHIP_UNPROVEN');
  await expect(page.locator('#context-panel')).toBeVisible();
  await expect(page.locator('#grant')).toBeEnabled();
  expect(calls.posts.filter(post => post.body.action === 'grant-on-behalf')).toHaveLength(1);
  assertNoOperator(calls.posts.at(-1).body);
  assertQuiet(calls, [EVIDENCE, NAME]);
});

test('withdraw sends operator-withdraw and a dismissed dialog does not', async ({ page }) => {
  let withdrawn = false;
  const calls = await setup(page, body => {
    if (body.action === 'operator-withdraw') {
      withdrawn = true;
      return [200, { ok: true, consent: { id: body.consentId, status: 'withdrawn' } }];
    }
    const consents = withdrawn
      ? [{ ...pendingConsent, status: 'withdrawn' }, activeConsent, selfConsent]
      : [pendingConsent, activeConsent, selfConsent];
    return [200, contextBody(consents)];
  });
  await page.goto('/luxify-operator');
  await page.locator('#subject-account').fill(ACCOUNT);
  await page.locator('#load-context').click();
  const pendingRow = page.locator('#consents li', { hasText: 'waiting for the subject to confirm' });
  await expect(pendingRow).toBeVisible();
  await expect(page.locator('#consents li', { hasText: 'confirmed by the subject' })).toBeVisible();
  await expect(page.locator('#consents li', { hasText: 'self' }).getByRole('button')).toHaveCount(0);
  page.once('dialog', dialog => dialog.dismiss());
  await pendingRow.getByRole('button', { name: 'Withdraw' }).click();
  expect(calls.posts.some(post => post.body.action === 'operator-withdraw')).toBe(false);
  page.once('dialog', dialog => {
    expect(dialog.message()).not.toContain(CONSENT_PENDING);
    return dialog.accept();
  });
  await pendingRow.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.locator('#status')).toContainText('Consent withdrawn');
  await expect(page.locator('#consents')).toContainText('withdrawn');
  const withdrawal = calls.posts.find(post => post.body.action === 'operator-withdraw');
  expect(withdrawal.body).toEqual({ action: 'operator-withdraw', consentId: CONSENT_PENDING });
  const rendered = await page.content();
  expect(rendered).not.toContain(CONSENT_PENDING);
  expect(rendered).not.toContain(CHALLENGE_A);
  expect(rendered).not.toContain(COOKIE);
  assertQuiet(calls, [ACCOUNT, CONSENT_PENDING]);
});
