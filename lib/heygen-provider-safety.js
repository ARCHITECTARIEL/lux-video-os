import { createHash } from 'node:crypto';

export const HEYGEN_ADMISSION_LOCK_KEY = 730561014001;
export const HEYGEN_ACTIVE_STATUSES = Object.freeze(['provider_submitting', 'provider_submitted', 'provider_rendering', 'provider_submit_unknown']);

export function heygenReconcilerMode(env = process.env) {
  // An explicit nonblank mode wins, including an invalid value (fail closed).
  // A blank mode is treated as unset so existing legacy enablement still works.
  const mode = String(env.VIDEO_OS_HEYGEN_RECONCILER_MODE ?? '').trim().toLowerCase();
  if (mode) return ['off', 'shadow', 'act'].includes(mode) ? mode : 'off';
  return env.VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED === 'true' ? 'act' : 'off';
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function heygenLimits(env = process.env) {
  const global = boundedInteger(env.VIDEO_OS_HEYGEN_MAX_CONCURRENCY, 8, 1, 10);
  return {
    global,
    perAccount: Math.min(global, boundedInteger(env.VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT, 2, 1, global)),
    maxRetries: boundedInteger(env.VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS, 6, 0, 20),
  };
}

export function heygenCapacityAvailable(counts, accountId, limits) {
  const total = counts.reduce((sum, row) => sum + Number(row.count), 0);
  const account = Number(counts.find(row => row.account_id === accountId)?.count || 0);
  return total < limits.global && account < limits.perAccount;
}

export function heygenSubmissionIdentity(jobId, attempt = 0) {
  if (typeof jobId !== 'string' || !jobId || !Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError('Invalid HeyGen submission identity.');
  const digest = createHash('sha256').update(`${jobId}|${attempt}`).digest('hex');
  return { idempotencyKey: `vos-${digest.slice(0, 32)}`, marker: `vos-${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}` };
}

export function heygenRetryDelayMs({ retryAfter, retryNumber, now = Date.now(), random = Math.random }) {
  const date = typeof now === 'number' ? now : new Date(now).getTime();
  const header = String(retryAfter ?? '').trim();
  if (header) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : NaN;
    const parsed = Number.isFinite(seconds) ? seconds : Date.parse(header) - date;
    if (Number.isFinite(parsed)) return Math.min(900_000, Math.max(0, Math.ceil(parsed)));
  }
  const jitter = Number(random());
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw new TypeError('Invalid retry RNG.');
  return Math.floor(jitter * Math.min(900_000, 1_000 * 2 ** Math.min(20, Math.max(0, retryNumber - 1))));
}

export function heygenRetryableResponse(response, { retryNumber, now, random } = {}) {
  if (response.status !== 429 && response.status !== 503) return null;
  return Object.assign(new Error(`HeyGen returned HTTP ${response.status}.`), {
    failureCategory: 'PROVIDER_RETRYABLE',
    providerHttpStatus: response.status,
    retryDelayMs: heygenRetryDelayMs({ retryAfter: response.headers?.get?.('retry-after'), retryNumber, now, random }),
  });
}
