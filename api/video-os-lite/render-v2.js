import crypto from 'node:crypto';
import { start } from 'workflow/api';
import { accountDto, jobDto } from '../../db/dto.js';
import { claimWorkflowStart, ensureAccount, getJob, getOwnedProject, getRenderAuthorizedIdentity, markJobFailedAndRelease, reserveRender, setWorkflowRun } from '../../db/repositories.js';
import { assertTalentSelectionsAvailable, loadTalentInventory } from '../video-os/talent.js';
import { captureJobError } from '../../lib/video-os-observability.js';
import { featureEnabled, requestId, requireRenderAccountAuthorization } from '../../lib/video-os-security.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { parseOrThrow, renderRequestSchema } from '../../lib/video-os-validation.js';
import { videoRenderWorkflowMetadata } from '../../workflows/video-render-metadata.js';

export function authorizedIdentityInput(project, payload, identity) {
  const ready = [identity?.overallStatus, identity?.avatarStatus, identity?.voiceStatus].every((status) => String(status || '').toUpperCase() === 'READY');
  if (!ready || identity?.archivedAt || !identity?.providerRenderableAvatarId || !identity?.providerVoiceId) throw Object.assign(new Error('Video identity is not ready to render.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (project?.identityId !== payload.identityId) throw Object.assign(new Error('Render identity does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  if (payload.voice && project?.voice?.id !== payload.voice.voiceId) throw Object.assign(new Error('Render voice does not match the saved project.'), { statusCode: 409, failureCategory: 'VALIDATION' });
  return { ...payload, identityId: identity.id, avatar: { avatarId: identity.providerRenderableAvatarId }, voice: payload.voice || { voiceId: identity.providerVoiceId } };
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST to render.' });
  let reservedJob;
  let workflowDispatchAttempted = false;
  let workflowAccepted = false;
  try {
    const session = sessionFromRequest(req);
    if (!featureEnabled('VIDEO_OS_DURABLE_WORKFLOW_ENABLED')) return send(res, 503, { ok: false, code: 'durable_workflow_disabled', error: 'Live rendering is contained pending workflow verification.' });
    requireRenderAccountAuthorization(session.accountId);
    const payload = parseOrThrow(renderRequestSchema, await readJson(req), 'Render request validation failed.');
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
    const correlationId = requestId(req);
    const reserved = await reserveRender({ jobId: `job-${crypto.randomUUID()}`, accountId: session.accountId, idempotencyKey: payload.idempotencyKey, correlationId, provider: payload.provider, title: payload.title, format: payload.format, costCredits: 90, input: authorizedInput });
    reservedJob = reserved.job;
    const claimed = await claimWorkflowStart(reserved.job.id);
    if (claimed) {
      reservedJob = claimed;
      workflowDispatchAttempted = true;
      const run = await start(videoRenderWorkflowMetadata, [reserved.job.id]);
      workflowAccepted = true;
      const trackedJob = await setWorkflowRun(reserved.job.id, run.runId);
      if (!trackedJob) throw Object.assign(new Error('Accepted workflow run could not be attached to its job.'), { statusCode: 202, failureCategory: 'RECONCILIATION' });
      reservedJob = trackedJob;
    } else {
      reservedJob = await getJob(reserved.job.id);
    }
    return send(res, reserved.replayed ? 200 : 202, { ok: true, ...accountDto(account), provider: { id: 'heygen', name: 'HeyGen', configured: true }, job: jobDto(reservedJob), workflowRunId: reservedJob.workflowRunId, correlationId: reservedJob.correlationId, status: reservedJob.status, stage: reservedJob.status, message: reserved.replayed ? 'Existing render workflow recovered.' : 'Render workflow started.' });
  } catch (error) {
    if (shouldReleaseWorkflowReservation({ job: reservedJob, workflowDispatchAttempted })) await markJobFailedAndRelease(reservedJob.id, error.failureCategory || 'INTERNAL', 'Workflow start failed.').catch(() => {});
    captureJobError(error, { jobId: reservedJob?.id, accountId: reservedJob?.accountId, correlationId: reservedJob?.correlationId, route: 'render' });
    if (workflowDispatchAttempted) return send(res, 202, { ok: true, code: workflowAccepted ? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain', job: jobDto(reservedJob), correlationId: reservedJob?.correlationId, status: reservedJob?.status, stage: reservedJob?.status, message: 'Workflow dispatch may have been accepted; reservation is preserved pending reconciliation.' });
    return send(res, error.statusCode || 400, { ok: false, error: error.message || 'Render failed.', issues: error.issues });
  }
}

export function shouldReleaseWorkflowReservation({ job, workflowDispatchAttempted }) {
  return Boolean(job && !workflowDispatchAttempted && !job.workflowRunId);
}
