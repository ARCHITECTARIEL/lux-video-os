const DEFAULT_TESTER_DOMAINS = ['luxmarketingcompany.com'];
const DEFAULT_TESTER_EMAILS = ['arielsmailbox@gmail.com'];
const DEFAULT_TESTER_ACCOUNTS = [
  'user-ce3c497416d3bed66a0a6516',
];
export const REGISTERED_TESTER_ACCOUNTS = new Set();

export function registeredTesterAccountCount() {
  return REGISTERED_TESTER_ACCOUNTS.size;
}

export function registerTesterAccountId(id) {
  if (id) REGISTERED_TESTER_ACCOUNTS.add(String(id).trim());
}

export function revokeTesterAccountId(id) {
  if (id) REGISTERED_TESTER_ACCOUNTS.delete(String(id).trim());
}

export function isTesterAccountId(id) {
  const normalized = String(id || '').trim();
  if (DEFAULT_TESTER_ACCOUNTS.includes(normalized)) return true;
  return Boolean(id && REGISTERED_TESTER_ACCOUNTS.has(normalized));
}

// Exact-match only: the specific, individually-designated tester emails
// (e.g. the developer's own account) -- deliberately narrower than
// isTesterEmailDomain(). Used wherever a grant needs to distinguish "this
// one real person" from "anyone whose email happens to share a domain".
export function isTesterEmailExact(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return DEFAULT_TESTER_EMAILS.includes(normalized);
}

export function isTesterEmailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (DEFAULT_TESTER_EMAILS.includes(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  if (at === -1) return false;
  const domain = normalized.slice(at + 1);
  if (DEFAULT_TESTER_DOMAINS.includes(domain)) return true;
  const envDomains = typeof process !== 'undefined' && process.env
    ? String(process.env.VIDEO_OS_TESTER_EMAIL_DOMAINS || process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS || '')
    : '';
  const configuredDomains = envDomains
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return configuredDomains.includes(domain);
}

// True only for a match driven purely by domain (env-configured or the
// hardcoded default company domain), never by an exact individually-
// designated email. Distinguishes "anyone on this domain" from "this
// specific person" for callers that must not treat the two the same way
// (see containedRenderingEntitlementKeys in lib/video-os-security.js).
export function isTesterEmailDomainOnly(email) {
  return isTesterEmailDomain(email) && !isTesterEmailExact(email);
}
