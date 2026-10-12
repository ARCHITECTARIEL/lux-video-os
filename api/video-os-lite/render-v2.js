import crypto from 'node:crypto';
import { start } from 'workflow/api';
import { accountDto, jobDto } from '../../db/dto.js';
import { luxifyRepository } from '../../db/luxify-repository.js';
import { claimWorkflowStart, consumeRateLimit, requirePersistedRenderAuthorization, ensureAccount, getJob, getOwnedProject, getOwnedScriptedPhotoJobByIdempotency, getRenderAuthorizedIdentity, getRenderReservationProof, markJobFailedAndRelease, reserveRender, setWorkflowRun } from '../../db/repositories.js';
import { standardNarrationRepository } from '../../db/standard-narration-repository.js';
import { assertTalentSelectionsAvailable, loadTalentInventory } from '../video-os/talent.js';
import { captureJobError } from '../../lib/video-os-observability.js';
import { featureEnabled, requestId } from '../../lib/video-os-security.js';
import { DEFAULT_TRIAL_CREDITS, handleOptions, providerList, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { hyperframesMvpReadiness } from '../../services/hyperframes-contract.js';
import { resolvePremiumComposition } from '../../public/premium-composition-catalog.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { parseOrThrow, renderRequestSchema, scriptedPhotoRenderRequestSchema } from '../../lib/video-os-validation.js';
import { videoRenderWorkflowMetadata } from '../../workflows/video-render-metadata.js';
import { standardRenderWorkflowMetadata } from '../../workflows/standard-render-metadata.js';
import { sanitizeStandardNarrationReason, STANDARD_CONTRACT_VERSION, standardNarrationActivation } from '../../lib/standard-narration-contract.js';
import { hasScriptedPhotoContractMarker, isScriptedPhotoRequest, scriptedPhotoActivation, validateScriptedPhotoTransport } from '../../lib/scripted-photo-contract.js';
import {
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  canonicalizeLuxifyIntent,
  canonicalizeLuxifyRenderRequest,
  classifyLuxifyMarker,
  isLuxifyRequest,
  luxifyFormatForAspectRatio,
} from '../../lib/luxify-contract.js';
import { configuredLuxifyCredits, verifyLuxifyQuote } from '../../lib/luxify-quote.js';
import {
  defaultLuxifyRuntimePreflight,
  requireLuxifyActivation,
  unavailableLuxifyEligibilityResolver,
} from '../../routes/video-os-lite/luxify.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function renderProofBinding(proofId) {
  if (!uuidV4Pattern.test(String(proofId || ''))) {
    throw Object.assign(new Error('Render reservation proof is unavailable.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  return Object.freeze({ proofId });
}

export function serverRenderCorrelationId() {
  return 'corr-' + crypto.randomUUID();
}

export function assertPremiumCompositionRequest(payload, project, env = process.env) {
  const requestHasComposition = Object.hasOwn(payload.productionKit || {}, 'composition');
  const projectHasComposition = Object.hasOwn(project?.settings || {}, 'composition');
  if (requestHasComposition !== projectHasComposition) {
    throw Object.assign(new Error('The selected Premium landscape composition does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  }
  if (!requestHasComposition) return;
  if (!payload.productionKit.composition || !project?.settings?.composition || payload.format !== 'landscape') {
    throw Object.assign(new Error('The selected Premium landscape composition does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  }
  const requested = resolvePremiumComposition(payload.productionKit.composition).selection;
  const saved = resolvePremiumComposition(project.settings.composition).selection;
  if (requested.backgroundId !== saved.backgroundId || requested.layoutId !== saved.layoutId) {
    throw Object.assign(new Error('The selected composition changed after the project was saved.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  }
  const readiness = hyperframesMvpReadiness();
  if (readiness.ready !== true) {
    throw Object.assign(new Error('Premium landscape composition is not available in the initial MVP release.'), {
      statusCode: 503,
      code: readiness.code,
      failureCategory: readiness.failureCategory,
    });
  }
  if (!providerList(env).find(provider => provider.id === 'heygen')?.compositionAvailable) {
    throw Object.assign(new Error('Premium landscape composition is not available.'), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  }
}

// On Vercel, claimWorkflowStart() must be immediately followed by start()
// to hand the job to Vercel Workflow's durable orchestrator. On a VPS,
// there is no Vercel Workflow runtime to hand it to: without an explicit
// deployment target, the `workflow` package would silently fall back to
// @workflow/world-local (an in-memory, single-process queue documented as
// "for local development and testing" only), which would then race
// worker/render-worker.mjs's own poll loop driving the same job forward.
// worker/render-worker.mjs already watches for jobs sitting at
// 'workflow_started' (what claimWorkflowStart() just set), so on a VPS
// dispatch is a no-op here -- the poll loop picks it up on its own.
export function dispatchesViaVercelWorkflow() {
  return String(process.env.WORKFLOW_DISPATCH_MODE || 'vercel').trim().toLowerCase() === 'vercel';
}

// Render submissions directly gate real credit-spend and real provider
// cost -- tighter than uploads (see uploads.js's VIDEO_OS_UPLOAD_HOURLY_LIMIT
// for the same pattern at a looser limit). 20/hour is generous for genuine
// iterative use (rendering several variations in one session) while still
// bounding an unthrottled client's worst-case credit-reservation attempts
// to a small, recoverable number per hour. Exported (and rateLimit/limit
// injectable) so the 429 path is directly unit-testable without needing
// 20+ real requests against a live DB -- this file doesn't use the
// factory-injection pattern the rest of this codebase's routes do
// (routes/video-os-lite/copywriter.js, api/video-os-lite/uploads.js), so
// this is scoped narrowly rather than refactoring the whole handler.
export function renderHourlyLimit() {
  return Number(process.env.VIDEO_OS_RENDER_HOURLY_LIMIT || 20);
}

export async function assertRenderRateLimit(accountId, { rateLimit = consumeRateLimit, limit = renderHourlyLimit() } = {}) {
  const allowed = await rateLimit({ accountId, key: `render:hourly:${accountId}`, limit, windowMs: 60 * 60 * 1000 });
  if (!allowed) throw Object.assign(new Error('Render request limit reached. Try again in a while.'), { statusCode: 429, code: 'rate_limited' });
}

// Shared by the admin console's "retry this render" action
// (routes/video-os-lite/admin.js) so an admin-triggered retry respects the
// exact same Vercel-vs-VPS dispatch gate as a customer's own render
// request, without duplicating the inline claim+dispatch blocks in
// handleStandardRender/handlePremiumRender below (those have their own
// error-recovery bookkeeping specific to the HTTP request lifecycle that
// doesn't apply here -- an admin retry either reserves and claims
// successfully or it doesn't, there is no partial-request state to unwind).
export async function dispatchClaimedJob(jobId, provider) {
  if (!dispatchesViaVercelWorkflow()) return;
  const metadata = provider === 'sadtalker' ? standardRenderWorkflowMetadata : videoRenderWorkflowMetadata;
  const run = await start(metadata, [jobId]);
  await setWorkflowRun(jobId, run.runId);
}

export function authorizedIdentityInput(project, payload, identity) {
  const ready = [identity?.overallStatus, identity?.avatarStatus, identity?.voiceStatus].every((status) => String(status || '').toUpperCase() === 'READY');
  if (!ready || identity?.archivedAt || !identity?.providerRenderableAvatarId || !identity?.providerVoiceId) throw Object.assign(new Error('Video identity is not ready to render.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (project?.identityId !== payload.identityId) throw Object.assign(new Error('Render identity does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (payload.voice && project?.voice?.id !== payload.voice.voiceId) throw Object.assign(new Error('Render voice does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  return { ...payload, identityId: identity.id, avatar: { avatarId: identity.providerRenderableAvatarId }, voice: payload.voice || { voiceId: identity.providerVoiceId } };
}

function parseLuxifyRenderRequest(body) {
  try {
    return canonicalizeLuxifyRenderRequest(body);
  } catch (error) {
    throw Object.assign(new Error('LUXIFY render request validation failed.'), {
      statusCode: 400,
      code: 'invalid_request',
      failureCategory: 'VALIDATION',
      issues: error?.issues,
    });
  }
}

function assertLuxifyRenderTransport(req, env) {
  if (!env.VIDEO_OS_PUBLIC_ORIGIN || req.headers?.origin !== env.VIDEO_OS_PUBLIC_ORIGIN
    || !['same-origin', 'none', undefined].includes(req.headers?.['sec-fetch-site'])) {
    throw Object.assign(new Error('Origin not allowed.'), { statusCode: 403, code: 'origin_not_allowed', failureCategory: 'VALIDATION' });
  }
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('JSON required.'), { statusCode: 400, code: 'json_required', failureCategory: 'VALIDATION' });
  }
}

function canonicalLuxifyProjectIntent(project, idempotencyKey) {
  try {
    return canonicalizeLuxifyIntent({
      contractVersion: project?.contractVersion,
      projectId: project?.id,
      idempotencyKey,
      title: project?.title,
      prompt: project?.prompt,
      lookIdentityIds: project?.lookIdentityIds,
      aspectRatio: project?.aspectRatio,
      resolution: project?.resolution,
      durationSeconds: project?.durationSeconds,
    });
  } catch {
    throw Object.assign(new Error('Saved LUXIFY project binding is invalid.'), {
      statusCode: 409,
      code: 'LUXIFY_PROJECT_BINDING_CHANGED',
      failureCategory: 'RECONCILIATION',
    });
  }
}

function assertLuxifyProjectIntent(payload, project) {
  const saved = canonicalLuxifyProjectIntent(project, payload.idempotencyKey);
  const { quoteToken: _quoteToken, ...requestIntent } = payload;
  const requested = canonicalizeLuxifyIntent(requestIntent);
  if (JSON.stringify(saved) !== JSON.stringify(requested)) {
    throw Object.assign(new Error('LUXIFY request no longer matches the saved project.'), {
      statusCode: 409,
      code: 'LUXIFY_PROJECT_BINDING_CHANGED',
      failureCategory: 'RECONCILIATION',
    });
  }
  return saved;
}

function luxifyQuoteBinding(accountId, intent, eligibility) {
  return {
    accountId,
    projectId: intent.projectId,
    idempotencyKey: intent.idempotencyKey,
    title: intent.title,
    prompt: intent.prompt,
    lookBindings: eligibility.lookBindings,
    eligibilityRevision: eligibility.eligibilityRevision,
    aspectRatio: intent.aspectRatio,
    resolution: intent.resolution,
    durationSeconds: intent.durationSeconds,
  };
}

function testOnlyLuxifyReservationTrust(resolveLuxifyAuthority) {
  if (resolveLuxifyAuthority === undefined) return undefined;
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child') || typeof resolveLuxifyAuthority !== 'function') {
    throw Object.assign(new Error('LUXIFY reservation authority injection is test-only.'), {
      statusCode: 403,
      code: 'LUXIFY_TEST_AUTHORITY_DENIED',
      failureCategory: 'ENTITLEMENT',
    });
  }
  return { resolveLuxifyAuthority };
}

export async function handleLuxifyRender(req, res, session, body, diagnosticRequestId, {
  environment = process.env,
  projectRepository = luxifyRepository,
  runtimePreflight = defaultLuxifyRuntimePreflight,
  authorizePremium = requirePersistedRenderAuthorization,
  resolveEligibility = unavailableLuxifyEligibilityResolver,
  verifyQuote = verifyLuxifyQuote,
  quoteOptions = {},
  reserve = reserveRender,
  resolveLuxifyAuthority,
  ensureAccountRecord = ensureAccount,
  claimStart = claimWorkflowStart,
  getJobRecord = getJob,
  startWorkflow = start,
  setRun = setWorkflowRun,
  shouldDispatch = dispatchesViaVercelWorkflow,
} = {}) {
  res.setHeader('X-Request-Id', diagnosticRequestId);
  assertLuxifyRenderTransport(req, environment);
  const payload = parseLuxifyRenderRequest(body);
  const project = await projectRepository.getProject(session.accountId, payload.projectId);
  const intent = assertLuxifyProjectIntent(payload, project);
  const eligibility = await requireLuxifyActivation(session.accountId, intent.lookIdentityIds, {
    env: environment,
    runtimePreflight,
    authorizePremium,
    resolveEligibility,
  });
  const currentCost = configuredLuxifyCredits(intent.resolution, environment);
  const verifiedQuote = verifyQuote(
    payload.quoteToken,
    luxifyQuoteBinding(session.accountId, intent, eligibility),
    { ...quoteOptions, env: quoteOptions.env ?? environment },
  );
  if (verifiedQuote.luxCredits !== currentCost) {
    throw Object.assign(new Error('LUXIFY quote cost changed.'), {
      statusCode: 409,
      code: 'LUXIFY_COST_MISMATCH',
      failureCategory: 'RECONCILIATION',
    });
  }

  let reservedJob;
  let proofId;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const account = await ensureAccountRecord({
      accountId: session.accountId,
      email: session.email,
      name: session.email || 'Video OS Account',
      initialCredits: DEFAULT_TRIAL_CREDITS,
    });
    const reservation = {
      jobId: `job-${crypto.randomUUID()}`,
      accountId: session.accountId,
      idempotencyKey: intent.idempotencyKey,
      correlationId: serverRenderCorrelationId(),
      provider: 'heygen',
      tier: 'premium',
      title: intent.title,
      format: luxifyFormatForAspectRatio(intent.aspectRatio),
      costCredits: currentCost,
      input: {
        contractVersion: intent.contractVersion,
        renderMode: LUXIFY_RENDER_MODE,
        providerCapability: LUXIFY_PROVIDER_CAPABILITY,
        projectId: intent.projectId,
        idempotencyKey: intent.idempotencyKey,
        title: intent.title,
        prompt: intent.prompt,
        lookIdentityIds: [...intent.lookIdentityIds],
        aspectRatio: intent.aspectRatio,
        resolution: intent.resolution,
        durationSeconds: intent.durationSeconds,
      },
      quoteToken: payload.quoteToken,
    };
    const trusted = testOnlyLuxifyReservationTrust(resolveLuxifyAuthority);
    const reserved = trusted ? await reserve(reservation, trusted) : await reserve(reservation);
    ({ proofId } = renderProofBinding(reserved.proofId));
    reservedJob = reserved.job;
    const claimed = await claimStart(reserved.job.id);
    if (claimed) {
      reservedJob = claimed;
      workflowDispatchAttempted = true;
      if (shouldDispatch()) {
        const run = await startWorkflow(videoRenderWorkflowMetadata, [reserved.job.id]);
        workflowAccepted = true;
        const trackedJob = await setRun(reserved.job.id, run.runId);
        if (!trackedJob) throw Object.assign(new Error('Accepted workflow run could not be attached to its job.'), { statusCode: 202, failureCategory: 'RECONCILIATION' });
        reservedJob = trackedJob;
      } else {
        workflowAccepted = true;
      }
    } else {
      reservedJob = await getJobRecord(reserved.job.id);
    }
    return send(res, reserved.replayed && !claimed ? 200 : 202, {
      ok: true,
      ...accountDto(account),
      recovered: reserved.replayed,
      proofId,
      provider: { id: 'heygen', name: 'HeyGen', configured: true },
      job: jobDto(reservedJob),
      workflowRunId: reservedJob.workflowRunId,
      correlationId: reservedJob.correlationId,
      status: reservedJob.status,
      stage: reservedJob.status,
      message: reserved.replayed
        ? (claimed ? 'Existing reserved LUXIFY workflow resumed.' : 'Existing LUXIFY workflow recovered.')
        : 'LUXIFY workflow started.',
    });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) {
      await markJobFailedAndRelease(
        reservedJob.id,
        error.failureCategory || 'INTERNAL',
        'Workflow start failed.',
        undefined,
        { expectedStatuses: ['reserved'] },
      ).catch(() => {});
    }
    captureJobError(error, {
      jobId: reservedJob?.id,
      accountId: reservedJob?.accountId,
      correlationId: reservedJob?.correlationId,
      route: 'render',
    });
    if (workflowDispatchAttempted) {
      return send(res, 202, {
        ok: true,
        code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain',
        proofId,
        job: jobDto(reservedJob),
        correlationId: reservedJob?.correlationId,
        status: reservedJob?.status,
        stage: reservedJob?.status,
        message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.',
      });
    }
    throw error;
  }
}

function safeTrimmedString(value, max = 160) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return '';
  return normalized;
}

function normalizeAudioReference(value) {
  const rawAssetId = safeTrimmedString(typeof value === 'string' ? value : value?.assetId, 120);
  if (!uuidPattern.test(rawAssetId)) return null;
  return { assetId: rawAssetId };
}

function isNarrationRequest(body = {}) {
  return body.contractVersion !== undefined || body.quoteId !== undefined || body.narrationConsentId !== undefined;
}

// Standard narration requests are a strict, versioned shape distinct from the
// legacy Premium body: server-controlled fields (cost, provider, adapter,
// source proofs) must never be client-selectable.
function assertStandardSubmissionShape(body) {
  const allowed = new Set(['tier', 'contractVersion', 'quoteId', 'narrationConsentId', 'projectId', 'identityId', 'audioReference', 'idempotencyKey', 'title', 'format']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw Object.assign(new Error('Narration requests require unambiguous client references only.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  if (body.tier !== 'STANDARD' || body.contractVersion !== STANDARD_CONTRACT_VERSION) throw Object.assign(new Error('Standard narration requires an exact contract version.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  if (!uuidPattern.test(body.quoteId || '') || !uuidPattern.test(body.narrationConsentId || '') || !uuidPattern.test(body.projectId || '') || !uuidPattern.test(body.identityId || '') || !uuidPattern.test(body.idempotencyKey || '')) {
    throw Object.assign(new Error('Standard narration requires a valid quote, consent, project, identity and idempotency key.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  }
  if (!['vertical', 'landscape', 'square'].includes(body.format)) throw Object.assign(new Error('Standard render format must match its quote.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  if (!safeTrimmedString(body.title, 120)) throw Object.assign(new Error('Standard render requires a title.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  const audioReference = normalizeAudioReference(body.audioReference);
  if (!audioReference) throw Object.assign(new Error('Standard render requires an uploaded driven-audio reference.'), { statusCode: 400, failureCategory: 'VALIDATION' });
  return audioReference;
}

async function handleStandardRender(req, res, session, body, correlationId) {
  if (!process.env.VIDEO_OS_PUBLIC_ORIGIN || req.headers?.origin !== process.env.VIDEO_OS_PUBLIC_ORIGIN || !['same-origin', 'none', undefined].includes(req.headers?.['sec-fetch-site'])) {
    throw Object.assign(new Error('Origin not allowed.'), { statusCode: 403 });
  }
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('JSON required.'), { statusCode: 400 });
  }
  const audioReference = assertStandardSubmissionShape(body);
  const activation = standardNarrationActivation({ accountId: session.accountId });
  // This is a defensive re-check at final submission (the primary signal the
  // customer sees comes earlier, from the readiness GET, which already
  // propagates the specific reasonCode via db/standard-narration-repository.js's
  // consentStatus()). Propagate the same specific reasonCode here too, rather
  // than collapsing it to the generic UNAVAILABLE code -- this only matters
  // for the rare race where a flag flips mid-flow, but an on-call engineer
  // reading logs/responses for that race deserves to know which of the four
  // independent gates actually tripped, not just "something's off."
  if (!activation.ready) throw Object.assign(new Error('Standard narration is not activated.'), { statusCode: 503, code: activation.reasonCode || 'standard_narration_unavailable' });
  let reservedJob;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const account = await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: DEFAULT_TRIAL_CREDITS });
    const reserved = await standardNarrationRepository.reserveRender({
      jobId: `job-${crypto.randomUUID()}`,
      accountId: session.accountId,
      idempotencyKey: body.idempotencyKey,
      correlationId,
      title: body.title,
      format: body.format,
      input: {
        contractVersion: body.contractVersion,
        quoteId: body.quoteId,
        narrationConsentId: body.narrationConsentId,
        projectId: body.projectId,
        identityId: body.identityId,
        audioReference,
        initiatingUser: session.accountId,
      },
    });
    reservedJob = reserved.job;
    const claimed = await claimWorkflowStart(reserved.job.id);
    if (claimed) {
      reservedJob = claimed;
      workflowDispatchAttempted = true;
      if (dispatchesViaVercelWorkflow()) {
        const run = await start(standardRenderWorkflowMetadata, [reserved.job.id]);
        workflowAccepted = true;
        const trackedJob = await setWorkflowRun(reserved.job.id, run.runId);
        if (!trackedJob) throw Object.assign(new Error('Accepted workflow run could not be attached to its job.'), { statusCode: 202, failureCategory: 'RECONCILIATION' });
        reservedJob = trackedJob;
      } else {
        workflowAccepted = true;
      }
    } else {
      reservedJob = await getJob(reserved.job.id);
    }
    return send(res, reserved.replayed ? 200 : 202, {
      ok: true, ...accountDto(account), provider: { id: 'standard', name: 'Standard' }, job: jobDto(reservedJob),
      workflowRunId: reservedJob.workflowRunId, correlationId: reservedJob.correlationId, status: reservedJob.status, stage: reservedJob.status,
      message: reserved.replayed ? 'Existing render workflow recovered.' : 'Render workflow started.',
    });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.', undefined, { expectedStatuses: ['reserved'] }).catch(() => {});
    captureJobError(error, { jobId: reservedJob?.id, accountId: reservedJob?.accountId, correlationId: reservedJob?.correlationId, route: 'render' });
    if (workflowDispatchAttempted) {
      return send(res, 202, {
        ok: true, code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain', job: jobDto(reservedJob),
        correlationId: reservedJob?.correlationId, status: reservedJob?.status, stage: reservedJob?.status,
        message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.',
      });
    }
    throw error;
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to render.' });
  let narrationRequest = false;
  let scriptedPhotoRequest = false;
  let luxifyRequest = false;
  try {
    const session = sessionFromRequest(req);
    if (!featureEnabled('VIDEO_OS_DURABLE_WORKFLOW_ENABLED')) return send(res, 503, { ok: false, code: 'durable_workflow_disabled', error: 'Live rendering is contained pending workflow verification.' });
    await assertRenderRateLimit(session.accountId);
    const body = await readJson(req);
    luxifyRequest = classifyLuxifyMarker(body, { provider: 'heygen' }) !== null;
    if (luxifyRequest && !isLuxifyRequest(body)) {
      throw Object.assign(new Error('Unsupported LUXIFY contract version.'), {
        statusCode: 400,
        code: 'LUXIFY_CONTRACT_INVALID',
        failureCategory: 'VALIDATION',
      });
    }
    const diagnosticRequestId = requestId(req);
    if (isLuxifyRequest(body)) return await handleLuxifyRender(req, res, session, body, diagnosticRequestId);
    scriptedPhotoRequest = hasScriptedPhotoContractMarker(body);
    if (scriptedPhotoRequest && !isScriptedPhotoRequest(body)) {
      throw Object.assign(new Error('Unsupported scripted-photo contract version.'), { statusCode: 400, failureCategory: 'VALIDATION' });
    }
    if (isScriptedPhotoRequest(body)) return await handleScriptedPhotoRender(req, res, session, body, diagnosticRequestId);
    narrationRequest = isNarrationRequest(body);
    await requirePersistedRenderAuthorization(session.accountId, narrationRequest ? 'standard' : 'premium');
    if (narrationRequest) return await handleStandardRender(req, res, session, body, diagnosticRequestId);
    return await handlePremiumRender(req, res, session, body, diagnosticRequestId);
  } catch (error) {
    if (luxifyRequest) {
      return send(res, [400, 401, 402, 403, 404, 409, 410, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503, {
        ok: false,
        code: error.code || (error.issues ? 'invalid_request' : 'luxify_unavailable'),
        error: 'LUXIFY render request could not be completed.',
        issues: error.issues,
        ...(Array.isArray(error.reasons) ? { reasons: error.reasons } : {}),
      });
    }
    if (narrationRequest) {
      return send(res, [400, 401, 402, 403, 404, 409, 410, 422, 503].includes(error.statusCode) ? error.statusCode : 503, { ok: false, code: sanitizeStandardNarrationReason(error.code), error: 'Standard narration request could not be completed.' });
    }
    if (scriptedPhotoRequest) {
      return send(res, [400, 401, 402, 403, 404, 409, 410, 422, 503].includes(error.statusCode) ? error.statusCode : 400, {
        ok: false,
        code: error.code || (error.issues ? 'invalid_request' : 'scripted_photo_render_failed'),
        error: 'Scripted-photo render request could not be completed.',
        issues: error.issues,
      });
    }
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Render failed.', issues: error.issues });
  }
}

async function handleScriptedPhotoRender(req, res, session, body, diagnosticRequestId) {
  res.setHeader('X-Request-Id', diagnosticRequestId);
  validateScriptedPhotoTransport(req);
  const payload = parseOrThrow(scriptedPhotoRenderRequestSchema, body, 'Scripted-photo request validation failed.');
  const existingJob = await getOwnedScriptedPhotoJobByIdempotency({
    accountId: session.accountId,
    idempotencyKey: payload.idempotencyKey,
    projectId: payload.projectId,
    tier: payload.tier,
    identityId: payload.identityId,
    title: payload.title,
    script: payload.script,
    format: payload.format,
  });
  let reservedJob;
  let proofId;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    let account;
    let reserved;
    if (existingJob) {
      reserved = { job: existingJob, replayed: true, proofId: await getRenderReservationProof(existingJob) };
    } else {
      const activation = scriptedPhotoActivation(payload.tier);
      await requirePersistedRenderAuthorization(session.accountId, activation.tier);
      account = await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: DEFAULT_TRIAL_CREDITS });
      reserved = await reserveRender({
        jobId: `job-${crypto.randomUUID()}`,
        accountId: session.accountId,
        idempotencyKey: payload.idempotencyKey,
        correlationId: serverRenderCorrelationId(),
        provider: activation.provider,
        tier: activation.tier,
        title: payload.title,
        format: payload.format,
        costCredits: activation.costCredits,
        quoteToken: payload.quoteToken,
        input: {
          contractVersion: payload.contractVersion,
          tier: payload.tier,
          projectId: payload.projectId,
          identityId: payload.identityId,
          script: payload.script,
        },
      });
    }
    ({ proofId } = renderProofBinding(reserved.proofId));
    reservedJob = reserved.job;
    const claimed = await claimWorkflowStart(reserved.job.id);
    if (claimed) {
      reservedJob = claimed;
      workflowDispatchAttempted = true;
      if (dispatchesViaVercelWorkflow()) {
        const run = await start(videoRenderWorkflowMetadata, [reserved.job.id]);
        workflowAccepted = true;
        const trackedJob = await setWorkflowRun(reserved.job.id, run.runId);
        if (!trackedJob) throw Object.assign(new Error('Accepted workflow run could not be attached to its job.'), { statusCode: 202, failureCategory: 'RECONCILIATION' });
        reservedJob = trackedJob;
      } else {
        workflowAccepted = true;
      }
    } else {
      reservedJob = await getJob(reserved.job.id);
    }
    return send(res, reserved.replayed && !claimed ? 200 : 202, {
      ok: true,
      ...(account ? accountDto(account) : {}),
      recovered: reserved.replayed,
      proofId,
      provider: { id: 'heygen', name: 'HeyGen', configured: true },
      job: jobDto(reservedJob),
      workflowRunId: reservedJob.workflowRunId,
      correlationId: reservedJob.correlationId,
      status: reservedJob.status,
      stage: reservedJob.status,
      message: reserved.replayed
        ? (claimed ? 'Existing reserved render workflow resumed.' : 'Existing render workflow recovered.')
        : 'Render workflow started.',
    });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.', undefined, { expectedStatuses: ['reserved'] }).catch(() => {});
    captureJobError(error, { jobId: reservedJob?.id, accountId: reservedJob?.accountId, correlationId: reservedJob?.correlationId, route: 'render' });
    if (workflowDispatchAttempted) return send(res, 202, { ok: true, code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain', proofId, job: jobDto(reservedJob), correlationId: reservedJob?.correlationId, status: reservedJob?.status, stage: reservedJob?.status, message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.' });
    throw error;
  }
}

async function handlePremiumRender(req, res, session, body, diagnosticRequestId) {
  res.setHeader('X-Request-Id', diagnosticRequestId);
  let reservedJob;
  let proofId;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const payload = parseOrThrow(renderRequestSchema, body, 'Render request validation failed.');
    const project = await getOwnedProject(session.accountId, payload.projectId);
    if (!project) throw Object.assign(new Error('Project not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
    assertPremiumCompositionRequest(payload, project);
    let authorizedInput = payload;
    if (payload.identityId) {
      const identity = await getRenderAuthorizedIdentity(session.accountId, payload.identityId, IDENTITY_CONSENT_POLICY_VERSION);
      if (!identity) throw Object.assign(new Error('Video identity not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
      authorizedInput = authorizedIdentityInput(project, payload, identity);
    } else {
      if (project.avatar?.id !== payload.avatar?.avatarId || project.voice?.id !== payload.voice?.voiceId) {
        throw Object.assign(new Error('Render inputs do not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
      }
      const inventory = await loadTalentInventory();
      assertTalentSelectionsAvailable(inventory.talent, payload);
    }
    const account = await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: DEFAULT_TRIAL_CREDITS });
    const reserved = await reserveRender({ jobId: `job-${crypto.randomUUID()}`, accountId: session.accountId, idempotencyKey: payload.idempotencyKey, correlationId: serverRenderCorrelationId(), provider: payload.provider, title: payload.title, format: payload.format, costCredits: 90, input: authorizedInput });
    ({ proofId } = renderProofBinding(reserved.proofId));
    reservedJob = reserved.job;
    const claimed = await claimWorkflowStart(reserved.job.id);
    if (claimed) {
      reservedJob = claimed;
      workflowDispatchAttempted = true;
      if (dispatchesViaVercelWorkflow()) {
        const run = await start(videoRenderWorkflowMetadata, [reserved.job.id]);
        workflowAccepted = true;
        const trackedJob = await setWorkflowRun(reserved.job.id, run.runId);
        if (!trackedJob) throw Object.assign(new Error('Accepted workflow run could not be attached to its job.'), { statusCode: 202, failureCategory: 'RECONCILIATION' });
        reservedJob = trackedJob;
      } else {
        workflowAccepted = true;
      }
    } else {
      reservedJob = await getJob(reserved.job.id);
    }
    return send(res, reserved.replayed ? 200 : 202, { ok: true, ...accountDto(account), proofId, provider: { id: 'heygen', name: 'HeyGen', configured: true }, job: jobDto(reservedJob), workflowRunId: reservedJob.workflowRunId, correlationId: reservedJob.correlationId, status: reservedJob.status, stage: reservedJob.status, message: reserved.replayed ? 'Existing render workflow recovered.' : 'Render workflow started.' });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.', undefined, { expectedStatuses: ['reserved'] }).catch(() => {});
    captureJobError(error, { jobId: reservedJob?.id, accountId: reservedJob?.accountId, correlationId: reservedJob?.correlationId, route: 'render' });
    if (workflowDispatchAttempted) return send(res, 202, { ok: true, code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain', proofId, job: jobDto(reservedJob), correlationId: reservedJob?.correlationId, status: reservedJob?.status, stage: reservedJob?.status, message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.' });
    throw error;
  }
}

export function shouldReleaseWorkflowReservation({ job, workflowDispatchAttempted }) {
  return Boolean(job && !workflowDispatchAttempted && !job.workflowRunId);
}
