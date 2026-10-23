import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { consumeRateLimit } from '../../db/repositories.js';
import { generateCopy, gatewayAuthMode } from '../../services/copywriter.js';
import { copywriterDiagnostic } from '../../lib/copywriter-diagnostics.js';
import { logOpsEvent } from '../../lib/ops-log.js';

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
export function copywriterAvailability(env = process.env, headers = {}) {
  if (String(env.VIDEO_OS_COPYWRITER_ENABLED ?? 'true').trim().toLowerCase() === 'false') {
    return { available: false, reason: 'disabled', message: 'AI writing is turned off for this deployment.' };
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
    if (req.method === 'GET') return send(res, 200, { ok: true, copywriter: availability(env, req.headers) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST for the AI copywriter.' });
    const capability = availability(env, req.headers);
    if (!capability.available) {
      const notAuthorized = capability.reason === 'not_authorized';
      return send(res, notAuthorized ? 403 : 503, {
        ok: false,
        code: notAuthorized ? 'copywriter_not_authorized' : 'copywriter_unavailable',
        error: capability.message,
      });
    }
    let requestId = newRequestId();
    let stage = 'read_body';
    try {
      const body = await readJson(req, 40_000);
      stage = 'validate';
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid AI writing request.' });
      requestId = parsed.data.idempotencyKey;
      stage = 'rate_limit';
      const allowed = await rateLimit({ accountId, key: `copywriter:hourly:${accountId}`, limit: hourlyLimit(), windowMs: 60 * 60 * 1000 });
      if (!allowed) return send(res, 429, { ok: false, code: 'rate_limited', error: 'AI writing request limit reached. Try again in a while.' });
      stage = 'generate';
      const text = await generate(parsed.data);
      return send(res, 200, { ok: true, result: { text, operation: parsed.data.operation, requestId: parsed.data.idempotencyKey } });
    } catch (error) {
      const record = logCopywriterFailure(error, { requestId, stage, env, headers: req.headers, accountId, opsLog });
      const status = [400, 401, 403, 409, 422, 429, 503, 504].includes(error?.statusCode) ? error.statusCode : 502;
      const code = error?.statusCode ? record.code : 'copywriter_internal_error';
      return send(res, status, { ok: false, code, statusClass: record.statusClass, requestId, error: 'AI writing request could not be completed.' });
    }
  };
}

export default createCopywriterHandler();
