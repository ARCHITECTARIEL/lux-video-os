export const HEYGEN_SPACE_MARKER_OBSERVER_VERSION = 'heygen-space-marker-observer/v1';

const API_ORIGIN = 'https://api.heygen.com';
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const PROVIDER_CODE = /^[a-z0-9_-]{1,80}$/;
const ASSET_TYPE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const TIMEOUT_MS = 8_000;
const DEFAULT_FETCH = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const ALLOW_TEST_INJECTION = String(process.env.NODE_TEST_CONTEXT || '').startsWith('child');
const OBSERVER_FAILURES = new WeakSet();

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
  OBSERVER_FAILURES.add(error);
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function options(input) {
  if (!isRecord(input)) fail('INVALID_HEYGEN_SPACE_MARKER_OPTIONS', 'HeyGen marker observer options must be an object.', { statusCode: 400 });
  const allowed = new Set(['apiKey', 'assetId', 'fetchImpl', 'now']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail('INVALID_HEYGEN_SPACE_MARKER_OPTIONS', 'HeyGen marker observer received an unsupported option.', { statusCode: 400 });
  }
  if ((input.fetchImpl !== undefined || input.now !== undefined) && !ALLOW_TEST_INJECTION) {
    fail('INVALID_HEYGEN_SPACE_MARKER_OPTIONS', 'Custom HeyGen marker transport and clock are available only to the Node test runner.', { statusCode: 400 });
  }
  return input;
}

function credential(value) {
  if (typeof value !== 'string') fail('HEYGEN_SPACE_MARKER_CONFIG_MISSING', 'The HeyGen marker credential is unavailable.', { statusCode: 503 });
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024 || /[\r\n\u0000]/.test(normalized)) {
    fail('HEYGEN_SPACE_MARKER_CONFIG_MISSING', 'The HeyGen marker credential is unavailable.', { statusCode: 503 });
  }
  return normalized;
}

function providerId(value, response = false) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value) || value === '.' || value === '..') {
    fail(response ? 'HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE' : 'INVALID_HEYGEN_SPACE_MARKER_OPTIONS',
      response ? 'HeyGen returned an invalid marker asset ID.' : 'HeyGen marker asset ID is invalid.',
      response ? {} : { statusCode: 400 });
  }
  return value;
}

function observedAt(value) {
  const resolved = typeof value === 'function' ? value() : value ?? new Date();
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) fail('INVALID_HEYGEN_SPACE_MARKER_OPTIONS', 'HeyGen marker clock is invalid.', { statusCode: 400 });
  return date.toISOString();
}

function providerErrorCode(payload) {
  const value = payload?.error?.code ?? payload?.data?.error?.code ?? payload?.code;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROVIDER_CODE.test(normalized) ? normalized : null;
}

function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function boundedBody(response, signal, request) {
  if (!response || !Number.isInteger(response.status)) fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned an invalid marker response.', request);
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
          try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
          fail('HEYGEN_SPACE_MARKER_RESPONSE_TOO_LARGE', 'HeyGen returned a marker response larger than the allowed limit.', { ...request, providerHttpStatus: response.status });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* cancellation may briefly retain the lock */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.text !== 'function') fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned an unreadable marker response.', { ...request, providerHttpStatus: response.status });
  const body = await abortable(response.text(), signal);
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    fail('HEYGEN_SPACE_MARKER_RESPONSE_TOO_LARGE', 'HeyGen returned a marker response larger than the allowed limit.', { ...request, providerHttpStatus: response.status });
  }
  return body;
}

async function responsePayload(response, signal, request) {
  const raw = await boundedBody(response, signal, request);
  if (!raw) fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned an empty marker response.', { ...request, providerHttpStatus: response.status });
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) throw new TypeError('response is not an object');
    return parsed;
  } catch (error) {
    if (OBSERVER_FAILURES.has(error)) throw error;
    fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned invalid marker JSON.', { ...request, providerHttpStatus: response.status });
  }
}

function classifyHttpFailure(response, payload, request) {
  const details = { ...request, providerHttpStatus: response.status, providerErrorCode: providerErrorCode(payload) };
  if (response.status === 401 || response.status === 403) fail('HEYGEN_SPACE_MARKER_AUTHORIZATION_FAILURE', 'HeyGen rejected the marker credential or its scope.', details);
  if (response.status === 404) fail('HEYGEN_SPACE_MARKER_NOT_FOUND', 'The retained HeyGen marker is unavailable.', details);
  if (response.status === 429) fail('HEYGEN_SPACE_MARKER_RATE_LIMITED', 'HeyGen rate-limited the marker observation.', details);
  if (response.status >= 500) fail('HEYGEN_SPACE_MARKER_PROVIDER_FAILURE', 'HeyGen could not complete the marker observation.', details);
  fail('HEYGEN_SPACE_MARKER_REJECTED', 'HeyGen rejected the marker observation.', details);
}

function requiredText(value, label, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
    fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', `HeyGen returned invalid marker ${label}.`);
  }
  return value;
}

function markerMetadata(payload, requestedId) {
  if (!isRecord(payload.data)) fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned invalid marker metadata.');
  const id = providerId(payload.data.id, true);
  if (id !== requestedId) fail('HEYGEN_SPACE_MARKER_ID_MISMATCH', 'HeyGen returned a different marker asset.');
  const uploadedAt = payload.data.uploaded_at;
  if (!Number.isSafeInteger(uploadedAt) || uploadedAt <= 0) fail('HEYGEN_SPACE_MARKER_MALFORMED_RESPONSE', 'HeyGen returned invalid marker upload time.');
  return {
    id,
    owner: requiredText(payload.data.owner, 'owner'),
    spaceId: requiredText(payload.data.space_id, 'space ID'),
    type: requiredText(payload.data.type, 'asset type', ASSET_TYPE),
    uploadedAt,
  };
}

/** Makes one read-only observation of a retained neutral HeyGen asset. */
export async function readHeygenSpaceMarkerAsset(input) {
  const resolved = options(input);
  const apiKey = credential(resolved.apiKey);
  const assetId = providerId(resolved.assetId);
  const fetchImpl = resolved.fetchImpl ?? DEFAULT_FETCH;
  if (typeof fetchImpl !== 'function') fail('INVALID_HEYGEN_SPACE_MARKER_OPTIONS', 'HeyGen marker fetch implementation is invalid.', { statusCode: 400 });
  const observationTime = observedAt(resolved.now);
  const request = { method: 'GET', pathTemplate: '/v3/assets/{asset_id}' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await abortable(Promise.resolve().then(() => fetchImpl(`${API_ORIGIN}/v3/assets/${encodeURIComponent(assetId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
      redirect: 'error',
      signal: controller.signal,
    })), controller.signal);
    const payload = await responsePayload(response, controller.signal, request);
    if (response.status !== 200) classifyHttpFailure(response, payload, request);
    return Object.freeze({ ...markerMetadata(payload, assetId), observedAt: observationTime });
  } catch (error) {
    if (OBSERVER_FAILURES.has(error)) throw error;
    if (controller.signal.aborted) fail('HEYGEN_SPACE_MARKER_TIMEOUT', 'HeyGen marker observation timed out.', request);
    fail('HEYGEN_SPACE_MARKER_NETWORK_FAILURE', 'HeyGen marker observation could not reach the provider.', request);
  } finally {
    clearTimeout(timer);
  }
}
