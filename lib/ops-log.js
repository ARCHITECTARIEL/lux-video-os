import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_MESSAGE = 180;
const MAX_INPUT = 512;
const MAX_DETAILS = 2048;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_EVENT_FIELD = /^[a-z0-9_.:-]{1,96}$/i;
const SENSITIVE_KEY = /(?:apikey|accesskey|privatekey|secret|token|password|pwd|passwd|passphrase|credentials?|auth|authorization|jwt|cookie|session|email|mail|phone|ssn|address|name|signature|signed|url|media|face|voice|photo|video|payload|blob|base64|data|script|prompt|input|output)/i;
const EXTRA_SENSITIVE_KEY = /(?:^|[_\W])(?:dob|birthdate|ip|card|pan|cvv|iban|otp|pin|nonce|salt)(?=$|[_\W])/i;
function sensitiveKey(key) {
  return SENSITIVE_KEY.test(key.replace(/[^a-z0-9]/gi, '')) ||
    EXTRA_SENSITIVE_KEY.test(key.replace(/([a-z\d])([A-Z])/g, '$1_$2'));
}
// Every expression operates on at most MAX_INPUT characters. No nested
// repetitions or repeated groups with overlapping alternatives.
const SENSITIVE_VALUES = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi,
  /\b(?:basic|bearer)\s+[^\s,;]+/gi,
  /(?:^|[^A-Za-z0-9])(?:api[_-]?key|cookie|password|passwd|pwd|signature|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /\bdata:[^\s]+/gi,
  /\b(?:sk_live_|sk_test_|rk_|vercel_blob_rw_)[A-Za-z0-9_-]+/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /(?:^|[^A-Za-z0-9])(?:key|token|secret)\s*[:=]\s*[^\s&#,;]+/gi,
  /(?:^|[^A-Za-z0-9])(?:password|passwd|pwd|secret|token|key|hmac secret)\s+(?:is|was)\s+[^\s,;]+/gi,
  /\b[A-Z0-9._%+-]+%40[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:[a-z0-9.-]+\.[a-z]{2,}|localhost)(?::\d{1,5})?\/[^\s]*\b(?:sig|token|key)=[^\s&#,;]*/gi,
  /\b[^\s:@/]+:[^\s@/]+@[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/gi,
  /\b[^\s:@/]+:[^\s@/]+@(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\])(?::\d{1,5})?(?:\/[^\s]*)?/gi,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g,
  /(?:^|[^A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])\(?\+?\d[\d(). -]{8,}\d\)?(?![A-Za-z0-9_])/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b[A-Za-z0-9+/_-]{20,}={0,2}\b/g,
];
const IBAN_PATTERN = SENSITIVE_VALUES.at(-5);
const CARD_PATTERN = SENSITIVE_VALUES.at(-4);

function validIban(value) {
  const compact = value.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = character >= 'A' && character <= 'Z' ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function validCard(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let digit = Number(digits[i]);
    if (double) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}
const DETAIL_KEYS = new Map([
  ['admin.canary_scope.checked', new Set([
    'ok', 'code', 'deploymentMatched', 'gitCommitMatched', 'projectMatched',
    'stableAliasHostMatched', 'uniqueDeploymentHostMatched', 'canaryPinPresent',
    'canaryPinMatchesExpected', 'providerCreationFlagExactlyTrue',
    'providerCreationEnabledForExpectedPin', 'providerCreationEnabledWithoutAccount',
    'providerCreationEnabledForSyntheticAccount', 'identityProviderEnabled',
    'identityAssetPrivacyConfirmed', 'identityProviderPinMatchesCanaryPin',
    'hostedSubjectConsentEnabled', 'billingDisabled', 'durableRenderDisabled',
    'standardRenderDisabled', 'scriptedPhotoDisabled', 'phoneEnrollmentDisabled',
    'phoneExtractionDisabled', 'maintenanceAdmissionActive', 'canaryScopeAsExpected',
  ])],
  ['admin.db_binding.checked', new Set([
    'ok', 'code', 'deploymentMatched', 'gitCommitMatched', 'projectMatched',
    'stableAliasHostMatched', 'uniqueDeploymentHostMatched', 'maintenanceAdmissionActive',
    'targetManifestMatched', 'canonicalUrlMatchesTarget', 'connectedDatabaseMatchesTarget',
    'providerCreationDisabled', 'providerCreationCanaryScoped', 'sourceByteAttested', 'readOnly',
  ])],
  ['identity.provider_creation.failed', new Set(['component'])],
  ['identity.provider_creation.contained_failure', new Set(['component'])],
  ['admin.request.completed', new Set([
    'operation', 'result', 'actorType', 'ipPrefix', 'userAgent', 'deploymentId', 'gitSha',
  ])],
  ['admin.credit.granted', new Set(['adminActor', 'amount', 'duplicate'])],
  ['admin.asset.quarantined', new Set(['adminActor'])],
  ['admin.tester.registered', new Set(['adminActor', 'testerDomain'])],
]);
const RECONCILER_DETAILS = new Set(['mode', 'ourState', 'marker', 'matchedBy', 'matchCount', 'heygenVideoId', 'heygenStatus',
  'proposedAction', 'classification', 'reason', 'pages', 'complete', 'truncated', 'ageSeconds', 'firstAgeSeconds', 'retryCount', 'graceSeconds']);
const RECONCILER_COUNTS = new Set(['jobsScanned', 'unknownCount', 'listCalls', 'pagesTotal', 'incompleteCount', 'durationMs']);
const RECONCILER_ACTIONS = ['bind_found', 'release_same_key_retry', 'hold', 'attention'];
const DIAGNOSTIC_CODES = new Set(['diagnostic_unavailable', 'operator_required', 'expected_identity_required',
  'nonce_invalid', 'nonce_replayed', 'skew', 'rate_limited']);
const WARN_WINDOW_MS = 60_000;
const WARN_LIMIT = 5;
const WARN_KEYS_LIMIT = 256;
const warnWindows = new Map();
const GLOBAL_LIMIT = 60;
let globalWindow = { start: 0, count: 0 };

function scrub(value) {
  let result = value.slice(0, MAX_INPUT).replace(/[\uE000\uE001]/g, '');
  const preserved = [];
  const preserve = match => {
    const marker = `\uE000${preserved.length}\uE001`;
    preserved.push(match);
    return marker;
  };
  result = result.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z| \d{2})?\b/gi, preserve);
  result = result.replace(/(^|[^A-Za-z0-9_])((?:sha256|sha-256|digest|checksum|schemaSha256|migrationSetSha256|sourceSha256|outputSha256|manifestSha256|contentSha256)\s*(?:=|:|\s)\s*)([0-9a-f]{64})(?![A-Za-z0-9])/gm,
    (_, boundary, label, hash) => `${boundary}${label}${preserve(hash)}`);
  for (const pattern of SENSITIVE_VALUES) result = result.replace(pattern, (match) => {
    if (pattern === IBAN_PATTERN && !validIban(match)) return match;
    if (pattern === CARD_PATTERN && !validCard(match)) return match;
    if (pattern === SENSITIVE_VALUES.at(-1) && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(match) && !/\d{5}/.test(match)) return match;
    if (pattern === SENSITIVE_VALUES.at(-3)) {
      if (/^\d{4}-\d{2}-\d{2}(?: \d{2})?$/.test(match) || /^\d{4}-\d{2}-\d{2}T/.test(match)) return match;
      if (!match.includes('+') && /^\d{13,}$/.test(match)) return match;
      const digits = match.replace(/\D/g, '').length;
      if (digits < 10 || digits > 15) return match;
    }
    return '[redacted]';
  });
  result = result.replace(/[0-9a-fA-F:]{2,39}/g, candidate =>
    candidate.includes(':') && isIP(candidate) === 6 ? '[redacted]' : candidate);
  result = result.replace(/\uE000(\d+)\uE001/g, (_, index) => preserved[Number(index)]);
  return result.slice(0, 256);
}

export function redactOpsValue(value, depth = 0) {
  if (depth > 3) return '[redacted]';
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => redactOpsValue(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, item]) => {
      const boundedKey = key.slice(0, 48);
      return [scrub(boundedKey), key.length > 48 || sensitiveKey(boundedKey) ? '[redacted]' : redactOpsValue(item, depth + 1)];
    }));
  }
  return '[redacted]';
}

function safeText(value, max = MAX_MESSAGE) {
  return typeof value === 'string' ? scrub(value).slice(0, max) : undefined;
}

function safeEventField(value, marker) {
  return typeof value === 'string' && SAFE_EVENT_FIELD.test(value) ? value : marker;
}

function safeId(value) {
  return typeof value === 'string' && value.length <= 128 && SAFE_ID.test(value) ? value : undefined;
}

const ADMIN_REQUEST_RESULTS = new Set(['succeeded', 'rejected', 'failed']);
const ADMIN_ACTOR_TYPES = new Set(['admin_token', 'cron_secret', 'session', 'none']);
const IP_PREFIX = /^(?:unknown|(?:\d{1,3}\.){3}0\/24|[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){2}::\/48)$/i;
const GIT_SHA = /^(?:unknown|[a-f0-9]{7,64})$/i;

function safeAdminRequestDetails(value) {
  const operation = safeEventField(value.operation, 'unknown');
  const result = ADMIN_REQUEST_RESULTS.has(value.result) ? value.result : 'failed';
  const actorType = ADMIN_ACTOR_TYPES.has(value.actorType) ? value.actorType : 'none';
  const requestIpPrefix = typeof value.ipPrefix === 'string' && IP_PREFIX.test(value.ipPrefix) ? value.ipPrefix.toLowerCase() : 'unknown';
  const deploymentId = safeId(value.deploymentId) || 'unknown';
  const gitSha = typeof value.gitSha === 'string' && GIT_SHA.test(value.gitSha) ? value.gitSha.toLowerCase() : 'unknown';
  return {
    operation,
    result,
    actorType,
    ipPrefix: requestIpPrefix,
    userAgent: safeText(value.userAgent, 120) || 'unknown',
    deploymentId,
    gitSha,
  };
}

function safeDetails(event, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (event === 'heygen.reconciler.shadow_decision' || event === 'heygen.reconciler.act_decision') {
    const details = {};
    for (const key of RECONCILER_DETAILS) {
      const item = value[key];
      if (key === 'marker') details[key] = typeof item === 'string' && /^vos-[a-f0-9]{24}$/.test(item) ? item : null;
      else if (key === 'heygenVideoId') details[key] = typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,255}$/.test(item) && !/^vos-[a-f0-9]{32}$/.test(item) ? item : null;
      else if (key === 'heygenStatus') details[key] = ['pending', 'processing', 'completed', 'failed', 'ready', 'draft'].includes(item) ? item : null;
      else if (key === 'complete' || key === 'truncated') details[key] = item === true;
      else if (['matchCount', 'pages', 'retryCount', 'graceSeconds'].includes(key)) details[key] = Number.isSafeInteger(item) && item >= 0 ? item : 0;
      else if (['ageSeconds', 'firstAgeSeconds'].includes(key)) details[key] = Number.isSafeInteger(item) ? item : null;
      else if (key === 'mode') details[key] = ['shadow', 'act'].includes(item) ? item : 'off';
      else if (key === 'ourState') details[key] = item === 'provider_submit_unknown' ? item : 'unknown';
      else if (key === 'matchedBy') details[key] = item === 'title_marker' ? item : 'none';
      else if (key === 'proposedAction') details[key] = RECONCILER_ACTIONS.includes(item) ? item : 'attention';
      else if (key === 'classification') details[key] = ['FOUND', 'ABSENT', 'UNKNOWN'].includes(item) ? item : 'UNKNOWN';
      else if (key === 'reason') details[key] = typeof item === 'string' && SAFE_EVENT_FIELD.test(item) ? item : 'unknown';
    }
    return details;
  }
  if (event === 'heygen.reconciler.shadow_run') {
    const details = {};
    for (const key of RECONCILER_COUNTS) details[key] = Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : 0;
    details.byProposedAction = Object.fromEntries(RECONCILER_ACTIONS.map(action => [action,
      Number.isSafeInteger(value.byProposedAction?.[action]) && value.byProposedAction[action] >= 0 ? value.byProposedAction[action] : 0]));
    return details;
  }
  const allowed = DETAIL_KEYS.get(event);
  if (!allowed) return {};
  if (event === 'admin.request.completed') return safeAdminRequestDetails(value);
  const details = {};
  const diagnostic = event === 'admin.canary_scope.checked' || event === 'admin.db_binding.checked';
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    if (diagnostic) {
      if (key === 'code' ? !DIAGNOSTIC_CODES.has(value[key]) : typeof value[key] !== 'boolean') continue;
    } else if (sensitiveKey(key)) continue;
    details[key] = diagnostic && key === 'code' ? value[key] : redactOpsValue(value[key]);
  }
  return JSON.stringify(details).length <= MAX_DETAILS ? details : { truncated: true };
}

export function prepareOpsEvent(input = {}) {
  const level = ['info', 'warn', 'error'].includes(input.level) ? input.level : 'info';
  const accountId = safeId(input.accountId);
  const status = Number.isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : undefined;
  const entry = {
    ts: new Date().toISOString(), level,
    event: safeEventField(input.event, 'invalid_event'),
    accountId: accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 16) : undefined,
    identityId: safeId(input.identityId), enrollmentId: safeId(input.enrollmentId), jobId: safeId(input.jobId),
    status, code: input.code === undefined ? undefined : safeEventField(input.code, 'invalid_code'), message: safeText(input.message),
    correlationId: safeId(input.correlationId),
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : undefined,
  };
  const details = safeDetails(entry.event, input.details);
  if (Object.keys(details).length) entry.details = details;
  const row = {
    level, event: entry.event,
    // Exact account filters and joins require the raw ID in the protected DB;
    // the console projection uses a hash.
    accountId: accountId || null,
    entityType: safeText(input.entityType, 32) || (entry.jobId ? 'job' : entry.identityId ? 'identity' : entry.enrollmentId ? 'enrollment' : null),
    entityId: safeId(input.entityId) || entry.jobId || entry.identityId || entry.enrollmentId || null,
    correlationId: entry.correlationId || null, code: entry.code || null,
    httpStatus: status || null, message: entry.message || '', details,
  };
  return { entry, row };
}

export async function writeOpsEvent(row, writer, { audit = false } = {}) {
  try {
    if (writer) await writer(row);
    else {
      const [{ database }, { opsEvents }] = await Promise.all([import('../db/client.js'), import('../db/schema.js')]);
      await database().insert(opsEvents).values(row);
    }
    return true;
  } catch {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: audit ? 'ops.audit.persist.failed' : 'ops.persist.failed', code: audit ? 'OPS_AUDIT_PERSIST_FAILED' : 'OPS_PERSIST_FAILED', ...(audit ? { auditEvent: row.event } : {}) }));
    return false;
  }
}

export function shouldPersistOpsEvent(input, entry, now = Date.now()) {
  if (input.persist === true) return true;
  if (input.persist === false || entry.level === 'info') return false;
  if (!safeId(input.accountId) && [401, 403, 405].includes(entry.status)) return false;
  if (now - globalWindow.start >= WARN_WINDOW_MS || now < globalWindow.start) globalWindow = { start: now, count: 0 };
  if (globalWindow.count >= GLOBAL_LIMIT) return false;
  const key = `${entry.event}|${entry.code || ''}|${entry.accountId || ''}`;
  const window = warnWindows.get(key);
  if (window && now - window.start < WARN_WINDOW_MS) {
    if (window.count >= WARN_LIMIT) return false;
    window.count++;
    globalWindow.count++;
    return true;
  }
  if (warnWindows.size >= WARN_KEYS_LIMIT) warnWindows.delete(warnWindows.keys().next().value);
  warnWindows.set(key, { start: now, count: 1 });
  globalWindow.count++;
  return true;
}

export function logOpsEvent(input, { writer, now } = {}) {
  try {
    const { entry, row } = prepareOpsEvent(input);
    console.log(JSON.stringify(entry));
    if (shouldPersistOpsEvent(input, entry, now)) void writeOpsEvent(row, writer, { audit: input.persist === true });
    return entry;
  } catch {
    // Observability must never change a request result.
    return undefined;
  }
}

export async function logOpsEventAwaited(input, { writer, now, emit = true } = {}) {
  try {
    const { entry, row } = prepareOpsEvent(input);
    if (emit) console.log(JSON.stringify(entry));
    if (shouldPersistOpsEvent(input, entry, now)) await writeOpsEvent(row, writer, { audit: input.persist === true });
    return entry;
  } catch {
    // Auditing must not turn a completed admin mutation into an apparent failure.
    return undefined;
  }
}
