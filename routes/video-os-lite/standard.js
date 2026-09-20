import { z } from 'zod';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { standardNarrationRepository } from '../../db/standard-narration-repository.js';
import { STANDARD_CONTRACT_VERSION, STANDARD_NARRATION_POLICY_VERSION, sanitizeStandardNarrationReason } from '../../lib/standard-narration-contract.js';

const binding = { projectId: z.string().uuid(), identityId: z.string().uuid(), audioAssetId: z.string().uuid() };
const mutationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('consent'), contractVersion: z.literal(STANDARD_CONTRACT_VERSION), ...binding, idempotencyKey: z.string().uuid(), policyVersion: z.literal(STANDARD_NARRATION_POLICY_VERSION), consent: z.literal(true) }).strict(),
  z.object({ operation: z.literal('revoke'), contractVersion: z.literal(STANDARD_CONTRACT_VERSION), consentId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('quote'), contractVersion: z.literal(STANDARD_CONTRACT_VERSION), ...binding, narrationConsentId: z.string().uuid(), format: z.enum(['vertical', 'landscape', 'square']) }).strict(),
]);
const readinessQuerySchema = z.object({
  operation: z.enum(['readiness', 'status']).default('readiness'),
  projectId: z.string().uuid().optional(),
  identityId: z.string().uuid().optional(),
  audioAssetId: z.string().uuid().optional(),
  narrationConsentId: z.string().uuid().optional(),
}).strict();

function logStandardFailure(error) {
  const cause = error?.cause || error;
  console.error(JSON.stringify({
    event: 'video_os_standard_failure',
    code: cause?.code || null,
    constraint: cause?.constraint || null,
    table: cause?.table || null,
    column: cause?.column || null,
    failureCategory: error?.failureCategory || null,
  }));
}

export function createStandardContractHandler({
  authenticate = sessionFromRequest,
  repository = standardNarrationRepository,
} = {}) {
  return async function standardContractHandler(req, res) {
    if (handleOptions(req, res)) return;
    let accountId;
    try {
      accountId = authenticate(req)?.accountId;
    } catch {}
    if (!accountId) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed.' });
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'https://video-os.invalid');
        const parsed = readinessQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) return send(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid readiness request.' });
        if (parsed.data.operation === 'status') return send(res, 200, { ok: true, consent: await repository.consentStatus(accountId, accountId, parsed.data) });
        return send(res, 200, { ok: true, readiness: await repository.readiness(accountId, accountId, parsed.data) });
      }
      if (!process.env.VIDEO_OS_PUBLIC_ORIGIN || req.headers?.origin !== process.env.VIDEO_OS_PUBLIC_ORIGIN || !['same-origin', 'none', undefined].includes(req.headers?.['sec-fetch-site'])) {
        return send(res, 403, { ok: false, code: 'origin_not_allowed', error: 'Origin not allowed.' });
      }
      if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return send(res, 400, { ok: false, code: 'invalid_request', error: 'JSON required.' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? await readJson(req));
      const parsed = mutationSchema.safeParse(body);
      if (!parsed.success) return send(res, 400, { ok: false, code: 'invalid_request', error: 'Invalid Standard request.' });
      const { operation, contractVersion, ...payload } = parsed.data;
      const method = { consent: 'grantConsent', revoke: 'revokeConsent', quote: 'createQuote' }[operation];
      const result = await repository[method](accountId, accountId, payload);
      const fields = operation === 'quote'
        ? ['id', 'contractVersion', 'projectId', 'identityId', 'audioAssetId', 'narrationConsentId', 'policyVersion', 'pricingVersion', 'format', 'credits', 'createdAt', 'expiresAt']
        : ['id', 'projectId', 'identityId', 'audioAssetId', 'policyVersion', 'grantedAt', 'revokedAt'];
      const publicResult = Object.fromEntries(fields.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
      return send(res, operation === 'revoke' ? 200 : 201, { ok: true, [operation === 'quote' ? 'quote' : 'consent']: publicResult });
    } catch (error) {
      logStandardFailure(error);
      return send(res, [400, 401, 402, 403, 404, 409, 410, 422, 503].includes(error.statusCode) ? error.statusCode : 503, { ok: false, code: sanitizeStandardNarrationReason(error.code), error: 'Standard narration request could not be completed.' });
    }
  };
}

export default createStandardContractHandler();
