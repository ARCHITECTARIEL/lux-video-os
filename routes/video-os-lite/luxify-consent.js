import { z } from 'zod';

import { luxifyConsentRepository } from '../../db/luxify-consent-repository.js';
import {
  LUXIFY_CONSENT_NOTICE,
  LUXIFY_CONSENT_NOTICE_SHA256,
  issueLuxifyConsentChallenge,
  verifyLuxifyConsentChallenge,
} from '../../lib/luxify-consent-policy.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { logOpsEvent } from '../../lib/ops-log.js';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const accountRef = z.string().trim().min(1).max(160);

const schemas = {
  grant: z.object({
    action: z.literal('grant'),
    identityId: uuid,
    idempotencyKey: uuid,
    challenge: z.string().min(1).max(1024),
    noticeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    cinematicGenerationAuthorization: z.literal(true),
    providerProcessingAuthorization: z.literal(true),
    expiryDays: z.number().int().min(1).max(365).optional(),
  }).strict(),
  withdraw: z.object({ action: z.literal('withdraw'), consentId: uuid }).strict(),
  revoke: z.object({ action: z.literal('revoke'), consentId: uuid }).strict(),
  'revoke-source': z.object({ action: z.literal('revoke-source'), identityConsentId: uuid }).strict(),
  'grant-staff': z.object({ action: z.literal('grant-staff'), staffAccountId: accountRef, explicitGrant: z.literal(true) }).strict(),
  'revoke-staff': z.object({ action: z.literal('revoke-staff'), staffAccountId: accountRef }).strict(),
  'approve-creative': z.object({ action: z.literal('approve-creative'), mediaAssetId: uuid }).strict(),
  'record-capability': z.object({
    action: z.literal('record-capability'),
    accountId: accountRef,
    providerLookId: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
    eligible: z.boolean(),
    avatarType: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    supportedApiEngines: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/)).max(20),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
};

function routeError(code, message, statusCode = 400, failureCategory = 'VALIDATION') {
  return Object.assign(new Error(message), { code, statusCode, failureCategory });
}

function assertTransport(req, env, { json = false } = {}) {
  const origin = req.headers?.origin;
  if (!env.VIDEO_OS_PUBLIC_ORIGIN || (json ? origin !== env.VIDEO_OS_PUBLIC_ORIGIN : ![undefined, env.VIDEO_OS_PUBLIC_ORIGIN].includes(origin))
    || !['same-origin', 'none', undefined].includes(req.headers?.['sec-fetch-site'])) {
    throw routeError('origin_not_allowed', 'Origin not allowed.', 403);
  }
  if (json && String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw routeError('json_required', 'JSON required.', 400);
  }
}

async function requestBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? await readJson(req));
  } catch {
    throw routeError('invalid_request', 'Invalid JSON request.');
  }
}

/**
 * Subject-only LUXIFY cinematic consent capture, withdrawal and revocation.
 * Consent capture does not depend on VIDEO_OS_LUXIFY_ENABLED: recording
 * consent never enables LUXIFY rendering, which stays behind its own gates.
 */
export function createLuxifyConsentHandler({
  authenticate = sessionFromRequest,
  environment = process.env,
  repository = luxifyConsentRepository,
  now = () => Date.now(),
} = {}) {
  return async function luxifyConsentHandler(req, res) {
    if (handleOptions(req, res)) return;
    res.setHeader?.('Cache-Control', 'no-store');
    let session;
    try {
      try { session = authenticate(req); } catch { session = null; }
      if (!session?.accountId) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST.' });
      assertTransport(req, environment, { json: req.method === 'POST' });
      const accountId = session.accountId;

      if (req.method === 'GET') {
        const state = await repository.listConsents({ accountId });
        const issuedAt = now();
        return send(res, 200, {
          ok: true,
          notice: LUXIFY_CONSENT_NOTICE,
          noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
          identities: state.identities.map(identity => ({
            identityId: identity.id,
            displayName: identity.displayName,
            challenge: issueLuxifyConsentChallenge({ accountId, identityId: identity.id, now: issuedAt, env: environment }),
          })),
          consents: state.consents,
        });
      }

      const body = await requestBody(req);
      const schema = Object.hasOwn(schemas, body?.action) ? schemas[body.action] : null;
      if (!schema) throw routeError('invalid_request', 'Invalid consent action.');
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw routeError('invalid_request', 'Invalid consent request.');
      const input = parsed.data;
      let result;
      switch (input.action) {
        case 'grant':
          verifyLuxifyConsentChallenge(input.challenge, { accountId, identityId: input.identityId, now: now(), env: environment });
          result = await repository.grantConsent({
            accountId,
            identityId: input.identityId,
            idempotencyKey: input.idempotencyKey,
            noticeSha256: input.noticeSha256,
            cinematicGenerationAuthorization: input.cinematicGenerationAuthorization,
            providerProcessingAuthorization: input.providerProcessingAuthorization,
            ...(input.expiryDays ? { expiryDays: input.expiryDays } : {}),
          });
          logOpsEvent({ level: 'info', event: 'luxify.consent.granted', accountId, status: 201, code: 'LUXIFY_CONSENT_GRANTED', message: 'LUXIFY consent recorded.' });
          return send(res, result.replayed ? 200 : 201, { ok: true, ...result });
        case 'withdraw':
          result = await repository.withdrawConsent({ accountId, consentId: input.consentId });
          logOpsEvent({ level: 'info', event: 'luxify.consent.withdrawn', accountId, status: 200, code: 'LUXIFY_CONSENT_WITHDRAWN', message: 'LUXIFY consent withdrawn.' });
          return send(res, 200, { ok: true, ...result });
        case 'revoke-source':
          result = await repository.revokeSourceIdentityConsent({ accountId, identityConsentId: input.identityConsentId });
          return send(res, 200, { ok: true, ...result });
        case 'revoke':
          result = await repository.revokeConsent({ staffAccountId: accountId, consentId: input.consentId });
          return send(res, 200, { ok: true, ...result });
        case 'grant-staff':
          result = await repository.grantStaff({ grantorAccountId: accountId, staffAccountId: input.staffAccountId, explicitGrant: input.explicitGrant });
          return send(res, result.replayed ? 200 : 201, { ok: true, replayed: result.replayed });
        case 'revoke-staff':
          result = await repository.revokeStaffGrant({ grantorAccountId: accountId, staffAccountId: input.staffAccountId });
          return send(res, 200, { ok: true, ...result });
        case 'approve-creative':
          result = await repository.approveCreativeAsset({ staffAccountId: accountId, mediaAssetId: input.mediaAssetId });
          return send(res, result.replayed ? 200 : 201, { ok: true, replayed: result.replayed });
        case 'record-capability': {
          const { action, ...evidence } = input;
          await repository.recordLookCapabilityEvidence({ staffAccountId: accountId, ...evidence });
          return send(res, 201, { ok: true });
        }
        default:
          throw routeError('invalid_request', 'Invalid consent action.');
      }
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 503].includes(error?.statusCode) ? error.statusCode : 503;
      const code = status === 503 && !error?.statusCode ? 'luxify_consent_unavailable' : error?.code || 'luxify_consent_unavailable';
      const message = status === 503 && !error?.statusCode ? 'Consent request could not be completed.' : error.message;
      logOpsEvent({ level: status >= 500 ? 'error' : 'warn', event: 'luxify.consent.rejected', accountId: session?.accountId, status, code, message: 'LUXIFY consent request was rejected.' });
      return send(res, status, { ok: false, code, error: message });
    }
  };
}

export default createLuxifyConsentHandler();
