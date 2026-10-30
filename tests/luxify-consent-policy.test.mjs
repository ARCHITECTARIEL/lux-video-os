import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_CONSENT_NOTICE,
  assertLuxStaffGrantRules,
  issueLuxifyConsentChallenge,
  luxifyConsentExpiry,
  verifyLuxifyConsentChallenge,
} from '../lib/luxify-consent-policy.js';

const DAY = 86_400_000;
const ENV = { VIDEO_OS_SESSION_SECRET: 'consent-policy-test-secret-at-least-32-bytes' };
const ACCOUNT = 'subject-account-test';
const IDENTITY = '0a0a0a0a-0000-4000-8000-000000000001';

test('default LUXIFY consent expiry is 12 calendar months', () => {
  const accepted = new Date('2026-11-02T10:00:00.000Z');
  assert.equal(luxifyConsentExpiry(accepted).toISOString(), '2027-11-02T10:00:00.000Z');
});

test('12-month default is hard-capped at 365 days across a leap day', () => {
  const accepted = new Date('2027-03-01T00:00:00.000Z');
  const expires = luxifyConsentExpiry(accepted);
  assert.equal(expires.getTime() - accepted.getTime(), 365 * DAY);
});

test('explicit expiry accepts 1..365 days and refuses anything longer or invalid', () => {
  const accepted = new Date('2026-11-02T10:00:00.000Z');
  assert.equal(luxifyConsentExpiry(accepted, { expiryDays: 30 }).getTime() - accepted.getTime(), 30 * DAY);
  assert.equal(luxifyConsentExpiry(accepted, { expiryDays: 365 }).getTime() - accepted.getTime(), 365 * DAY);
  for (const expiryDays of [366, 0, -1, 1.5, 10_000]) {
    assert.throws(() => luxifyConsentExpiry(accepted, { expiryDays }), { code: 'LUXIFY_CONSENT_EXPIRY_INVALID', statusCode: 400 });
  }
});

test('notice names HeyGen, BytePlus processing, 180-day retention and the 12-month expiry', () => {
  const text = [...LUXIFY_CONSENT_NOTICE.paragraphs, ...Object.values(LUXIFY_CONSENT_NOTICE.acknowledgments)].join(' ');
  assert.match(text, /HeyGen/);
  assert.match(text, /BytePlus/);
  assert.match(text, /180 days/);
  assert.match(text, /12 months/);
  assert.match(text, /365 days/);
  assert.match(text, /withdraw/i);
});

test('staff grant requires a luxmarketingcompany.com email, verification, and an explicit grant', () => {
  assert.equal(assertLuxStaffGrantRules({ email: ' Staff.Test@LuxMarketingCompany.com ', emailVerified: true, explicitGrant: true }), 'staff.test@luxmarketingcompany.com');
  for (const email of ['staff@example.test', 'staff@luxmarketingcompany.com.example.test', 'staff@sub.luxmarketingcompany.com', 'luxmarketingcompany.com', '']) {
    assert.throws(() => assertLuxStaffGrantRules({ email, emailVerified: true, explicitGrant: true }), { code: 'LUX_STAFF_DOMAIN_REQUIRED', statusCode: 403 });
  }
  assert.throws(() => assertLuxStaffGrantRules({ email: 'staff@luxmarketingcompany.com', emailVerified: false, explicitGrant: true }), { code: 'LUX_STAFF_EMAIL_UNVERIFIED' });
  assert.throws(() => assertLuxStaffGrantRules({ email: 'staff@luxmarketingcompany.com', emailVerified: 'yes', explicitGrant: true }), { code: 'LUX_STAFF_EMAIL_UNVERIFIED' });
  assert.throws(() => assertLuxStaffGrantRules({ email: 'staff@luxmarketingcompany.com', emailVerified: true }), { code: 'LUX_STAFF_EXPLICIT_GRANT_REQUIRED' });
  assert.throws(() => assertLuxStaffGrantRules({ email: 'staff@luxmarketingcompany.com', emailVerified: true, explicitGrant: 'true' }), { code: 'LUX_STAFF_EXPLICIT_GRANT_REQUIRED' });
});

test('consent challenge binds account, identity, notice and a short expiry', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const token = issueLuxifyConsentChallenge({ accountId: ACCOUNT, identityId: IDENTITY, now, env: ENV });
  assert.equal(verifyLuxifyConsentChallenge(token, { accountId: ACCOUNT, identityId: IDENTITY, now: now + 1000, env: ENV }), true);
  const invalid = { code: 'LUXIFY_CONSENT_CHALLENGE_INVALID', statusCode: 409 };
  assert.throws(() => verifyLuxifyConsentChallenge(token, { accountId: 'other-account-test', identityId: IDENTITY, now, env: ENV }), invalid);
  assert.throws(() => verifyLuxifyConsentChallenge(token, { accountId: ACCOUNT, identityId: '0a0a0a0a-0000-4000-8000-000000000002', now, env: ENV }), invalid);
  assert.throws(() => verifyLuxifyConsentChallenge(token, { accountId: ACCOUNT, identityId: IDENTITY, now: now + 11 * 60_000, env: ENV }), invalid);
  assert.throws(() => verifyLuxifyConsentChallenge(`${token}x`, { accountId: ACCOUNT, identityId: IDENTITY, now, env: ENV }), invalid);
  assert.throws(() => issueLuxifyConsentChallenge({ accountId: ACCOUNT, identityId: IDENTITY, now, env: {} }), { statusCode: 503 });
});
