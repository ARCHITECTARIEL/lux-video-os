const DEFAULT_TESTER_DOMAINS = ['luxmarketingcompany.com'];
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
  return Boolean(id && REGISTERED_TESTER_ACCOUNTS.has(String(id).trim()));
}

export function isTesterEmailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
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
