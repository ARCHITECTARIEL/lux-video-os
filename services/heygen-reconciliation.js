import { HEYGEN_RECONCILIATION_RESOURCE_KINDS } from '../lib/heygen-reconciliation-contract.js';

const API_ORIGIN = 'https://api.heygen.com';
const PROVIDER_IDS = /^[A-Za-z0-9_.:-]{1,255}$/;
const SAFE_CODES = /^[a-z0-9_-]{1,80}$/;
const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const RESOURCE_KINDS = new Set(HEYGEN_RECONCILIATION_RESOURCE_KINDS);
const MOCK_DELETE_CONTEXTS = new WeakMap();

export const HEYGEN_RECONCILIATION_EVIDENCE_OUTCOMES = Object.freeze({
  resourceApi: Object.freeze(['PRESENT', 'API_ABSENT', 'DELETE_ACKNOWLEDGED']),
  publicUrl: Object.freeze(['NOT_OBSERVED', 'URL_DENIAL_OBSERVED', 'URL_STILL_ACCESSIBLE', 'URL_PROBE_AMBIGUOUS']),
});

const RESOURCE_MATRIX = Object.freeze({
  asset: Object.freeze({
    pathTemplate: '/v3/assets/{asset_id}',
    path: (id) => `/v3/assets/${encodeURIComponent(id)}`,
    absentCode: 'asset_not_found',
    responseId: (data) => data?.asset_id ?? data?.id,
    deleteId: (data) => data?.id ?? data?.asset_id,
  }),
  avatar_look: Object.freeze({
    pathTemplate: '/v3/avatars/looks/{look_id}',
    path: (id) => `/v3/avatars/looks/${encodeURIComponent(id)}`,
    absentCode: 'not_found',
    responseId: (data) => data?.id ?? data?.avatar_id,
    deleteId: (data) => data?.id ?? data?.avatar_id,
  }),
  avatar_group: Object.freeze({
    pathTemplate: '/v3/avatars/{group_id}',
    path: (id) => `/v3/avatars/${encodeURIComponent(id)}`,
    absentCode: 'avatar_not_found',
    responseId: (data) => data?.id ?? data?.avatar_group_id,
    deleteId: (data) => data?.id ?? data?.avatar_group_id,
  }),
  voice: Object.freeze({
    pathTemplate: '/v3/voices/{voice_id}',
    path: (id) => `/v3/voices/${encodeURIComponent(id)}`,
    absentCode: 'voice_not_found',
    responseId: (data) => data?.voice_id ?? data?.id,
    deleteId: (data) => data?.voice_id ?? data?.id,
  }),
  video: Object.freeze({
    pathTemplate: '/v3/videos/{video_id}',
    path: (id) => `/v3/videos/${encodeURIComponent(id)}`,
    absentCode: 'not_found',
    responseId: (data) => data?.video_id ?? data?.id,
    deleteId: (data) => data?.id ?? data?.video_id,
  }),
});

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), {
    code,
    failureCategory: code,
    statusCode: details.statusCode ?? 502,
    ...(Number.isInteger(details.providerHttpStatus) ? { providerHttpStatus: details.providerHttpStatus } : {}),
    ...(details.providerErrorCode ? { providerErrorCode: details.providerErrorCode } : {}),
    ...(details.method ? { method: details.method } : {}),
    ...(details.pathTemplate ? { pathTemplate: details.pathTemplate } : {}),
  });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyOptions(value, allowed, label) {
  if (!isRecord(value)) fail('INVALID_TRANSPORT_OPTIONS', `${label} options must be an object.`, { statusCode: 400 });
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('INVALID_TRANSPORT_OPTIONS', `${label} option ${key} is not supported.`, { statusCode: 400 });
  }
}

function resourceConfig(kind) {
  if (!RESOURCE_KINDS.has(kind)) fail('INVALID_RESOURCE_KIND', 'The HeyGen resource kind is unsupported.', { statusCode: 400 });
  return RESOURCE_MATRIX[kind];
}

function resourceId(value) {
  if (typeof value !== 'string' || !PROVIDER_IDS.test(value) || value === '.' || value === '..') fail('INVALID_PROVIDER_RESOURCE_ID', 'The HeyGen resource ID is invalid.', { statusCode: 400 });
  return value;
}

function apiKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || /[\r\n\u0000]/.test(value)) {
    fail('HEYGEN_CONFIG_MISSING', 'The HeyGen API credential is unavailable.', { statusCode: 503 });
  }
  return value;
}

function timeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > 30_000) fail('INVALID_TRANSPORT_OPTIONS', 'HeyGen timeout must be an integer between 1 and 30000 milliseconds.', { statusCode: 400 });
  return value;
}

function observedAt(value) {
  const resolved = typeof value === 'function' ? value() : value ?? new Date();
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TRANSPORT_OPTIONS', 'HeyGen observation clock was invalid.', { statusCode: 400 });
  return date.toISOString();
}

function correlationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !PROVIDER_IDS.test(value)) fail('INVALID_TRANSPORT_OPTIONS', 'HeyGen correlation ID is invalid.', { statusCode: 400 });
  return value;
}

function providerCode(payload) {
  const value = payload?.error?.code ?? payload?.data?.error?.code ?? payload?.code;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_CODES.test(normalized) ? normalized : null;
}

function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function boundedBody(response, signal) {
  if (!response || !Number.isInteger(response.status)) fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned an invalid response.', { providerHttpStatus: null });
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          try { void reader.cancel().catch(() => {}); } catch { /* best-effort cancellation only */ }
          fail('PROVIDER_RESPONSE_TOO_LARGE', 'HeyGen returned a response larger than the reconciliation limit.', { providerHttpStatus: response.status });
        }
        chunks.push(chunk);
      }
    } catch (error) {
      try { void reader.cancel().catch(() => {}); } catch { /* best-effort cancellation only */ }
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* a timed-out read can retain the lock until cancellation settles */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.text !== 'function') fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned an unreadable response.', { providerHttpStatus: response.status });
  const body = await abortable(response.text(), signal);
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) fail('PROVIDER_RESPONSE_TOO_LARGE', 'HeyGen returned a response larger than the reconciliation limit.', { providerHttpStatus: response.status });
  return body;
}

async function responsePayload(response, request, signal) {
  const raw = await boundedBody(response, signal);
  if (!raw) fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned an empty response.', { providerHttpStatus: response.status, ...request });
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned an invalid response object.', { providerHttpStatus: response.status, ...request });
    return parsed;
  } catch (error) {
    if (error?.failureCategory) throw error;
    fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned invalid JSON.', { providerHttpStatus: response.status, ...request });
  }
}

function classifyHttpFailure(response, payload, request) {
  const code = providerCode(payload);
  const details = { providerHttpStatus: response.status, providerErrorCode: code, ...request };
  if (response.status === 404) fail('AMBIGUOUS_NOT_FOUND', 'HeyGen returned a non-matching not-found response.', details);
  if (response.status === 401 || response.status === 403) fail('PROVIDER_AUTHORIZATION_FAILURE', 'HeyGen rejected the reconciliation credential or policy.', details);
  if (response.status === 429) fail('PROVIDER_RATE_LIMITED', 'HeyGen rate-limited the reconciliation request.', details);
  if (response.status >= 500) fail('PROVIDER_FAILURE', 'HeyGen could not complete the reconciliation request.', details);
  fail('PROVIDER_REJECTED', 'HeyGen rejected the reconciliation request.', details);
}

async function boundedRequest(fetchImpl, url, options, timeoutMs, request, handleResponse) {
  if (typeof fetchImpl !== 'function') fail('INVALID_TRANSPORT_OPTIONS', 'HeyGen fetch implementation is invalid.', { statusCode: 400 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await abortable(
      Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' })),
      controller.signal,
    );
    return await handleResponse(response, controller.signal);
  } catch (error) {
    if (error?.failureCategory) throw error;
    if (controller.signal.aborted) fail('PROVIDER_TIMEOUT', 'HeyGen reconciliation timed out.', request);
    fail('PROVIDER_NETWORK_FAILURE', 'HeyGen reconciliation could not reach the provider.', request);
  } finally {
    clearTimeout(timer);
  }
}

function normalizedStatus(data) {
  const value = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : '';
  return SAFE_CODES.test(value) ? value : null;
}

function normalizedMime(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return value === normalized && SAFE_MIME.test(normalized) ? normalized : null;
}

function collectMemberIds(data) {
  const collection = [data?.avatar_list, data?.avatars, data?.looks].find(Array.isArray) || [];
  const ids = [];
  const seen = new Set();
  for (const item of collection) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.avatar_id;
    if (typeof id !== 'string' || !PROVIDER_IDS.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.sort();
}

function sanitizeResource(kind, data) {
  const status = normalizedStatus(data);
  if (kind === 'asset') {
    return {
      status,
      contentType: normalizedMime(data?.mime_type),
      sizeBytes: Number.isSafeInteger(data?.size_bytes) && data.size_bytes >= 0 ? data.size_bytes : null,
    };
  }
  if (kind === 'avatar_group') return { status, observedMemberProviderResourceIds: Object.freeze(collectMemberIds(data)), membershipComplete: false };
  if (kind === 'avatar_look') {
    const parentGroupId = data?.group_id ?? data?.avatar_group_id;
    return { status, parentGroupId: typeof parentGroupId === 'string' && PROVIDER_IDS.test(parentGroupId) ? parentGroupId : null };
  }
  if (kind === 'voice') return { status, voiceNamespace: 'instant' };
  return { status };
}

function commonResult(kind, id, response, code, at, correlation) {
  return {
    kind,
    providerResourceId: id,
    providerHttpStatus: response.status,
    providerCode: code,
    observedAt: at,
    correlationId: correlation,
    publicUrlOutcome: 'NOT_OBSERVED',
  };
}

export async function getResource(kind, idInput, options = {}) {
  onlyOptions(options, ['apiKey', 'fetchImpl', 'timeoutMs', 'now', 'correlationId'], 'getResource');
  const config = resourceConfig(kind);
  const id = resourceId(idInput);
  const correlation = correlationId(options.correlationId);
  const credential = apiKey(options.apiKey);
  const request = { method: 'GET', pathTemplate: config.pathTemplate };
  return boundedRequest(
    options.fetchImpl ?? globalThis.fetch,
    `${API_ORIGIN}${config.path(id)}`,
    { method: 'GET', headers: { Accept: 'application/json', 'X-Api-Key': credential } },
    timeout(options.timeoutMs),
    request,
    async (response, signal) => {
      const payload = await responsePayload(response, request, signal);
      const code = providerCode(payload);
      const at = observedAt(options.now);
      if (response.status === 404 && code === config.absentCode) {
        return Object.freeze({ ...commonResult(kind, id, response, code, at, correlation), outcome: 'API_ABSENT', resource: null });
      }
      if (response.status < 200 || response.status >= 300) classifyHttpFailure(response, payload, request);
      const data = payload.data ?? payload;
      if (!isRecord(data)) fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned invalid resource data.', { providerHttpStatus: response.status, ...request });
      const returnedId = config.responseId(data);
      if (returnedId !== id) fail('PROVIDER_RESOURCE_MISMATCH', 'HeyGen returned a different resource than requested.', { providerHttpStatus: response.status, ...request });
      return Object.freeze({ ...commonResult(kind, id, response, code, at, correlation), outcome: 'PRESENT', resource: Object.freeze(sanitizeResource(kind, data)) });
    },
  );
}

function normalizeMockDescriptor(descriptor, index) {
  if (!isRecord(descriptor)) fail('INVALID_MOCK_TRANSPORT', `Mock response ${index} must be an object.`, { statusCode: 400 });
  const allowed = new Set(['status', 'body', 'rawBody']);
  for (const key of Object.keys(descriptor)) if (!allowed.has(key)) fail('INVALID_MOCK_TRANSPORT', `Mock response ${index}.${key} is unsupported.`, { statusCode: 400 });
  if (!Number.isInteger(descriptor.status) || descriptor.status < 100 || descriptor.status > 599) fail('INVALID_MOCK_TRANSPORT', `Mock response ${index}.status is invalid.`, { statusCode: 400 });
  if (Object.hasOwn(descriptor, 'body') === Object.hasOwn(descriptor, 'rawBody')) fail('INVALID_MOCK_TRANSPORT', `Mock response ${index} must provide exactly one body form.`, { statusCode: 400 });
  const rawBody = Object.hasOwn(descriptor, 'rawBody') ? descriptor.rawBody : JSON.stringify(descriptor.body);
  if (typeof rawBody !== 'string' || Buffer.byteLength(rawBody, 'utf8') > MAX_RESPONSE_BYTES) fail('INVALID_MOCK_TRANSPORT', `Mock response ${index} body is invalid.`, { statusCode: 400 });
  return { status: descriptor.status, rawBody };
}

export function createMockDeleteAuthorizationForTests(responseDescriptors) {
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
    fail('DELETE_EXECUTION_DISABLED', 'The in-memory HeyGen DELETE transport is available only to the Node test runner.', { statusCode: 503 });
  }
  if (!Array.isArray(responseDescriptors) || responseDescriptors.length === 0) fail('INVALID_MOCK_TRANSPORT', 'Mock delete responses must be a non-empty array.', { statusCode: 400 });
  const context = Object.freeze(Object.create(null));
  MOCK_DELETE_CONTEXTS.set(context, {
    responses: responseDescriptors.map(normalizeMockDescriptor),
    requests: [],
  });
  return context;
}

export function inspectMockDeleteRequestsForTests(context) {
  const state = MOCK_DELETE_CONTEXTS.get(context);
  if (!state) fail('INVALID_MOCK_TRANSPORT', 'The mock delete context is invalid.', { statusCode: 400 });
  return state.requests.map((request) => Object.freeze({ ...request }));
}

function mockDeleteResponse(context, request) {
  const state = MOCK_DELETE_CONTEXTS.get(context);
  if (!state) fail('DELETE_EXECUTION_DISABLED', 'HeyGen DELETE execution is disabled in this foundation.', { statusCode: 503, ...request });
  const descriptor = state.responses.shift();
  if (!descriptor) fail('MOCK_TRANSPORT_EXHAUSTED', 'The in-memory delete transport has no response remaining.', { statusCode: 500, ...request });
  state.requests.push(Object.freeze({ ...request }));
  return new Response(descriptor.rawBody, { status: descriptor.status, headers: { 'content-type': 'application/json' } });
}

export async function deleteResource(kind, idInput, options = {}) {
  onlyOptions(options, ['apiKey', 'timeoutMs', 'now', 'correlationId', 'mockAuthorizationContext'], 'deleteResource');
  const config = resourceConfig(kind);
  const id = resourceId(idInput);
  const correlation = correlationId(options.correlationId);
  const request = { method: 'DELETE', pathTemplate: config.pathTemplate, path: config.path(id) };
  if (!MOCK_DELETE_CONTEXTS.has(options.mockAuthorizationContext)) {
    fail('DELETE_EXECUTION_DISABLED', 'HeyGen DELETE execution is disabled in this foundation.', { statusCode: 503, ...request });
  }
  apiKey(options.apiKey);
  timeout(options.timeoutMs);
  const response = mockDeleteResponse(options.mockAuthorizationContext, request);
  const payload = await responsePayload(response, request);
  const code = providerCode(payload);
  if (response.status === 404) {
    fail('DELETE_ABSENCE_UNPROVEN', 'A DELETE 404 does not prove prior ownership or successful deletion.', {
      providerHttpStatus: response.status,
      providerErrorCode: code,
      ...request,
    });
  }
  if (response.status < 200 || response.status >= 300) classifyHttpFailure(response, payload, request);
  const data = payload.data ?? payload;
  if (!isRecord(data) || config.deleteId(data) !== id || (kind === 'video' && data.deleted !== true)) {
    fail('MALFORMED_PROVIDER_RESPONSE', 'HeyGen returned an invalid deletion acknowledgement.', { providerHttpStatus: response.status, ...request });
  }
  return Object.freeze({
    ...commonResult(kind, id, response, code, observedAt(options.now), correlation),
    outcome: 'DELETE_ACKNOWLEDGED',
  });
}
