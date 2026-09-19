import crypto from 'node:crypto';
import { start } from 'workflow/api';
import { accountDto, jobDto } from '../../db/dto.js';
import { claimWorkflowStart, ensureAccount, getJob, getOwnedProject, getRenderAuthorizedIdentity, markJobFailedAndRelease, reserveRender, setWorkflowRun } from '../../db/repositories.js';
import { standardNarrationRepository } from '../../db/standard-narration-repository.js';
import { assertTalentSelectionsAvailable, loadTalentInventory } from '../video-os/talent.js';
import { captureJobError } from '../../lib/video-os-observability.js';
import { featureEnabled, requestId, requireRenderAccountAuthorization } from '../../lib/video-os-security.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { parseOrThrow, renderRequestSchema } from '../../lib/video-os-validation.js';
import { videoRenderWorkflowMetadata } from '../../workflows/video-render-metadata.js';
import { standardRenderWorkflowMetadata } from '../../workflows/standard-render-metadata.js';
import { sanitizeStandardNarrationReason, STANDARD_CONTRACT_VERSION, standardNarrationActivation } from '../../lib/standard-narration-contract.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
function dispatchesViaVercelWorkflow() {
  return String(process.env.WORKFLOW_DISPATCH_MODE || 'vercel').trim().toLowerCase() === 'vercel';
}

export function authorizedIdentityInput(project, payload, identity) {
  const ready = [identity?.overallStatus, identity?.avatarStatus, identity?.voiceStatus].every((status) => String(status || '').toUpperCase() === 'READY');
  if (!ready || identity?.archivedAt || !identity?.providerRenderableAvatarId || !identity?.providerVoiceId) throw Object.assign(new Error('Video identity is not ready to render.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (project?.identityId !== payload.identityId) throw Object.assign(new Error('Render identity does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (payload.voice && project?.voice?.id !== payload.voice.voiceId) throw Object.assign(new Error('Render voice does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  return { ...payload, identityId: identity.id, avatar: { avatarId: identity.providerRenderableAvatarId }, voice: payload.voice || { voiceId: identity.providerVoiceId } };
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
  if (!standardNarrationActivation({ accountId: session.accountId }).ready) throw Object.assign(new Error('Standard narration is not activated.'), { statusCode: 503, code: 'standard_narration_unavailable' });
  let reservedJob;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const account = await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: Number(process.env.VIDEO_OS_TRIAL_CREDITS || 0) });
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
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.').catch(() => {});
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
  try {
    const session = sessionFromRequest(req);
    if (!featureEnabled('VIDEO_OS_DURABLE_WORKFLOW_ENABLED')) return send(res, 503, { ok: false, code: 'durable_workflow_disabled', error: 'Live rendering is contained pending workflow verification.' });
    requireRenderAccountAuthorization(session.accountId);
    const body = await readJson(req);
    narrationRequest = isNarrationRequest(body);
    const correlationId = requestId(req);
    if (narrationRequest) return await handleStandardRender(req, res, session, body, correlationId);
    return await handlePremiumRender(req, res, session, body, correlationId);
  } catch (error) {
    if (narrationRequest) {
      return send(res, [400, 401, 402, 403, 404, 409, 410, 422, 503].includes(error.statusCode) ? error.statusCode : 503, { ok: false, code: sanitizeStandardNarrationReason(error.code), error: 'Standard narration request could not be completed.' });
    }
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Render failed.', issues: error.issues });
  }
}

async function handlePremiumRender(req, res, session, body, correlationId) {
  let reservedJob;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const payload = parseOrThrow(renderRequestSchema, body, 'Render request validation failed.');
    const project = await getOwnedProject(session.accountId, payload.projectId);
    if (!project) throw Object.assign(new Error('Project not found.'), { statusCode: 404, failureCategory: 'OWNERSHIP' });
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
    const account = await ensureAccount({ accountId: session.accountId, email: session.email, name: session.email || 'Video OS Account', initialCredits: Number(process.env.VIDEO_OS_TRIAL_CREDITS || 0) });
    const reserved = await reserveRender({ jobId: `job-${crypto.randomUUID()}`, accountId: session.accountId, idempotencyKey: payload.idempotencyKey, correlationId, provider: payload.provider, title: payload.title, format: payload.format, costCredits: 90, input: authorizedInput });
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
    return send(res, reserved.replayed ? 200 : 202, { ok: true, ...accountDto(account), provider: { id: 'heygen', name: 'HeyGen', configured: true }, job: jobDto(reservedJob), workflowRunId: reservedJob.workflowRunId, correlationId: reservedJob.correlationId, status: reservedJob.status, stage: reservedJob.status, message: reserved.replayed ? 'Existing render workflow recovered.' : 'Render workflow started.' });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.').catch(() => {});
    captureJobError(error, { jobId: reservedJob?.id, accountId: reservedJob?.accountId, correlationId: reservedJob?.correlationId, route: 'render' });
    if (workflowDispatchAttempted) return send(res, 202, { ok: true, code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain', job: jobDto(reservedJob), correlationId: reservedJob?.correlationId, status: reservedJob?.status, stage: reservedJob?.status, message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.' });
    throw error;
  }
}

export function shouldReleaseWorkflowReservation({ job, workflowDispatchAttempted }) {
  return Boolean(job && !workflowDispatchAttempted && !job.workflowRunId);
}
