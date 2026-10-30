import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
  LUXIFY_CONSENT_MAX_DAYS,
} from './luxify-look-eligibility.js';

export const LUXIFY_CINEMATIC_CONSENT_PURPOSE = 'luxify-cinematic-generation';
export const LUXIFY_CONSENT_NOTICE_VERSION = 'luxify-cinematic-notice/v1-internal-canary';
export const LUXIFY_CONSENT_DEFAULT_MONTHS = 12;
export const LUXIFY_PROVIDER_RETENTION_DAYS = 180;
export const LUX_STAFF_EMAIL_DOMAIN = 'luxmarketingcompany.com';
export const LUX_STAFF_GRANT_SCOPE = 'creative_approval';
export const LUXIFY_CONSENT_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
export const LUXIFY_CONSENT_TERMINAL_REASONS = Object.freeze(['withdrawn', 'revoked', 'source_revoked']);

// The notice is versioned and hashed into every consent's evidence digest.
// Self-approved by the owner for an internal-only canary (outputs stay
// internal); counsel review is still required before any external use.
export const LUXIFY_CONSENT_NOTICE = Object.freeze({
  version: LUXIFY_CONSENT_NOTICE_VERSION,
  policyVersion: LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
  purpose: LUXIFY_CINEMATIC_CONSENT_PURPOSE,
  title: 'LUXIFY cinematic generation consent',
  paragraphs: Object.freeze([
    'You are authorizing LUX Video OS to generate cinematic AI video featuring your own likeness, using one exact avatar look that you already enrolled and consented to.',
    'Processing: your look and the scene prompt are sent to HeyGen (cinematic avatar generation). HeyGen uses BytePlus as a sub-processor for content filtering, which may process the request in Malaysia.',
    `Retention: BytePlus may retain filter inputs for up to ${LUXIFY_PROVIDER_RETENTION_DAYS} days. LUX keeps generated videos private to your account until you delete them.`,
    `Duration: this consent expires after ${LUXIFY_CONSENT_DEFAULT_MONTHS} months (never more than ${LUXIFY_CONSENT_MAX_DAYS} days). You can withdraw it at any time; withdrawal stops new LUXIFY renders for this look immediately. Revoking your underlying identity consent also ends this consent.`,
    'Internal canary: outputs from this canary stay internal to LUX and are not published.',
  ]),
  acknowledgments: Object.freeze({
    cinematicGenerationAuthorization: 'I authorize cinematic AI generation of my own likeness with this look.',
    providerProcessingAuthorization: 'I authorize processing by HeyGen and its sub-processor BytePlus, including up to 180 days of filter retention.',
  }),
});

const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
    : value;

export const sha256Hex = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');

export const LUXIFY_CONSENT_NOTICE_SHA256 = sha256Hex(LUXIFY_CONSENT_NOTICE);

function policyFailure(code, message, statusCode = 400, failureCategory = 'CONSENT') {
  return Object.assign(new Error(message), { code, statusCode, failureCategory });
}

/**
 * Default expiry is 12 calendar months, hard-capped at 365 days. A shorter
 * explicit window (whole days) is allowed; anything longer is refused.
 */
export function luxifyConsentExpiry(acceptedAt, { expiryDays } = {}) {
  const accepted = acceptedAt instanceof Date ? acceptedAt.getTime() : Date.parse(acceptedAt);
  if (!Number.isFinite(accepted)) throw policyFailure('LUXIFY_CONSENT_TIME_INVALID', 'Consent time is invalid.');
  const cap = accepted + LUXIFY_CONSENT_MAX_DAYS * 86_400_000;
  if (expiryDays !== undefined && expiryDays !== null) {
    if (!Number.isSafeInteger(expiryDays) || expiryDays < 1 || expiryDays > LUXIFY_CONSENT_MAX_DAYS) {
      throw policyFailure('LUXIFY_CONSENT_EXPIRY_INVALID', `Consent expiry must be between 1 and ${LUXIFY_CONSENT_MAX_DAYS} days.`);
    }
    return new Date(accepted + expiryDays * 86_400_000);
  }
  const calendar = new Date(accepted);
  calendar.setUTCMonth(calendar.getUTCMonth() + LUXIFY_CONSENT_DEFAULT_MONTHS);
  return new Date(Math.min(calendar.getTime(), cap));
}

export function normalizeStaffEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

const STAFF_EMAIL = /^[a-z0-9._%+-]{1,64}@luxmarketingcompany\.com$/;

/**
 * Oct 14 rule: only Lux staff approve creative assets. A staff grant needs a
 * verified luxmarketingcompany.com email AND an explicit grant. Each missing
 * element is refused with its own code; nothing is inferred from the domain.
 */
export function assertLuxStaffGrantRules({ email, emailVerified, explicitGrant }) {
  const normalized = normalizeStaffEmail(email);
  if (!STAFF_EMAIL.test(normalized)) {
    throw policyFailure('LUX_STAFF_DOMAIN_REQUIRED', 'Lux staff grants require a luxmarketingcompany.com email.', 403, 'ENTITLEMENT');
  }
  if (emailVerified !== true) {
    throw policyFailure('LUX_STAFF_EMAIL_UNVERIFIED', 'Lux staff grants require a verified email.', 403, 'ENTITLEMENT');
  }
  if (explicitGrant !== true) {
    throw policyFailure('LUX_STAFF_EXPLICIT_GRANT_REQUIRED', 'Lux staff grants require an explicit grant.', 403, 'ENTITLEMENT');
  }
  return normalized;
}

function challengeMac(secret, payload) {
  return createHmac('sha256', secret).update(`luxify-consent-challenge/v1\0${payload}`).digest('base64url');
}

function challengeSecret(env) {
  const secret = String(env?.VIDEO_OS_SESSION_SECRET || '');
  if (secret.length < 32) throw policyFailure('LUXIFY_CONSENT_UNAVAILABLE', 'Consent capture is unavailable.', 503, 'CONFIG_MISSING');
  return secret;
}

export function issueLuxifyConsentChallenge({ accountId, identityId, now = Date.now(), env = process.env }) {
  const expiresAt = now + LUXIFY_CONSENT_CHALLENGE_TTL_MS;
  // A random nonce makes every issued challenge distinct, so single-use
  // consumption (by digest, see luxifyConsentChallengeDigest) is per notice view.
  const payload = Buffer.from(JSON.stringify({ a: sha256Hex(accountId), i: identityId, n: LUXIFY_CONSENT_NOTICE_SHA256, e: expiresAt, r: randomBytes(16).toString('base64url') })).toString('base64url');
  return `${payload}.${challengeMac(challengeSecret(env), payload)}`;
}

export function verifyLuxifyConsentChallenge(token, { accountId, identityId, now = Date.now(), env = process.env }) {
  const invalid = () => policyFailure('LUXIFY_CONSENT_CHALLENGE_INVALID', 'The consent notice expired or changed. Reload and try again.', 409);
  if (typeof token !== 'string' || token.length > 1024) throw invalid();
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) throw invalid();
  const expected = Buffer.from(challengeMac(challengeSecret(env), payload));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (value?.a !== sha256Hex(accountId) || value?.i !== identityId || value?.n !== LUXIFY_CONSENT_NOTICE_SHA256
    || !Number.isSafeInteger(value?.e) || now >= value.e) throw invalid();
  return true;
}

/** Digest recorded when a verified challenge is consumed (single use, L-3). */
export function luxifyConsentChallengeDigest(token) {
  return createHash('sha256').update(`luxify-consent-challenge-use/v1\0${String(token)}`).digest('hex');
}
