import { timingSafeMatch } from './video-os-security.js';

function normalizeAccountId(value) {
  if (typeof value !== 'string') return '';
  let normalized = value.trim();
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.trim().normalize('NFKC');
}

export function parseAccountIdList(raw) {
  if (typeof raw !== 'string') return Object.freeze([]);
  return Object.freeze([...new Set(raw.split(/[,\s]+/u).map(normalizeAccountId).filter(Boolean))]);
}

export function allowlistSource(env = process.env) {
  if (parseAccountIdList(env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS).length) return 'allowlist';
  const enrollment = normalizeAccountId(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID);
  const provider = normalizeAccountId(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID);
  if (enrollment && provider && enrollment !== provider) return 'legacy_pin_mismatch';
  return enrollment || provider ? 'legacy_pin' : 'none';
}

export function identityAllowedAccountIds(env = process.env) {
  const configured = parseAccountIdList(env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS);
  if (configured.length) return configured;
  if (allowlistSource(env) !== 'legacy_pin') return Object.freeze([]);
  return Object.freeze([normalizeAccountId(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID)
    || normalizeAccountId(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID)]);
}

export function isIdentityAccountAllowed(accountId, env = process.env) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) return false;
  let match = 0;
  for (const allowed of identityAllowedAccountIds(env)) match |= Number(timingSafeMatch(normalized, allowed));
  return match !== 0;
}
