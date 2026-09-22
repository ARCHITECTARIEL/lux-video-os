import { z } from 'zod';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { consumeRateLimit } from '../../db/repositories.js';
import { generateCopy } from '../../services/copywriter.js';

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
  z.object({ operation: z.literal('shorten'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ operation: z.literal('improve_hook'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ operation: z.literal('revise'), idempotencyKey: z.string().uuid(), brief: briefSchema, draft: z.string().trim().min(1).max(4000), instructions: z.string().trim().min(1).max(600) }).strict(),
]);

// An explicit owner kill-switch separate from "not configured yet" (below):
// lets AI generation be turned off for cost control without unsetting the
// Gateway key. Defaults on so a configured deployment works out of the box.
export function copywriterAvailability() {
  if (String(process.env.VIDEO_OS_COPYWRITER_ENABLED ?? 'true').trim().toLowerCase() === 'false') {
    return { available: false, reason: 'disabled', message: 'AI writing is turned off for this deployment.' };
  }
  if (!String(process.env.AI_GATEWAY_API_KEY || '').trim()) {
    return { available: false, reason: 'setup_required', message: 'AI writing needs its server connection and usage limits configured.' };
  }
  return {
    available: true,
    reason: 'ready',
    message: 'AI writing is available. Review suggestions before using them.',
    limits: { maxDraftCharacters: 4000, maxBriefCharacters: 2000, maxRevisionCharacters: 600 },
  };
}

function logCopywriterFailure(error) {
  console.error(JSON.stringify({
    event: 'video_os_copywriter_failure',
    code: error?.code || null,
    failureCategory: error?.failureCategory || null,
  }));
}

export function createCopywriterHandler({
  authenticate = sessionFromRequest,
  availability = copywriterAvailability,
  generate = generateCopy,
  rateLimit = consumeRateLimit,
  hourlyLimit = () => Number(process.env.VIDEO_OS_COPYWRITER_HOURLY_LIMIT || 30),
} = {}) {
  return async function copywriterHandler(req, res) {
    if (handleOptions(req, res)) return;
    let accountId;
    try { accountId = authenticate(req)?.accountId; } catch {}
    if (!accountId) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to use AI writing.' });
    if (req.method === 'GET') return send(res, 200, { ok: true, copywriter: availability() });
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST for the AI copywriter.' });
    const capability = availability();
    if (!capability.available) {
      const notAuthorized = capability.reason === 'not_authorized';
      return send(res, notAuthorized ? 403 : 503, {
        ok: false,
        code: notAuthorized ? 'copywriter_not_authorized' : 'copywriter_unavailable',
        error: capability.message,
      });
    }
    try {
      const body = await readJson(req, 40_000);
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid AI writing request.' });
      const allowed = await rateLimit({ accountId, key: `copywriter:hourly:${accountId}`, limit: hourlyLimit(), windowMs: 60 * 60 * 1000 });
      if (!allowed) return send(res, 429, { ok: false, code: 'rate_limited', error: 'AI writing request limit reached. Try again in a while.' });
      const text = await generate(parsed.data);
      return send(res, 200, { ok: true, result: { text, operation: parsed.data.operation, requestId: parsed.data.idempotencyKey } });
    } catch (error) {
      logCopywriterFailure(error);
      const status = [400, 401, 403, 422, 429, 503, 504].includes(error.statusCode) ? error.statusCode : 502;
      return send(res, status, { ok: false, code: error.code || 'generation_failed', error: error.statusCode ? error.message : 'AI writing request could not be completed.' });
    }
  };
}

export default createCopywriterHandler();
