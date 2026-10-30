import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { consumeRateLimit, requirePersistedRenderAuthorization } from '../../db/repositories.js';
import { luxifyRepository } from '../../db/luxify-repository.js';
import { resolveDatabaseLuxifyEligibility } from '../../db/luxify-consent-repository.js';
import { providerCreationActivationStatus } from '../../db/provider-reconciliation-repository.js';
import {
  LUXIFY_ASPECT_RATIOS,
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_MAX_DURATION_SECONDS,
  LUXIFY_MAX_LOOKS,
  LUXIFY_MIN_DURATION_SECONDS,
  LUXIFY_MIN_LOOKS,
  LUXIFY_PROMPT_MAX_CHARS,
  LUXIFY_RESOLUTIONS,
  LUXIFY_TITLE_MAX_CHARS,
} from '../../lib/luxify-contract.js';
import {
  configuredLuxifyCredits,
  issueLuxifyQuote,
} from '../../lib/luxify-quote.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { logOpsEvent } from '../../lib/ops-log.js';
import {
  assertPinnedHeygenSpaceAnchorProjection,
  loadPinnedHeygenSpaceAnchorProjection,
} from '../../lib/heygen-space-anchor.js';

export const LUXIFY_FEATURE_FLAG = 'VIDEO_OS_LUXIFY_ENABLED';
export const LUXIFY_ACCOUNT_PIN_ENV = 'VIDEO_OS_LUXIFY_ACCOUNT_ID';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const ELIGIBILITY_REVISION = /^[A-Za-z0-9_.:-]{1,160}$/;
const MEDIA_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CREDENTIAL_FINGERPRINT_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8');
const RUNTIME_REASONS = new Set([
  'provider_config_unavailable',
  'provider_timeout_invalid',
  'quote_signing_unavailable',
  'private_storage_unavailable',
  'provider_media_allowlist_unavailable',
  'provider_creation_disabled',
  'durable_workflow_disabled',
  'hosted_finishing_disabled',
  'provider_qualification_unavailable',
  'runtime_preflight_unavailable',
]);
const canonicalUuid = z.string().uuid().transform(value => value.toLowerCase());
const lookIdentityIds = z.array(canonicalUuid).min(LUXIFY_MIN_LOOKS).max(LUXIFY_MAX_LOOKS).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'LUXIFY look identities must be unique.' });
});

const saveProjectSchema = z.object({
  action: z.literal('save-project'),
  contractVersion: z.literal(LUXIFY_CONTRACT_VERSION),
  projectId: canonicalUuid,
  title: z.string().trim().min(1).max(LUXIFY_TITLE_MAX_CHARS),
  prompt: z.string().trim().min(1).max(LUXIFY_PROMPT_MAX_CHARS),
  lookIdentityIds,
  aspectRatio: z.enum(LUXIFY_ASPECT_RATIOS),
  resolution: z.enum(LUXIFY_RESOLUTIONS),
  durationSeconds: z.number().int().min(LUXIFY_MIN_DURATION_SECONDS).max(LUXIFY_MAX_DURATION_SECONDS),
}).strict();

const quoteSchema = z.object({
  action: z.literal('quote'),
  contractVersion: z.literal(LUXIFY_CONTRACT_VERSION),
  projectId: canonicalUuid,
  idempotencyKey: canonicalUuid,
}).strict();

function routeError(code, message, statusCode = 400, failureCategory = 'VALIDATION', extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, failureCategory, ...extra });
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

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw routeError('invalid_request', 'Invalid LUXIFY request.', 400, 'VALIDATION', { issues: result.error.issues });
  return result.data;
}

async function requestBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? await readJson(req));
  } catch {
    throw routeError('invalid_request', 'Invalid JSON request.');
  }
}

function recoveryQuery(req) {
  const url = new URL(req.url, 'https://video-os.invalid');
  const keys = [...url.searchParams.keys()];
  if (!keys.length) return null;
  const allowed = new Set(['contractVersion', 'projectId', 'idempotencyKey']);
  if (keys.length !== allowed.size || new Set(keys).size !== keys.length || keys.some(key => !allowed.has(key))) {
    throw routeError('invalid_request', 'Invalid LUXIFY recovery request.');
  }
  const value = Object.fromEntries([...allowed].map(key => [key, url.searchParams.get(key)]));
  if (value.contractVersion !== LUXIFY_CONTRACT_VERSION || !UUID.test(value.projectId || '') || !UUID.test(value.idempotencyKey || '')) {
    throw routeError('invalid_request', 'Invalid LUXIFY recovery request.');
  }
  return { contractVersion: value.contractVersion, projectId: value.projectId.toLowerCase(), idempotencyKey: value.idempotencyKey.toLowerCase() };
}

function hourlyLimit(env) {
  const value = Number(env.VIDEO_OS_LUXIFY_HOURLY_LIMIT || 60);
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000 ? value : 60;
}

function staticGateReasons(accountId, env) {
  const reasons = [];
  if (String(env[LUXIFY_FEATURE_FLAG] || '').trim().toLowerCase() !== 'true') reasons.push('feature_disabled');
  if (!String(env[LUXIFY_ACCOUNT_PIN_ENV] || '').trim() || String(env[LUXIFY_ACCOUNT_PIN_ENV]).trim() !== accountId) reasons.push('account_not_pinned');
  try {
    for (const resolution of LUXIFY_RESOLUTIONS) configuredLuxifyCredits(resolution, env);
  } catch {
    reasons.push('pricing_unconfigured');
  }
  return reasons;
}

function configuredCredential(env) {
  const primary = typeof env?.HEYGEN_API_KEY === 'string' ? env.HEYGEN_API_KEY.trim() : '';
  const alias = typeof env?.HEYGEN_TOKEN === 'string' ? env.HEYGEN_TOKEN.trim() : '';
  if (primary && alias && primary !== alias) return null;
  const value = primary || alias;
  return value && value.length <= 1_024 && !/[\r\n\u0000]/.test(value) ? value : null;
}

function privateStorageConfigured(env) {
  const driver = String(env?.STORAGE_DRIVER || 'blob').trim().toLowerCase();
  if (driver === 'blob') {
    const token = String(env?.BLOB_READ_WRITE_TOKEN || '');
    return token === token.trim() && token.length > 0 && token.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(token);
  }
  if (driver !== 'fs') return false;
  const root = String(env?.STORAGE_FS_ROOT || '/var/lib/video-os/blob');
  return root === root.trim() && root.length > 1 && root.length <= 1_024 && isAbsolute(root) && !root.includes('\0');
}

function mediaAllowlistConfigured(env) {
  const values = String(env?.VIDEO_OS_PROVIDER_MEDIA_HOSTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return values.length > 0 && values.length <= 20 && new Set(values).size === values.length
    && values.every(host => MEDIA_HOST.test(host) && !isIP(host));
}

function credentialFingerprint(credential) {
  return createHash('sha256').update(CREDENTIAL_FINGERPRINT_DOMAIN).update(credential, 'utf8').digest('hex');
}

function enabledRuntimeFlag(env, name) {
  return String(env?.[name] || '').trim().toLowerCase() === 'true';
}

export async function defaultLuxifyRuntimePreflight({
  env = process.env,
  accountId,
  now = new Date(),
  loadQualificationEvidence = loadPinnedHeygenSpaceAnchorProjection,
  assertQualificationEvidence = assertPinnedHeygenSpaceAnchorProjection,
} = {}) {
  const reasons = [];
  const credential = configuredCredential(env);
  if (!credential) reasons.push('provider_config_unavailable');

  const timeout = Number(env?.HEYGEN_TIMEOUT_MS || 20_000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) reasons.push('provider_timeout_invalid');

  const secret = String(env?.VIDEO_OS_SESSION_SECRET || '');
  if (secret !== secret.trim() || secret.length < 32 || secret.length > 8_192 || /[\u0000-\u001f\u007f]/.test(secret)) {
    reasons.push('quote_signing_unavailable');
  }
  if (!privateStorageConfigured(env)) reasons.push('private_storage_unavailable');
  if (!mediaAllowlistConfigured(env)) reasons.push('provider_media_allowlist_unavailable');
  if (providerCreationActivationStatus(env, accountId).enabled !== true) reasons.push('provider_creation_disabled');
  if (!enabledRuntimeFlag(env, 'VIDEO_OS_DURABLE_WORKFLOW_ENABLED')) reasons.push('durable_workflow_disabled');
  if (!enabledRuntimeFlag(env, 'VIDEO_OS_HOSTED_FINISHING_ENABLED')) reasons.push('hosted_finishing_disabled');

  if (!credential || typeof loadQualificationEvidence !== 'function' || typeof assertQualificationEvidence !== 'function') {
    reasons.push('provider_qualification_unavailable');
  } else {
    try {
      const evidence = await loadQualificationEvidence({ now });
      const approved = assertQualificationEvidence(evidence, { now });
      if (approved?.provider !== 'heygen' || approved?.credentialKeyFingerprint !== credentialFingerprint(credential)) {
        reasons.push('provider_qualification_unavailable');
      }
    } catch {
      reasons.push('provider_qualification_unavailable');
    }
  }

  const unique = Object.freeze([...new Set(reasons)]);
  return Object.freeze({ ready: unique.length === 0, reasons: unique });
}

function exactRuntimePreflight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || typeof value.ready !== 'boolean'
    || !Array.isArray(value.reasons) || new Set(value.reasons).size !== value.reasons.length
    || value.reasons.some(reason => !RUNTIME_REASONS.has(reason))
    || value.ready !== (value.reasons.length === 0)) {
    return Object.freeze({ ready: false, reasons: Object.freeze(['runtime_preflight_unavailable']) });
  }
  return Object.freeze({ ready: value.ready, reasons: Object.freeze([...value.reasons]) });
}

async function runtimeStatus(accountId, { env, runtimePreflight }) {
  try {
    return exactRuntimePreflight(await runtimePreflight({ accountId, env }));
  } catch {
    return Object.freeze({ ready: false, reasons: Object.freeze(['runtime_preflight_unavailable']) });
  }
}

function safeEligibleLooks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.eligibleLooks)) {
    throw routeError('luxify_eligibility_unavailable', 'LUXIFY look eligibility is unavailable.', 503, 'CONFIG_MISSING');
  }
  const seen = new Set();
  const looks = value.eligibleLooks.map(candidate => {
    const identityId = String(candidate?.identityId || '').toLowerCase();
    const displayName = String(candidate?.displayName || '').trim();
    if (!UUID.test(identityId) || seen.has(identityId) || !displayName || displayName.length > 120) {
      throw routeError('luxify_eligibility_unavailable', 'LUXIFY look eligibility is unavailable.', 503, 'CONFIG_MISSING');
    }
    seen.add(identityId);
    return Object.freeze({ identityId, displayName });
  });
  return Object.freeze(looks);
}

function exactSelectedEligibility(value, lookIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Array.isArray(value.lookBindings)
    || !ELIGIBILITY_REVISION.test(value.eligibilityRevision || '')
    || value.lookBindings.length !== lookIds.length) {
    throw routeError('luxify_look_unavailable', 'One or more LUXIFY looks are unavailable.', 409, 'ENTITLEMENT');
  }
  const bindings = value.lookBindings.map((binding, index) => {
    const identityId = String(binding?.identityId || '').toLowerCase();
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).length !== 2 || !UUID.test(identityId)
      || identityId !== lookIds[index] || !PROVIDER_ID.test(binding.providerLookId || '')) {
      throw routeError('luxify_look_unavailable', 'One or more LUXIFY looks are unavailable.', 409, 'ENTITLEMENT');
    }
    return Object.freeze({ identityId, providerLookId: binding.providerLookId });
  });
  if (new Set(bindings.map(item => item.providerLookId)).size !== bindings.length) {
    throw routeError('luxify_look_unavailable', 'One or more LUXIFY looks are unavailable.', 409, 'ENTITLEMENT');
  }
  return Object.freeze({ lookBindings: Object.freeze(bindings), eligibilityRevision: value.eligibilityRevision });
}

// Kept for tests and explicit opt-out; production defaults to the DB-backed
// resolver, which is only reached after every static gate passes.
export async function unavailableLuxifyEligibilityResolver() {
  throw routeError('luxify_eligibility_unavailable', 'LUXIFY look eligibility is unavailable.', 503, 'CONFIG_MISSING');
}

async function capabilityFor(accountId, { env, runtimePreflight, authorizePremium, resolveEligibility }) {
  const reasons = staticGateReasons(accountId, env);
  let eligibleLooks = Object.freeze([]);
  if (!reasons.length) {
    const runtime = await runtimeStatus(accountId, { env, runtimePreflight });
    reasons.push(...runtime.reasons);
  }
  if (!reasons.length) {
    try {
      await authorizePremium(accountId, 'premium');
    } catch (error) {
      reasons.push(error?.statusCode === 403 ? 'premium_access_required' : 'authorization_unavailable');
    }
  }
  if (!reasons.length) {
    try {
      eligibleLooks = safeEligibleLooks(await resolveEligibility({ accountId }));
      if (!eligibleLooks.length) reasons.push('no_eligible_looks');
    } catch {
      reasons.push('look_eligibility_unavailable');
      eligibleLooks = Object.freeze([]);
    }
  }
  return Object.freeze({
    available: reasons.length === 0 && eligibleLooks.length > 0,
    reasons: Object.freeze([...new Set(reasons)]),
    eligibleLooks,
  });
}

export async function requireLuxifyActivation(accountId, lookIds, { env, runtimePreflight, authorizePremium, resolveEligibility }) {
  const reasons = staticGateReasons(accountId, env);
  if (reasons.length) throw routeError('luxify_unavailable', 'LUXIFY is not currently available.', 503, 'CONFIG_MISSING', { reasons });
  const runtime = await runtimeStatus(accountId, { env, runtimePreflight });
  if (!runtime.ready) throw routeError('luxify_unavailable', 'LUXIFY is not currently available.', 503, 'CONFIG_MISSING', { reasons: runtime.reasons });
  try {
    await authorizePremium(accountId, 'premium');
  } catch (error) {
    if (error?.statusCode === 403) {
      throw routeError('luxify_premium_required', 'Current Premium access is required for LUXIFY.', 403, 'ENTITLEMENT');
    }
    throw routeError('luxify_authorization_unavailable', 'LUXIFY authorization is unavailable.', 503, 'CONFIG_MISSING');
  }
  try {
    return exactSelectedEligibility(await resolveEligibility({ accountId, lookIdentityIds: [...lookIds] }), lookIds);
  } catch (error) {
    if (error?.code === 'luxify_look_unavailable') throw error;
    throw routeError('luxify_look_unavailable', 'One or more LUXIFY looks are unavailable.', 409, 'ENTITLEMENT');
  }
}

function bindingFrom(project, idempotencyKey, eligibility, accountId) {
  return {
    accountId,
    projectId: project.id,
    idempotencyKey,
    title: project.title,
    prompt: project.prompt,
    lookBindings: eligibility.lookBindings,
    eligibilityRevision: eligibility.eligibilityRevision,
    aspectRatio: project.aspectRatio,
    resolution: project.resolution,
    durationSeconds: project.durationSeconds,
  };
}

export function createLuxifyHandler({
  authenticate = sessionFromRequest,
  environment = process.env,
  rateLimit = consumeRateLimit,
  repository = luxifyRepository,
  authorizePremium = requirePersistedRenderAuthorization,
  resolveEligibility = resolveDatabaseLuxifyEligibility,
  runtimePreflight = defaultLuxifyRuntimePreflight,
  quoteIssuer = issueLuxifyQuote,
  quoteOptions = {},
} = {}) {
  if (!repository || ['getProject', 'recoverJob', 'saveProject'].some(method => typeof repository[method] !== 'function')) {
    throw new TypeError('A complete LUXIFY repository is required.');
  }
  if (typeof resolveEligibility !== 'function' || typeof runtimePreflight !== 'function'
    || typeof authorizePremium !== 'function' || typeof quoteIssuer !== 'function') {
    throw new TypeError('LUXIFY runtime, authorization, eligibility, and quote dependencies are required.');
  }

  return async function luxifyHandler(req, res) {
    if (handleOptions(req, res)) return;
    let session;
    try {
      try {
        session = authenticate(req);
      } catch {
        logOpsEvent({ level: 'warn', event: 'luxify.request.rejected', status: 401, code: 'sign_in_required', message: 'LUXIFY request was rejected.' });
        return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
      }
      if (!session?.accountId) {
        logOpsEvent({ level: 'warn', event: 'luxify.request.rejected', status: 401, code: 'sign_in_required', message: 'LUXIFY request was rejected.' });
        return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
      }
      if (!['GET', 'POST'].includes(req.method)) {
        logOpsEvent({ level: 'warn', event: 'luxify.request.rejected', accountId: session.accountId, status: 405, code: 'method_not_allowed', message: 'LUXIFY request was rejected.' });
        return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST.' });
      }
      assertTransport(req, environment, { json: req.method === 'POST' });

      const allowed = await rateLimit({
        accountId: session.accountId,
        key: `luxify:hourly:${session.accountId}`,
        limit: hourlyLimit(environment),
        windowMs: 60 * 60 * 1_000,
      });
      if (!allowed) throw routeError('rate_limited', 'LUXIFY request limit reached.', 429);

      if (req.method === 'GET') {
        const recovery = recoveryQuery(req);
        if (recovery) {
          const existingJob = await repository.recoverJob({ accountId: session.accountId, ...recovery });
          return send(res, 200, { ok: true, existingJob });
        }
        const capabilities = await capabilityFor(session.accountId, {
          env: environment,
          runtimePreflight,
          authorizePremium,
          resolveEligibility,
        });
        return send(res, 200, { ok: true, contractVersion: LUXIFY_CONTRACT_VERSION, capabilities });
      }

      const body = await requestBody(req);
      if (body?.action === 'save-project') {
        const payload = parse(saveProjectSchema, body);
        await requireLuxifyActivation(session.accountId, payload.lookIdentityIds, {
          env: environment,
          runtimePreflight,
          authorizePremium,
          resolveEligibility,
        });
        const project = await repository.saveProject({
          accountId: session.accountId,
          contractVersion: payload.contractVersion,
          projectId: payload.projectId,
          title: payload.title,
          prompt: payload.prompt,
          lookIdentityIds: payload.lookIdentityIds,
          aspectRatio: payload.aspectRatio,
          resolution: payload.resolution,
          durationSeconds: payload.durationSeconds,
        });
        return send(res, 200, { ok: true, project });
      }
      if (body?.action === 'quote') {
        const payload = parse(quoteSchema, body);
        const recovery = {
          accountId: session.accountId,
          contractVersion: payload.contractVersion,
          projectId: payload.projectId,
          idempotencyKey: payload.idempotencyKey,
        };
        const existingJob = await repository.recoverJob(recovery);
        if (existingJob) {
          logOpsEvent({ level: 'info', event: 'luxify.quote.recovered', accountId: session.accountId, jobId: existingJob.id, status: 200, code: 'EXISTING_JOB_RECOVERED', message: 'Existing LUXIFY job was recovered.' });
          return send(res, 200, { ok: true, recovered: true, existingJob, project: null, quote: null });
        }

        const project = await repository.getProject(session.accountId, payload.projectId);
        const eligibility = await requireLuxifyActivation(session.accountId, project.lookIdentityIds, {
          env: environment,
          runtimePreflight,
          authorizePremium,
          resolveEligibility,
        });
        const options = { ...quoteOptions, env: quoteOptions.env ?? environment };
        const quote = quoteIssuer(bindingFrom(project, payload.idempotencyKey, eligibility, session.accountId), options);
        return send(res, 201, { ok: true, quote, project });
      }
      throw routeError('invalid_request', 'Invalid LUXIFY action.');
    } catch (error) {
      const status = [400, 401, 402, 403, 404, 409, 410, 422, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      const publicError = status === 503 && !error?.statusCode ? 'LUXIFY request could not be completed.' : error.message;
      const code = error?.code || (error?.issues ? 'invalid_request' : 'luxify_unavailable');
      logOpsEvent({ level: status >= 500 ? 'error' : 'warn', event: 'luxify.request.rejected', accountId: session?.accountId, status, code, message: 'LUXIFY request was rejected.' });
      return send(res, status, {
        ok: false,
        code,
        error: publicError,
        ...(Array.isArray(error?.reasons) ? { reasons: error.reasons } : {}),
        ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
      });
    }
  };
}

export default createLuxifyHandler();
