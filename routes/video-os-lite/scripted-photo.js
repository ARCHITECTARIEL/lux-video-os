import { and, eq, isNull } from 'drizzle-orm';

import { database } from '../../db/client.js';
import { jobDto } from '../../db/dto.js';
import {
  consumeRateLimit,
  ensureAccount,
  getOwnedScriptedPhotoJobByIdempotency,
  getOwnedProject,
  getScriptedPhotoReservationContext,
  requirePersistedRenderAuthorization,
} from '../../db/repositories.js';
import { projects, userIdentities } from '../../db/schema.js';
import {
  DEFAULT_TRIAL_CREDITS,
  handleOptions,
  readJson,
  send,
  sessionFromRequest,
} from '../../lib/video-os-account.js';
import {
  SCRIPTED_PHOTO_CONTRACT_VERSION,
  SCRIPTED_PHOTO_FEATURE_FLAG,
  STANDARD_SCRIPTED_PHOTO_CREDITS_ENV,
  PREMIUM_SCRIPTED_PHOTO_CREDITS,
  scriptedPhotoActivation,
} from '../../lib/scripted-photo-contract.js';
import {
  SCRIPTED_PHOTO_PRICING_VERSION,
  SCRIPTED_PHOTO_QUOTE_TTL_MS,
  issueScriptedPhotoQuote,
} from '../../lib/scripted-photo-quote.js';
import {
  parseOrThrow,
  scriptedPhotoQuoteRequestSchema,
  scriptedPhotoSaveProjectRequestSchema,
} from '../../lib/video-os-validation.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routeError(code, message, statusCode = 400, failureCategory = 'VALIDATION') {
  return Object.assign(new Error(message), { code, statusCode, failureCategory });
}

function iso(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function publicProject(project) {
  const settings = project?.settings || {};
  return {
    id: project.id,
    identityId: project.identityId,
    title: project.title,
    script: project.script,
    tier: settings.tier,
    format: settings.format,
    contractVersion: settings.contractVersion,
    ...(iso(project.createdAt) ? { createdAt: iso(project.createdAt) } : {}),
    ...(iso(project.updatedAt) ? { updatedAt: iso(project.updatedAt) } : {}),
  };
}

export function scriptedPhotoCapabilities(env = process.env) {
  const enabled = String(env[SCRIPTED_PHOTO_FEATURE_FLAG] || '').trim().toLowerCase() === 'true';
  const rawStandardCredits = String(env[STANDARD_SCRIPTED_PHOTO_CREDITS_ENV] || '').trim();
  const standardCredits = Number(rawStandardCredits);
  const standardPriceConfigured = Boolean(rawStandardCredits && Number.isSafeInteger(standardCredits) && standardCredits > 0);
  return {
    enabled,
    tiers: {
      STANDARD: {
        available: enabled && standardPriceConfigured,
        credits: standardPriceConfigured ? standardCredits : null,
        reasons: [...(!enabled ? ['feature_disabled'] : []), ...(!standardPriceConfigured ? ['standard_price_unconfigured'] : [])],
      },
      PREMIUM: {
        available: enabled,
        credits: PREMIUM_SCRIPTED_PHOTO_CREDITS,
        reasons: enabled ? [] : ['feature_disabled'],
      },
    },
  };
}

function assertTransport(req, env, { json = false } = {}) {
  const headers = req.headers || {};
  const originAccepted = json
    ? headers.origin === env.VIDEO_OS_PUBLIC_ORIGIN
    : headers.origin === undefined || headers.origin === env.VIDEO_OS_PUBLIC_ORIGIN;
  if (!env.VIDEO_OS_PUBLIC_ORIGIN
    || !originAccepted
    || !['same-origin', 'none', undefined].includes(headers['sec-fetch-site'])) {
    throw routeError('origin_not_allowed', 'Origin not allowed.', 403);
  }
  if (json && String(headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw routeError('json_required', 'JSON required.', 400);
  }
}

function hourlyLimit(env) {
  const value = Number(env.VIDEO_OS_SCRIPTED_PHOTO_HOURLY_LIMIT || 60);
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000 ? value : 60;
}

async function persistScriptedProject(input) {
  return database().transaction(async tx => {
    const identity = (await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
      eq(userIdentities.accountId, input.accountId),
      eq(userIdentities.id, input.identityId),
      isNull(userIdentities.archivedAt),
    )).limit(1))[0];
    if (!identity) throw routeError('identity_not_found', 'Video identity not found.', 404, 'OWNERSHIP');

    const existing = (await tx.select().from(projects).where(eq(projects.id, input.id)).limit(1))[0];
    if (existing && existing.accountId !== input.accountId) throw routeError('project_not_found', 'Project not found.', 404, 'OWNERSHIP');
    const values = {
      accountId: input.accountId,
      identityId: input.identityId,
      title: input.title,
      script: input.script,
      avatar: {},
      voice: {},
      settings: { ...input.settings },
      updatedAt: new Date(),
    };
    if (existing) {
      const [updated] = await tx.update(projects).set(values).where(and(eq(projects.id, input.id), eq(projects.accountId, input.accountId))).returning();
      if (!updated) throw routeError('project_not_found', 'Project not found.', 404, 'OWNERSHIP');
      return updated;
    }
    return (await tx.insert(projects).values({ id: input.id, ...values }).returning())[0];
  });
}

export async function recoverOwnedJob({ accountId, idempotencyKey, contractVersion, projectId, tier, format }, {
  lookup = getOwnedScriptedPhotoJobByIdempotency,
  serialize = jobDto,
} = {}) {
  const job = await lookup({ accountId, idempotencyKey, projectId, tier, ...(format === undefined ? {} : { format }) });
  if (!job) return null;
  if (job.input?.contractVersion !== contractVersion) {
    throw routeError('recovery_binding_mismatch', 'Existing request does not match this scripted-photo project and tier.', 409, 'RECONCILIATION');
  }
  return serialize(job);
}

function getQuery(req) {
  const url = new URL(req.url, 'https://video-os.invalid');
  const keys = [...url.searchParams.keys()];
  const allowed = new Set(['contractVersion', 'projectId', 'tier', 'idempotencyKey']);
  if (keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length) {
    throw routeError('invalid_request', 'Invalid scripted-photo recovery request.');
  }
  if (!keys.length) return null;
  const recovery = Object.fromEntries([...allowed].map(key => [key, url.searchParams.get(key)]));
  if (recovery.contractVersion !== SCRIPTED_PHOTO_CONTRACT_VERSION
    || !UUID.test(recovery.projectId || '') || !['STANDARD', 'PREMIUM'].includes(recovery.tier)
    || !UUID.test(recovery.idempotencyKey || '') || keys.length !== allowed.size) {
    throw routeError('invalid_request', 'Invalid scripted-photo recovery request.');
  }
  return recovery;
}

function assertSavedProject(project, { accountId, projectId, tier, format }) {
  if (!project || project.accountId !== accountId || project.id !== projectId) {
    throw routeError('project_not_found', 'Project not found.', 404, 'OWNERSHIP');
  }
  if (project.settings?.contractVersion !== SCRIPTED_PHOTO_CONTRACT_VERSION
    || project.settings?.tier !== tier || project.settings?.format !== format) {
    throw routeError('project_binding_changed', 'Saved project no longer matches the requested quote.', 409, 'RECONCILIATION');
  }
}

function safeLog(error) {
  console.error(JSON.stringify({
    event: 'video_os_scripted_photo_failure',
    code: error?.code || null,
    failureCategory: error?.failureCategory || null,
  }));
}

async function requestBody(req) {
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? await readJson(req));
  } catch {
    throw routeError('invalid_request', 'Invalid JSON request.');
  }
}

export function createScriptedPhotoHandler({
  authenticate = sessionFromRequest,
  environment = process.env,
  rateLimit = consumeRateLimit,
  ensureAccountRecord = ensureAccount,
  saveProjectRecord = persistScriptedProject,
  getProject = getOwnedProject,
  getReservationContext = getScriptedPhotoReservationContext,
  authorizeTier = requirePersistedRenderAuthorization,
  recoverExistingJob = recoverOwnedJob,
  quoteOptions = {},
} = {}) {
  return async function scriptedPhotoHandler(req, res) {
    if (handleOptions(req, res)) return;
    try {
      let session;
      try { session = authenticate(req); } catch {
        return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
      }
      if (!session?.accountId) return send(res, 401, { ok: false, code: 'sign_in_required', error: 'Sign in to continue.' });
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST.' });
      assertTransport(req, environment, { json: req.method === 'POST' });
      const allowed = await rateLimit({
        accountId: session.accountId,
        key: `scripted-photo:hourly:${session.accountId}`,
        limit: hourlyLimit(environment),
        windowMs: 60 * 60 * 1000,
      });
      if (!allowed) throw routeError('rate_limited', 'Scripted-photo request limit reached.', 429);

      if (req.method === 'GET') {
        const recovery = getQuery(req);
        const existingJob = recovery ? await recoverExistingJob({ accountId: session.accountId, ...recovery }) : null;
        return send(res, 200, {
          ok: true,
          contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
          pricingVersion: SCRIPTED_PHOTO_PRICING_VERSION,
          quoteTtlSeconds: SCRIPTED_PHOTO_QUOTE_TTL_MS / 1000,
          capabilities: scriptedPhotoCapabilities(environment),
          existingJob,
        });
      }

      const body = await requestBody(req);
      if (body?.action === 'save-project') {
        const payload = parseOrThrow(scriptedPhotoSaveProjectRequestSchema, body, 'Scripted-photo project validation failed.');
        scriptedPhotoActivation(payload.tier, environment);
        await ensureAccountRecord({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: DEFAULT_TRIAL_CREDITS });
        const project = await saveProjectRecord({
          id: payload.projectId,
          accountId: session.accountId,
          identityId: payload.identityId,
          title: payload.title,
          script: payload.script,
          avatar: {},
          voice: {},
          settings: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: payload.tier, format: payload.format },
        });
        return send(res, 200, { ok: true, project: publicProject(project) });
      }
      if (body?.action === 'quote') {
        const payload = parseOrThrow(scriptedPhotoQuoteRequestSchema, body, 'Scripted-photo quote validation failed.');
        const recovery = {
          accountId: session.accountId,
          contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
          projectId: payload.projectId,
          tier: payload.tier,
          format: payload.format,
          idempotencyKey: payload.idempotencyKey,
        };
        const existingJob = await recoverExistingJob(recovery);
        if (existingJob) {
          return send(res, 200, { ok: true, recovered: true, quote: null, project: null, existingJob });
        }
        const project = await getProject(session.accountId, payload.projectId);
        assertSavedProject(project, { accountId: session.accountId, projectId: payload.projectId, tier: payload.tier, format: payload.format });
        const activation = scriptedPhotoActivation(payload.tier, environment);
        await authorizeTier(session.accountId, activation.tier);
        const context = await getReservationContext({
          accountId: session.accountId,
          projectId: project.id,
          identityId: project.identityId,
          title: project.title,
          script: project.script,
          tier: payload.tier,
        });
        assertSavedProject(context.project, { accountId: session.accountId, projectId: payload.projectId, tier: payload.tier, format: payload.format });
        const quote = issueScriptedPhotoQuote({
          accountId: session.accountId,
          projectId: project.id,
          identityId: project.identityId,
          idempotencyKey: payload.idempotencyKey,
          title: project.title,
          script: project.script,
          format: payload.format,
          tier: payload.tier,
          sourceBinding: context.input?.sourceBinding,
          credits: activation.costCredits,
        }, quoteOptions);
        return send(res, 201, { ok: true, quote, project: publicProject(project) });
      }
      throw routeError('invalid_request', 'Invalid scripted-photo action.');
    } catch (error) {
      safeLog(error);
      const status = [400, 401, 402, 403, 404, 409, 410, 422, 429, 503].includes(error?.statusCode) ? error.statusCode : 503;
      const publicError = status === 503 && !error?.statusCode ? 'Scripted-photo request could not be completed.' : error.message;
      const code = error?.code || (error?.issues ? 'invalid_request' : 'scripted_photo_unavailable');
      return send(res, status, { ok: false, code, error: publicError, issues: error?.issues });
    }
  };
}

export default createScriptedPhotoHandler();
