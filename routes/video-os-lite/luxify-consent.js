import { z } from 'zod';

import { luxifyConsentRepository } from '../../db/luxify-consent-repository.js';
import {
  LUXIFY_CONSENT_NOTICE,
  LUXIFY_CONSENT_NOTICE_SHA256,
  issueLuxifyConsentChallenge,
  luxifyConsentChallengeDigest,
  verifyLuxifyConsentChallenge,
} from '../../lib/luxify-consent-policy.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { logOpsEvent } from '../../lib/ops-log.js';
import { deriveLuxifyLookCapability } from '../../lib/luxify-look-capability.js';
import { assertFreshHeygenSpaceBinding, resolveFreshHeygenSpaceBinding } from '../../db/heygen-space-binding-repository.js';
import { readHeygenAvatarLookRaw } from '../../services/heygen.js';
import { consumeRateLimit } from '../../db/repositories.js';

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
  'approve-look': z.object({ action: z.literal('approve-look'), accountId: accountRef, identityId: uuid, expiresInDays: z.number().int().min(1).max(30).optional() }).strict(),
  'revoke-look-approval': z.object({ action: z.literal('revoke-look-approval'), approvalId: uuid }).strict(),
  'list-look-approvals': z.object({ action: z.literal('list-look-approvals'), accountId: accountRef, identityId: uuid.optional() }).strict(),
  // Staff page (/luxify-staff). check-capability takes NO evidence values:
  // the server reads HeyGen itself and derives them.
  'staff-context': z.object({ action: z.literal('staff-context') }).strict(),
  'list-staff': z.object({ action: z.literal('list-staff') }).strict(),
  'staff-lookup': z.object({ action: z.literal('staff-lookup'), email: z.string().trim().min(3).max(254) }).strict(),
  'check-capability': z.object({ action: z.literal('check-capability'), accountId: accountRef, identityId: uuid }).strict(),
};

// QA L3: each check costs a look GET plus a binding qualification, so it is
// throttled per staff actor with the repo's atomic fixed-window counter.
export const LUXIFY_CAPABILITY_CHECK_HOURLY_LIMIT = 5;
const CAPABILITY_CHECK_WINDOW_MS = 60 * 60 * 1000;
// QA L4: the capability check (the only staff action that calls HeyGen) is
// refused while LUXIFY is off. Grant/list/revoke/approve stay available.
const LUXIFY_FEATURE_FLAG = 'VIDEO_OS_LUXIFY_ENABLED';
function luxifyEnabled(environment) {
  return String(environment?.[LUXIFY_FEATURE_FLAG] || '').trim().toLowerCase() === 'true';
}

const defaultCapabilityReader = Object.freeze({
  resolveBinding: input => resolveFreshHeygenSpaceBinding(input),
  assertBinding: binding => assertFreshHeygenSpaceBinding(binding),
  readLook: lookId => readHeygenAvatarLookRaw(lookId),
});

/**
 * Run-time LUXIFY capability check. Order: (1) staff authority + READY look +
 * active space from the DB, no writes; (2) the existing fresh HeyGen space
 * binding path, which proves the configured HeyGen key belongs to the
 * account's pinned space; (3) ONE read-only HeyGen GET of the look; (4)
 * server-side derivation (completed + owned by the pinned space's avatar
 * group; no engine requirement) and hashing; (5) evidence write, re-checked in its
 * own transaction. Any failure before (5) writes nothing.
 */
async function runCapabilityCheck({ repository, reader, staffAccountId, accountId, identityId }) {
  const target = await repository.prepareLookCapabilityCheck({ staffAccountId, accountId, identityId });
  let binding;
  try {
    binding = await reader.resolveBinding({ accountId: target.accountId });
    reader.assertBinding(binding);
  } catch {
    throw routeError('LUXIFY_PROVIDER_SPACE_UNAVAILABLE', 'The HeyGen space for this account could not be verified.', 409, 'PROVIDER_BINDING');
  }
  if (binding?.providerSpaceFingerprint !== target.providerSpaceFingerprint) {
    throw routeError('LUXIFY_PROVIDER_SPACE_MISMATCH', 'The HeyGen space for this account does not match its binding.', 409, 'PROVIDER_BINDING');
  }
  let read;
  try {
    read = await reader.readLook(target.providerLookId);
  } catch {
    throw routeError('LUXIFY_CAPABILITY_READ_FAILED', 'HeyGen could not be read for this look. Nothing was recorded.', 503, 'LUXIFY_CAPABILITY_READ');
  }
  const derived = deriveLuxifyLookCapability({
    providerLookId: target.providerLookId, expectedGroupId: target.providerAvatarGroupId, responseText: read?.text, payload: read?.payload,
  });
  const recorded = await repository.recordCheckedLookCapability({
    staffAccountId,
    accountId: target.accountId,
    identityId: target.identityId,
    providerLookId: target.providerLookId,
    providerSpaceFingerprint: target.providerSpaceFingerprint,
    providerAvatarGroupId: target.providerAvatarGroupId,
    eligible: derived.eligible,
    avatarType: derived.avatarType,
    supportedApiEngines: [...derived.supportedApiEngines],
    evidenceSha256: derived.evidenceSha256,
  });
  return {
    eligible: derived.eligible,
    ...(derived.ineligibleReason ? { ineligibleReason: derived.ineligibleReason } : {}),
    avatarType: derived.avatarType,
    supportedApiEngines: [...derived.supportedApiEngines],
    evidenceRef: `…${derived.evidenceSha256.slice(-8)}`,
    observedAt: recorded.observedAt,
    expiresAt: recorded.expiresAt,
  };
}

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
  capabilityReader = defaultCapabilityReader,
  rateLimit = consumeRateLimit,
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
            challengeSha256: luxifyConsentChallengeDigest(input.challenge),
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
          return send(res, 200, { ok: true, revoked: result.revoked, closedLookApprovals: result.closedLookApprovals, closedCreativeApprovals: result.closedCreativeApprovals });
        case 'approve-creative':
          result = await repository.approveCreativeAsset({ staffAccountId: accountId, mediaAssetId: input.mediaAssetId });
          return send(res, result.replayed ? 200 : 201, { ok: true, replayed: result.replayed });
        case 'approve-look':
          result = await repository.approveLookCreative({ staffAccountId: accountId, accountId: input.accountId, identityId: input.identityId, expiresInDays: input.expiresInDays });
          return send(res, 201, { ok: true, approvalId: result.approvalId, expiresAt: result.expiresAt });
        case 'revoke-look-approval':
          result = await repository.revokeLookCreativeApproval({ staffAccountId: accountId, approvalId: input.approvalId });
          return send(res, 200, { ok: true, changed: result.changed });
        case 'list-look-approvals':
          result = await repository.listLookCreativeApprovals({ staffAccountId: accountId, accountId: input.accountId, ...(input.identityId ? { identityId: input.identityId } : {}) });
          return send(res, 200, { ok: true, approvals: result.approvals });
        case 'staff-context':
          result = await repository.staffContext({ accountId });
          return send(res, 200, { ok: true, ...result });
        case 'list-staff':
          result = await repository.listStaffGrants({ grantorAccountId: accountId });
          return send(res, 200, { ok: true, grants: result.grants });
        case 'staff-lookup':
          result = await repository.lookupStaffTarget({ actorAccountId: accountId, email: input.email });
          return send(res, 200, { ok: true, ...result });
        case 'check-capability': {
          if (!luxifyEnabled(environment)) throw routeError('luxify_unavailable', 'LUXIFY is off, so look capability checks are unavailable.', 503, 'CONFIG_MISSING');
          const allowed = await rateLimit({ accountId, key: `luxify-capability:hourly:${accountId}`, limit: LUXIFY_CAPABILITY_CHECK_HOURLY_LIMIT, windowMs: CAPABILITY_CHECK_WINDOW_MS });
          if (!allowed) throw routeError('rate_limited', 'Capability check limit reached. Try again later.', 429, 'RATE_LIMIT');
          result = await runCapabilityCheck({ repository, reader: capabilityReader, staffAccountId: accountId, accountId: input.accountId, identityId: input.identityId });
          logOpsEvent({ level: 'info', event: 'luxify.capability.checked', accountId, status: 201, code: result.eligible ? 'LUXIFY_CAPABILITY_ELIGIBLE' : 'LUXIFY_CAPABILITY_NOT_ELIGIBLE', message: 'LUXIFY look capability checked.' });
          return send(res, 201, { ok: true, ...result });
        }
        default:
          throw routeError('invalid_request', 'Invalid consent action.');
      }
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      const code = status === 503 && !error?.statusCode ? 'luxify_consent_unavailable' : error?.code || 'luxify_consent_unavailable';
      const message = status === 503 && !error?.statusCode ? 'Consent request could not be completed.' : error.message;
      logOpsEvent({ level: status >= 500 ? 'error' : 'warn', event: 'luxify.consent.rejected', accountId: session?.accountId, status, code, message: 'LUXIFY consent request was rejected.' });
      return send(res, status, { ok: false, code, error: message });
    }
  };
}

export default createLuxifyConsentHandler();
