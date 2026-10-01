import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from './heygen-reconciliation-contract.js';

export const PROVIDER_TARGET_BINDING_VERSION = 'provider-target/v1';

const TARGET_KEYS = Object.freeze([
  'environment',
  'providerProjectId',
  'providerBranchId',
  'databaseName',
  'applicationProjectId',
]);

function fail(message) {
  throw Object.assign(new TypeError(message), { code: 'INVALID_PROVIDER_TARGET_BINDING' });
}

function exactIdentifier(value, label, { environment = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.trim()) {
    fail(`${label} must be an exact non-empty identifier.`);
  }
  const pattern = environment
    ? /^[a-z][a-z0-9-]{0,79}$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
  if (!pattern.test(value) || /(?:\:\/\/|@|[\\/?#=&]|%[0-9a-f]{2})/i.test(value)) {
    fail(`${label} must not contain a URL, credential, query, or path value.`);
  }
  return value;
}

export function canonicalProviderTargetIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provider target binding input must be an object.');
  const keys = Object.keys(input).sort();
  if (keys.length !== TARGET_KEYS.length || TARGET_KEYS.some((key) => !Object.hasOwn(input, key))
    || keys.some((key) => !TARGET_KEYS.includes(key))) {
    fail('Provider target binding input must contain only the required stable identity fields.');
  }
  return Object.freeze({
    version: PROVIDER_TARGET_BINDING_VERSION,
    environment: exactIdentifier(input.environment, 'environment', { environment: true }),
    providerProjectId: exactIdentifier(input.providerProjectId, 'providerProjectId'),
    providerBranchId: exactIdentifier(input.providerBranchId, 'providerBranchId'),
    databaseName: exactIdentifier(input.databaseName, 'databaseName'),
    applicationProjectId: exactIdentifier(input.applicationProjectId, 'applicationProjectId'),
  });
}

export function databaseBindingSha256(input) {
  return createHash('sha256').update(canonicalJsonBytes(canonicalProviderTargetIdentity(input))).digest('hex');
}
