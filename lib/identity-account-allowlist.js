import { timingSafeMatch } from './video-os-security.js';

const ACCOUNT_ID = /^[a-z0-9_-]{1,80}$/;

function configuredId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsedList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ids: Object.freeze([]), invalidCount: 0 };
  const value = raw.trim();
  // A quoted whole list is one malformed setting, not two usable IDs.
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return { ids: Object.freeze([]), invalidCount: 1 };
  }
  const ids = new Set();
  let invalidCount = 0;
  for (const entry of value.split(/[,\s]+/u).filter(Boolean)) {
    if (ACCOUNT_ID.test(entry)) ids.add(entry);
    else invalidCount += 1;
  }
  return { ids: Object.freeze([...ids]), invalidCount };
}

export function parseAccountIdList(raw) {
  return parsedList(raw).ids;
}

export function allowlistInvalidEntryCount(env = process.env) {
  const list = parsedList(env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS);
  if (typeof env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS === 'string'
    && env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS.trim()) return list.invalidCount;
  return ['VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID', 'VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID']
    .filter((key) => configuredId(env[key]) && !ACCOUNT_ID.test(configuredId(env[key]))).length;
}

export function allowlistSource(env = process.env) {
  if (typeof env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS === 'string'
    && env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS.trim()) {
    const list = parsedList(env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS);
    if (list.ids.length) return 'allowlist';
    if (list.invalidCount) return 'allowlist_invalid';
  }
  const enrollment = configuredId(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID);
  const provider = configuredId(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID);
  if ((enrollment && !ACCOUNT_ID.test(enrollment)) || (provider && !ACCOUNT_ID.test(provider))) return 'legacy_pin_invalid';
  if (enrollment && provider && enrollment !== provider) return 'legacy_pin_mismatch';
  return enrollment || provider ? 'legacy_pin' : 'none';
}

export function identityAllowedAccountIds(env = process.env) {
  const source = allowlistSource(env);
  if (source === 'allowlist') return parseAccountIdList(env.VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS);
  if (source !== 'legacy_pin') return Object.freeze([]);
  return Object.freeze([configuredId(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID)
    || configuredId(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID)]);
}

export function isIdentityAccountAllowed(accountId, env = process.env) {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return false;
  let match = 0;
  for (const allowed of identityAllowedAccountIds(env)) match |= Number(timingSafeMatch(accountId, allowed));
  return match !== 0;
}
