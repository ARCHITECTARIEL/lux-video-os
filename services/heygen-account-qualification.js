import { createHash } from 'node:crypto';

export const HEYGEN_ACCOUNT_QUALIFICATION_VERSION = 'heygen-account-qualification/v1';

const API_ORIGIN = 'https://api.heygen.com';
const API_KEY_SELF_PATH = '/v3/api_keys/self';
const USER_PROFILE_PATH = '/v3/users/me';
const DEFAULT_FETCH = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const ALLOW_TEST_TRANSPORT = String(process.env.NODE_TEST_CONTEXT || '').startsWith('child');
const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const EXPIRY_REMAINING_TOLERANCE_SECONDS = 60;
const CREDENTIAL_KEY_FINGERPRINT_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8');
const CREDENTIAL_SCOPE_FINGERPRINT_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_SCOPE\0V1\0', 'utf8');
const KEY_ID_DIGEST_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_KEY_ID\0V1\0', 'utf8');
const SCOPE_MODES = new Set(['full', 'read_only', 'custom']);
const BILLING_TYPES = new Set(['wallet', 'subscription', 'usage_based']);
const SAFE_PROVIDER_CODE = /^[a-z0-9_-]{1,80}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const SAFE_STATUS = /^[a-z][a-z0-9_-]{0,79}$/;
const SAFE_SCOPE = /^(?:\*:\*|\*:read|[a-z][a-z0-9_-]{0,63}:(?:read|write))$/;
const QUALIFIER_SCOPES = new Set([
  '*:*', '*:read', 'account:read',
  'assets:read', 'assets:write',
  'avatars:read', 'avatars:write',
  'voices:read', 'voices:write',
  'videos:read', 'videos:write',
]);
const QUALIFICATION_FAILURES = new WeakSet();
const VERIFIED_QUALIFICATIONS = new WeakSet();
const REQUIRED_PERMISSIONS = Object.freeze([
  Object.freeze({ resource: 'account', action: 'read' }),
  Object.freeze({ resource: 'assets', action: 'read' }),
  Object.freeze({ resource: 'assets', action: 'write' }),
  Object.freeze({ resource: 'avatars', action: 'read' }),
  Object.freeze({ resource: 'avatars', action: 'write' }),
  Object.freeze({ resource: 'voices', action: 'read' }),
  Object.freeze({ resource: 'voices', action: 'write' }),
  Object.freeze({ resource: 'videos', action: 'read' }),
  Object.freeze({ resource: 'videos', action: 'write' }),
]);

function fail(code, message, details = {}) {
  const error = Object.assign(new Error(message), {
    code,
    failureCategory: code,
    statusCode: details.statusCode ?? 502,
    ...(Number.isInteger(details.providerHttpStatus) ? { providerHttpStatus: details.providerHttpStatus } : {}),
    ...(details.providerErrorCode ? { providerErrorCode: details.providerErrorCode } : {}),
    ...(details.method ? { method: details.method } : {}),
    ...(details.pathTemplate ? { pathTemplate: details.pathTemplate } : {}),
  });
  QUALIFICATION_FAILURES.add(error);
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function assertQualifiedHeygenCredential(qualification) {
  if (!qualification || typeof qualification !== 'object' || !VERIFIED_QUALIFICATIONS.has(qualification)) {
    fail('UNVERIFIED_HEYGEN_QUALIFICATION', 'A live qualification produced by this process is required.', { statusCode: 403 });
  }
  return qualification;
}

function options(input) {
  if (!isRecord(input)) fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'HeyGen qualification options must be an object.', { statusCode: 400 });
  const allowed = new Set(['apiKey', 'fetchImpl', 'now', 'timeoutMs', 'beforeRequest']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'HeyGen qualification received an unsupported option.', { statusCode: 400 });
  }
  if (input.fetchImpl !== undefined && !ALLOW_TEST_TRANSPORT) {
    fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'Custom HeyGen qualification transport is available only to the Node test runner.', { statusCode: 400 });
  }
  if (input.beforeRequest !== undefined && typeof input.beforeRequest !== 'function') {
    fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'The HeyGen qualification request guard must be a function.', { statusCode: 400 });
  }
  return input;
}

function credential(value) {
  if (typeof value !== 'string') fail('HEYGEN_QUALIFICATION_CONFIG_MISSING', 'The HeyGen qualification credential is unavailable.', { statusCode: 503 });
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024 || /[\r\n\u0000]/.test(normalized)) {
    fail('HEYGEN_QUALIFICATION_CONFIG_MISSING', 'The HeyGen qualification credential is unavailable.', { statusCode: 503 });
  }
  return normalized;
}

function requestTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'HeyGen qualification timeout must be an integer between 1 and 30000 milliseconds.', { statusCode: 400 });
  }
  return value;
}

function observationClock(value) {
  const resolved = typeof value === 'function' ? value() : value ?? new Date();
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'HeyGen qualification clock is invalid.', { statusCode: 400 });
  return date;
}

function domainDigest(domain, value) {
  return createHash('sha256').update(domain).update(value, 'utf8').digest('hex');
}

function credentialScopeDigest(apiKey, metadata) {
  const scopeBinding = JSON.stringify({
    apiVersion: 'v3',
    scopeMode: metadata.scopeMode,
    scopes: metadata.scopes,
    expiresAt: metadata.expiresAt,
    expirationFormat: metadata.expirationFormat,
  });
  return createHash('sha256')
    .update(CREDENTIAL_SCOPE_FINGERPRINT_DOMAIN)
    .update(apiKey, 'utf8')
    .update(Buffer.from([0]))
    .update(scopeBinding, 'utf8')
    .digest('hex');
}

function providerCode(payload) {
  const value = payload?.error?.code ?? payload?.data?.error?.code ?? payload?.code;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_PROVIDER_CODE.test(normalized) ? normalized : null;
}

function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function boundedBody(response, signal, request) {
  if (!response || !Number.isInteger(response.status)) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned an invalid qualification response.', request);
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          try { void reader.cancel().catch(() => {}); } catch { /* best-effort only */ }
          fail('HEYGEN_QUALIFICATION_RESPONSE_TOO_LARGE', 'HeyGen returned a qualification response larger than the allowed limit.', {
            ...request,
            providerHttpStatus: response.status,
          });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      try { void reader.cancel().catch(() => {}); } catch { /* best-effort only */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* a cancelled stream may retain its lock briefly */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.text !== 'function') {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned an unreadable qualification response.', {
      ...request,
      providerHttpStatus: response.status,
    });
  }
  const body = await abortable(response.text(), signal);
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('HEYGEN_QUALIFICATION_RESPONSE_TOO_LARGE', 'HeyGen returned a qualification response larger than the allowed limit.', {
      ...request,
      providerHttpStatus: response.status,
    });
  }
  return body;
}

async function responsePayload(response, signal, request) {
  const raw = await boundedBody(response, signal, request);
  if (!raw) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned an empty qualification response.', {
      ...request,
      providerHttpStatus: response.status,
    });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new TypeError('response is not an object');
    return parsed;
  } catch (error) {
    if (QUALIFICATION_FAILURES.has(error)) throw error;
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid qualification JSON.', {
      ...request,
      providerHttpStatus: response.status,
    });
  }
}

function classifyHttpFailure(response, payload, request) {
  const code = providerCode(payload);
  const details = { ...request, providerHttpStatus: response.status, providerErrorCode: code };
  if (response.status === 401 || response.status === 403) {
    fail('HEYGEN_QUALIFICATION_AUTHORIZATION_FAILURE', 'HeyGen rejected the qualification credential or its scope.', details);
  }
  if (response.status === 429) fail('HEYGEN_QUALIFICATION_RATE_LIMITED', 'HeyGen rate-limited the qualification request.', details);
  if (response.status >= 500) fail('HEYGEN_QUALIFICATION_PROVIDER_FAILURE', 'HeyGen could not complete the qualification request.', details);
  fail('HEYGEN_QUALIFICATION_REJECTED', 'HeyGen rejected the qualification request.', details);
}

async function providerGet(fetchImpl, path, apiKey, timeoutMs, beforeRequest) {
  if (typeof fetchImpl !== 'function') {
    fail('INVALID_HEYGEN_QUALIFICATION_OPTIONS', 'HeyGen qualification fetch implementation is invalid.', { statusCode: 400 });
  }
  const request = { method: 'GET', pathTemplate: path };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Stop-only operator hook: receives no key, transport or response authority.
    // The deadline includes this guard; a slow fsync cannot start a late request.
    if (beforeRequest) await abortable(Promise.resolve().then(() => beforeRequest(Object.freeze({ ...request }))), controller.signal);
    controller.signal.throwIfAborted();
    const response = await abortable(
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return fetchImpl(`${API_ORIGIN}${path}`, {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
          redirect: 'error',
          signal: controller.signal,
        });
      }),
      controller.signal,
    );
    const payload = await responsePayload(response, controller.signal, request);
    if (response.status < 200 || response.status >= 300) classifyHttpFailure(response, payload, request);
    return payload;
  } catch (error) {
    if (QUALIFICATION_FAILURES.has(error)) throw error;
    if (controller.signal.aborted) fail('HEYGEN_QUALIFICATION_TIMEOUT', 'HeyGen qualification timed out.', request);
    fail('HEYGEN_QUALIFICATION_NETWORK_FAILURE', 'HeyGen qualification could not reach the provider.', request);
  } finally {
    clearTimeout(timer);
  }
}

function requiredText(value, label, { max = 255, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', `HeyGen returned invalid ${label}.`);
  }
  return value;
}

function optionalText(value, label, { max = 320 } = {}) {
  if (value === null) return null;
  return requiredText(value, label, { max });
}

function normalizeTimestamp(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', `HeyGen returned invalid ${label}.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', `HeyGen returned invalid ${label}.`);
  return date.toISOString();
}

function normalizeExpiry(value) {
  if (typeof value === 'string') {
    return { expiresAt: normalizeTimestamp(value, 'credential expiry time'), expiresAtObserved: value, expirationFormat: 'iso8601', comparable: true };
  }
  if (value === null) return { expiresAt: null, expiresAtObserved: null, expirationFormat: 'undocumented_null', comparable: false };
  if (Number.isSafeInteger(value)) return { expiresAt: null, expiresAtObserved: value, expirationFormat: 'undocumented_numeric', comparable: false };
  fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid credential expiry metadata.');
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid credential scopes.');
  const scopes = value.map((scope) => requiredText(scope, 'credential scope', { max: 128, pattern: SAFE_SCOPE }));
  if (new Set(scopes).size !== scopes.length) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned duplicate credential scopes.');
  return scopes.sort();
}

function normalizeKeyMetadata(payload) {
  if (!isRecord(payload.data)) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid credential metadata.');
  const data = payload.data;
  const keyId = requiredText(data.key_id, 'credential key ID', { pattern: SAFE_KEY_ID });
  const status = requiredText(data.status, 'credential status', { max: 80, pattern: SAFE_STATUS });
  if (!SCOPE_MODES.has(data.scope_mode)) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned an unsupported credential scope mode.');
  const scopes = normalizeScopes(data.scopes);
  const createdAt = normalizeTimestamp(data.created_at, 'credential creation time');
  const updatedAt = normalizeTimestamp(data.updated_at, 'credential update time');
  const expiry = normalizeExpiry(data.expires_at);
  const nullExpiryPair = data.expires_at === null && data.expires_in_seconds === null;
  if (!Number.isSafeInteger(data.expires_in_seconds) && !nullExpiryPair) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid credential expiry metadata.');
  }
  return { keyId, status, scopeMode: data.scope_mode, scopes, createdAt, updatedAt, ...expiry, expiresInSeconds: data.expires_in_seconds };
}

function normalizeProfile(payload) {
  if (!isRecord(payload.data)) fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned invalid account profile metadata.');
  const data = payload.data;
  const billingType = data.billing_type;
  if (billingType !== null && !BILLING_TYPES.has(billingType)) {
    fail('HEYGEN_QUALIFICATION_MALFORMED_RESPONSE', 'HeyGen returned an unsupported account billing type.');
  }
  return {
    username: requiredText(data.username, 'account username'),
    email: optionalText(data.email, 'account email'),
    billingType,
  };
}

function grants(scopes, resource, action) {
  if (scopes.includes('*:*')) return true;
  if (action === 'read' && scopes.includes('*:read')) return true;
  if (scopes.includes(`${resource}:${action}`)) return true;
  return action === 'read' && resource !== 'account' && scopes.includes(`${resource}:write`);
}

function permissionReport(scopes) {
  return {
    account: { read: grants(scopes, 'account', 'read') },
    assets: { read: grants(scopes, 'assets', 'read'), write: grants(scopes, 'assets', 'write') },
    avatars: { read: grants(scopes, 'avatars', 'read'), write: grants(scopes, 'avatars', 'write') },
    voices: { read: grants(scopes, 'voices', 'read'), write: grants(scopes, 'voices', 'write') },
    videos: { read: grants(scopes, 'videos', 'read'), write: grants(scopes, 'videos', 'write') },
  };
}

function permission(report, resource, action) {
  return report[resource][action];
}

function addHold(holds, code, details = {}) {
  holds.push({ code, ...details });
}

function addScopeConsistencyHolds(metadata, holds) {
  const { scopeMode, scopes } = metadata;
  if (scopeMode === 'full' && !scopes.includes('*:*')) {
    addHold(holds, 'SCOPE_MODE_SCOPE_MISMATCH');
  }
  if (scopeMode === 'read_only' && (!scopes.includes('*:read') || scopes.some((scope) => scope === '*:*' || scope.endsWith(':write')))) {
    addHold(holds, 'SCOPE_MODE_SCOPE_MISMATCH');
  }
  if (scopeMode === 'custom' && scopes.some((scope) => scope.startsWith('*:'))) {
    addHold(holds, 'SCOPE_MODE_SCOPE_MISMATCH');
  }
  if (scopes.some((scope) => !QUALIFIER_SCOPES.has(scope))) addHold(holds, 'UNRECOGNIZED_SCOPE_PRESENT');
}

function addCredentialHolds(metadata, now, report, holds) {
  if (metadata.status !== 'active') addHold(holds, 'CREDENTIAL_NOT_ACTIVE');
  const expiredByTimestamp = metadata.comparable ? new Date(metadata.expiresAt).getTime() <= now.getTime() : null;
  const expiredByRemaining = metadata.expiresInSeconds !== null && metadata.expiresInSeconds <= 0;
  if (expiredByTimestamp === true || expiredByRemaining) addHold(holds, 'CREDENTIAL_EXPIRED');
  if (!metadata.comparable) addHold(holds, 'CREDENTIAL_EXPIRY_FORMAT_UNVERIFIED');
  if (metadata.comparable) {
    const timestampRemainingSeconds = Math.floor((new Date(metadata.expiresAt).getTime() - now.getTime()) / 1_000);
    if (Math.abs(timestampRemainingSeconds - metadata.expiresInSeconds) > EXPIRY_REMAINING_TOLERANCE_SECONDS) {
      addHold(holds, 'CREDENTIAL_EXPIRY_METADATA_CONFLICT');
    }
  }
  addScopeConsistencyHolds(metadata, holds);
  for (const required of REQUIRED_PERMISSIONS) {
    if (!permission(report, required.resource, required.action)) {
      addHold(holds, 'MISSING_REQUIRED_PERMISSION', { permission: `${required.resource}:${required.action}` });
    }
  }
}

/**
 * Read-only qualification of one HeyGen credential. This probe can qualify key
 * state and permissions, but the documented endpoints expose no stable account,
 * workspace, team, or organization identifier. It therefore never promotes an
 * account binding.
 */
export async function qualifyHeygenCredential(input) {
  const resolved = options(input);
  const apiKey = credential(resolved.apiKey);
  const fetchImpl = resolved.fetchImpl ?? DEFAULT_FETCH;
  const timeoutMs = requestTimeout(resolved.timeoutMs);
  const now = observationClock(resolved.now);
  const metadataPayload = await providerGet(fetchImpl, API_KEY_SELF_PATH, apiKey, timeoutMs, resolved.beforeRequest);
  const metadata = normalizeKeyMetadata(metadataPayload);
  const permissions = permissionReport(metadata.scopes);
  const holds = [];
  addCredentialHolds(metadata, now, permissions, holds);

  let profile = null;
  let profileProbeOutcome = 'SKIPPED_MISSING_ACCOUNT_READ';
  if (permissions.account.read) {
    profile = normalizeProfile(await providerGet(fetchImpl, USER_PROFILE_PATH, apiKey, timeoutMs, resolved.beforeRequest));
    profileProbeOutcome = 'OBSERVED';
  } else {
    addHold(holds, 'PROFILE_PROBE_SKIPPED_MISSING_ACCOUNT_READ');
  }

  // Neither documented endpoint returns a stable provider account/workspace ID.
  // Credential IDs, usernames, and email addresses are not safe substitutes.
  addHold(holds, 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE');

  const result = {
    version: HEYGEN_ACCOUNT_QUALIFICATION_VERSION,
    observedAt: now.toISOString(),
    credentialKeyFingerprint: domainDigest(CREDENTIAL_KEY_FINGERPRINT_DOMAIN, apiKey),
    credentialScopeFingerprint: credentialScopeDigest(apiKey, metadata),
    accountScopeVerified: false,
    bindingEligible: false,
    publicSummary: {
      credentialStatus: metadata.status,
      scopeMode: metadata.scopeMode,
      expiresAt: metadata.expiresAt,
      expirationFormat: metadata.expirationFormat,
      expiresInSeconds: metadata.expiresInSeconds,
      permissions,
      profileProbeOutcome,
      accountScopeVerified: false,
      bindingEligible: false,
      holds,
    },
    privateEvidence: {
      keyId: metadata.keyId,
      keyIdDigest: domainDigest(KEY_ID_DIGEST_DOMAIN, metadata.keyId),
      status: metadata.status,
      scopeMode: metadata.scopeMode,
      scopes: metadata.scopes,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      expiresAt: metadata.expiresAt,
      expiresAtObserved: metadata.expiresAtObserved,
      expirationFormat: metadata.expirationFormat,
      expiresInSeconds: metadata.expiresInSeconds,
      profile,
    },
  };
  const qualified = deepFreeze(result);
  VERIFIED_QUALIFICATIONS.add(qualified);
  return qualified;
}
