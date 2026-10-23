import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { consumeRateLimit } from '../../db/repositories.js';
import { generateCopy, gatewayAuthMode } from '../../services/copywriter.js';
import { copywriterDiagnostic } from '../../lib/copywriter-diagnostics.js';
import { logOpsEvent } from '../../lib/ops-log.js';
import { blockedClientTerms, namesBlockedClient } from '../../lib/copywriter-client-guard.js';
import { createCopywriterIdempotency } from '../../lib/copywriter-idempotency.js';

const replayCache = createCopywriterIdempotency();
const dailyWindowMs = 24 * 60 * 60 * 1000;

function globalDailyLimit(env) {
  const raw = String(env.VIDEO_OS_COPYWRITER_GLOBAL_DAILY_LIMIT || '').trim();
  const limit = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function fingerprint(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const briefSchema = z.object({
  topic: z.string().trim().min(1).max(120),
  audience: z.string().trim().min(1).max(160),
  goal: z.enum(['sales', 'social', 'explainer', 'testimonial', 'custom']),
  tone: z.enum(['clear', 'warm', 'confident', 'professional']),
  keyPoints: z.string().trim().max(2000),
  callToAction: z.string().trim().max(300),
}).strict();

const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('draft'), idempotencyKey: z.string().uuid(), brief: briefSchema }).strict(),
  z.object({ operation: z.literal('shorten'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(900) }).strict(),
  z.object({ operation: z.literal('improve_hook'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(900) }).strict(),
  z.object({ operation: z.literal('revise'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(900), instructions: z.string().trim().min(1).max(600) }).strict(),
]);

// An explicit owner kill-switch separate from "not configured yet" (below):
// lets AI generation be turned off for cost control without unsetting the
// Gateway key. Defaults on so a configured deployment works out of the box.
export function copywriterAvailability(env = process.env, headers = {}, budgetReady = false) {
  if (String(env.VIDEO_OS_COPYWRITER_ENABLED ?? 'true').trim().toLowerCase() === 'false') {
    return { available: false, reason: 'disabled', message: 'AI writing is turned off for this deployment.' };
  }
  if (!globalDailyLimit(env)) return { available: false, reason: 'setup_required', code: 'copywriter_budget_unconfigured', message: 'AI writing needs its daily budget configured.' };
  if (!budgetReady) return { available: false, reason: 'setup_required', code: 'copywriter_budget_unavailable', message: 'AI writing needs an account-independent budget store.' };
  if (String(env.VIDEO_OS_COPYWRITER_CLIENT_GUARD || '').trim().toLowerCase() !== 'off' && !blockedClientTerms(env).length) {
    return { available: false, reason: 'setup_required', message: 'AI writing needs its client guard configured.' };
  }
  if (gatewayAuthMode(env, headers) === 'none') {
    return { available: false, reason: 'setup_required', message: 'AI writing needs its server connection and usage limits configured.' };
  }
  return {
    available: true,
    reason: 'ready',
    message: 'AI writing is available. Review suggestions before using them.',
    limits: { maxDraftCharacters: 900, maxBriefCharacters: 2000, maxRevisionCharacters: 600 },
  };
}

export function copywriterFailureRecord(error, { requestId, stage, env = process.env, headers = {} }) {
  const detail = error?.providerDetail || {};
  const safeRequestId = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : null;
  return {
    event: 'copywriter.failure', requestId: safeRequestId, stage: copywriterDiagnostic('stage', stage),
    code: copywriterDiagnostic('code', error?.code) || (error?.statusCode ? 'copywriter_provider_error' : 'copywriter_internal_error'),
    statusClass: copywriterDiagnostic('statusClass', error?.statusClass) || 'internal',
    providerStatus: Number.isInteger(detail.providerStatus) ? detail.providerStatus : null,
    providerErrorType: copywriterDiagnostic('providerErrorType', detail.providerErrorType), errorName: copywriterDiagnostic('errorName', detail.errorName),
    errorCode: copywriterDiagnostic('errorCode', detail.errorCode), message: copywriterDiagnostic('message', detail.message),
    model: null, gatewayAuthMode: gatewayAuthMode(env, headers),
    retryWrapped: detail.retryWrapped === true, attempts: Number.isInteger(detail.attempts) ? detail.attempts : null,
    generationId: null,
  };
}

export function logCopywriterFailure(error, { requestId, stage, env = process.env, headers = {}, accountId, opsLog = logOpsEvent }) {
  const record = copywriterFailureRecord(error, { requestId, stage, env, headers });
  console.error(JSON.stringify(record));
  try {
    opsLog({ event: 'copywriter.failure', accountId, correlationId: requestId, level: 'error', details: record });
  } catch { /* Logging must not alter the response. */ }
  return record;
}

export function createCopywriterHandler({
  authenticate = sessionFromRequest,
  availability = copywriterAvailability,
  generate = generateCopy,
  rateLimit = consumeRateLimit,
  // The existing rate_limits schema requires a cascading user FK. No
  // account-independent global counter can be stored there safely.
  globalBudget = rateLimit === consumeRateLimit ? null : rateLimit,
  idempotency = replayCache,
  hourlyLimit = () => Number(process.env.VIDEO_OS_COPYWRITER_HOURLY_LIMIT || 30),
  opsLog = logOpsEvent,
  newRequestId = randomUUID,
  env = process.env,
} = {}) {
  return async function copywriterHandler(req, res) {
    if (handleOptions(req, res)) return;
    let accountId;
    try { accountId = authenticate(req)?.accountId; } catch {}
    if (!accountId) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to use AI writing.' });
    if (req.method === 'GET') return send(res, 200, { ok: true, copywriter: availability(env, req.headers, Boolean(globalBudget)) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST for the AI copywriter.' });
    const capability = availability(env, req.headers, Boolean(globalBudget));
    if (!capability.available) {
      const notAuthorized = capability.reason === 'not_authorized';
      return send(res, notAuthorized ? 403 : 503, {
        ok: false,
        code: notAuthorized ? 'copywriter_not_authorized' : capability.code || 'copywriter_unavailable',
        error: capability.message,
      });
    }
    let requestId = newRequestId();
    let stage = 'read_body';
    let claimedKey = null;
    try {
      const body = await readJson(req, 40_000);
      stage = 'validate';
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid AI writing request.' });
      requestId = parsed.data.idempotencyKey;
      const terms = blockedClientTerms(env);
      if (String(env.VIDEO_OS_COPYWRITER_CLIENT_GUARD || '').trim().toLowerCase() !== 'off' && namesBlockedClient([parsed.data.brief.topic, parsed.data.brief.audience, parsed.data.brief.keyPoints, parsed.data.brief.callToAction, parsed.data.draft, parsed.data.instructions].filter(Boolean).join('\n'), terms)) {
        return send(res, 422, { ok: false, code: 'copywriter_request_rejected', error: 'AI writing cannot process this request. Please revise it and try again.' });
      }
      const cacheKey = JSON.stringify([accountId, requestId]);
      const claim = idempotency.claim(cacheKey, fingerprint(parsed.data));
      if (claim.state === 'conflict') return send(res, 409, { ok: false, code: 'idempotency_conflict', error: 'This request key was used with different content.' });
      if (claim.state === 'pending') return send(res, 409, { ok: false, code: 'request_in_progress', error: 'This request is already in progress.' });
      if (claim.state === 'capacity') return send(res, 503, { ok: false, code: 'copywriter_unavailable', error: 'AI writing is temporarily busy.' });
      if (claim.state === 'replay') return send(res, 200, { ok: true, result: { ...claim.result, replayed: true } });
      claimedKey = cacheKey;
      stage = 'budget';
      let withinBudget;
      const consumeBudget = () => globalBudget({ key: 'copywriter:global:daily:v1', limit: globalDailyLimit(env), windowMs: dailyWindowMs });
      try { withinBudget = await consumeBudget(); }
      catch { return send(res, 503, { ok: false, code: 'copywriter_budget_unavailable', error: 'AI writing daily budget could not be checked.' }); }
      if (!withinBudget) return send(res, 429, { ok: false, code: 'copywriter_budget_reached', error: 'AI writing daily budget reached.' });
      stage = 'rate_limit';
      const allowed = await rateLimit({ accountId, key: `copywriter:hourly:${accountId}`, limit: hourlyLimit(), windowMs: 60 * 60 * 1000 });
      if (!allowed) return send(res, 429, { ok: false, code: 'rate_limited', error: 'AI writing request limit reached. Try again in a while.' });
      stage = 'generate';
      const generated = await generate(parsed.data, { consumeFallbackBudget: consumeBudget });
      const text = typeof generated === 'string' ? generated : generated.text;
      if (String(env.VIDEO_OS_COPYWRITER_CLIENT_GUARD || '').trim().toLowerCase() !== 'off' && namesBlockedClient(text, terms)) {
        return send(res, 422, { ok: false, code: 'client_reference_blocked', error: 'AI writing contained a client name.' });
      }
      const result = { text, operation: parsed.data.operation, requestId, ...(typeof generated === 'object' ? { truncated: generated.truncated === true } : {}) };
      idempotency.complete(cacheKey, result);
      claimedKey = null;
      return send(res, 200, { ok: true, result });
    } catch (error) {
      const record = logCopywriterFailure(error, { requestId, stage, env, headers: req.headers, accountId, opsLog });
      const status = [400, 401, 403, 409, 422, 429, 503, 504].includes(error?.statusCode) ? error.statusCode : 502;
      const code = error?.code === 'copywriter_budget_reached' ? 'copywriter_budget_reached' : error?.statusCode ? record.code : 'copywriter_internal_error';
      return send(res, status, { ok: false, code, statusClass: record.statusClass, requestId, error: 'AI writing request could not be completed.' });
    } finally {
      if (claimedKey) idempotency.release(claimedKey);
    }
  };
}

export default createCopywriterHandler();
