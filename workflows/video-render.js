import { FatalError, sleep } from 'workflow';
import { createHash } from 'node:crypto';
import { finalizeReadyJob, getJob, prepareProviderVideoFinish, prepareProviderVideoRead, prepareIdentityProviderRead, requireJobRenderAuthorization, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { featureEnabled } from '../lib/video-os-security.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { notifyRenderReady } from '../lib/video-os-render-notify.js';
import { assertHeygenConfigured, getHeygenPhotoAvatarStatus, pollHeygen, pollHeygenLuxify, submitHeygen, submitHeygenLuxify } from '../services/heygen.js';
import {
  assertFreshHeygenSpaceBinding,
  resolveFreshHeygenSpaceBinding,
} from '../db/heygen-space-binding-repository.js';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';
import { finishMedia } from '../services/media-finisher.js';
import { finishMediaWithHyperframes } from '../services/hyperframes-client.js';
import { assertHyperframesMvpReady } from '../services/hyperframes-contract.js';
import { finishMediaWithRemotion } from '../services/remotion-finisher.js';
import {
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  classifyLuxifyMarker,
  luxifyFormatForAspectRatio,
} from '../lib/luxify-contract.js';
import { assertScriptedPhotoHeygenInput, assertScriptedPhotoJobActivation, durableHeygenPreclaimMessage, durableProviderSubmissionPossibleMessage, parseDurableRenderFailure, renderTierForJob } from '../lib/scripted-photo-contract.js';

export function finishingEngine(env = process.env) {
  const requested = String(env.VIDEO_OS_COMPOSITION_ENGINE || 'ffmpeg').trim().toLowerCase();
  if (requested === 'ffmpeg' || requested === '') return 'ffmpeg';
  if (requested === 'remotion') return 'remotion';
  if (requested !== 'hyperframes') throw Object.assign(new Error(`Unsupported composition engine: ${requested}`), { failureCategory: 'CONFIG_MISSING' });
  if (String(env.VIDEO_OS_HYPERFRAMES_ENABLED || '').toLowerCase() !== 'true') throw Object.assign(new Error('HyperFrames was requested but disabled.'), { failureCategory: 'CONFIG_MISSING' });
  return 'hyperframes';
}

export function finishingEngineForJob(job, env = process.env) {
  const configured = finishingEngine(env);
  const selected = job?.input?.productionKit?.composition;
  if (!selected) return configured === 'hyperframes' ? 'ffmpeg' : configured;
  if (job?.provider !== 'heygen' || job?.format !== 'landscape' || renderTierForJob(job) !== 'premium') {
    throw Object.assign(new Error('The selected composition requires a Premium landscape job.'), { failureCategory: 'CONFIG_MISSING' });
  }
  if (configured !== 'hyperframes') {
    throw Object.assign(new Error('The selected HyperFrames composition is not enabled.'), { failureCategory: 'CONFIG_MISSING' });
  }
  if (!String(env.VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID || '').trim()) {
    throw Object.assign(new Error('HyperFrames Sandbox snapshot is not configured.'), { failureCategory: 'CONFIG_MISSING' });
  }
  return 'hyperframes';
}

export function requireReadyFinishingEngineForJob(job, env = process.env) {
  const engine = finishingEngineForJob(job, env);
  if (engine === 'hyperframes') assertHyperframesMvpReady();
  return engine;
}

function heygenPreclaimFailure(error) {
  return new FatalError(durableHeygenPreclaimMessage(classifyFailure(error, 'RECONCILIATION')));
}

function providerSubmissionPossibleFailure() {
  return new FatalError(durableProviderSubmissionPossibleMessage());
}

export function providerWorkflowMode(job) {
  const marker = classifyLuxifyMarker(job?.input, { provider: job?.provider });
  if (marker === 'unavailable') {
    throw Object.assign(new Error('Persisted LUXIFY workflow mode is invalid.'), {
      statusCode: 409,
      failureCategory: 'RECONCILIATION',
      code: 'LUXIFY_JOB_BINDING_INVALID',
    });
  }
  if (marker === 'luxify') return 'luxify';
  if (job?.provider === 'heygen' && (job?.input?.renderMode == null || job.input.renderMode === 'premium_presenter_v1')) return 'presenter';
  throw Object.assign(new Error('Persisted provider workflow mode is invalid.'), {
    statusCode: 409,
    failureCategory: 'RECONCILIATION',
    code: 'PROVIDER_WORKFLOW_MODE_INVALID',
  });
}

const LUXIFY_WORKFLOW_INPUT_KEYS = new Set([
  'contractVersion', 'renderMode', 'providerCapability', 'projectId', 'idempotencyKey',
  'title', 'prompt', 'lookIdentityIds', 'aspectRatio', 'resolution', 'durationSeconds',
  'lookBindings', 'eligibleLookIds', 'eligibilityRevision', 'quoteProof', 'renderAuthorization',
]);
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;

export function luxifyProviderSubmission(job) {
  const input = job?.input;
  if (providerWorkflowMode(job) !== 'luxify'
    || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== LUXIFY_WORKFLOW_INPUT_KEYS.size
    || Object.keys(input).some(key => !LUXIFY_WORKFLOW_INPUT_KEYS.has(key))
    || input.renderMode !== LUXIFY_RENDER_MODE
    || input.providerCapability !== LUXIFY_PROVIDER_CAPABILITY
    || job.projectId !== input.projectId
    || job.idempotencyKey !== input.idempotencyKey
    || job.title !== input.title
    || job.format !== luxifyFormatForAspectRatio(input.aspectRatio)
    || typeof input.prompt !== 'string' || input.prompt !== input.prompt.trim() || !input.prompt
    || !Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 4 || input.durationSeconds > 15
    || !['720p', '1080p'].includes(input.resolution)
    || !Array.isArray(input.lookBindings)
    || !Array.isArray(input.eligibleLookIds)
    || input.lookBindings.length < 1 || input.lookBindings.length > 3
    || input.lookBindings.length !== input.eligibleLookIds.length
    || input.lookBindings.some((binding, index) => binding?.providerLookId !== input.eligibleLookIds[index]
      || !PROVIDER_ID.test(String(binding?.providerLookId || '')))
    || new Set(input.eligibleLookIds).size !== input.eligibleLookIds.length) {
    throw Object.assign(new Error('Persisted LUXIFY provider submission binding is invalid.'), {
      statusCode: 409,
      failureCategory: 'RECONCILIATION',
      code: 'LUXIFY_JOB_BINDING_INVALID',
    });
  }
  return Object.freeze({
    idempotencyKey: job.id,
    prompt: input.prompt,
    eligibleLookIds: Object.freeze([...input.eligibleLookIds]),
    duration: input.durationSeconds,
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    title: input.title,
  });
}

function assertRenderProviderClaim(claimedJob, providerBinding, { jobId, accountId }) {
  const mode = providerWorkflowMode(claimedJob);
  const proof = claimedJob?.providerClaimProof;
  if (!claimedJob || !Object.isFrozen(claimedJob) || !proof || !Object.isFrozen(proof)
    || claimedJob.id !== jobId || claimedJob.accountId !== accountId || claimedJob.accountId !== providerBinding?.applicationAccountId
    || claimedJob.provider !== 'heygen' || claimedJob.status !== 'provider_submitting'
    || (mode === 'presenter' && !claimedJob.input?.identityId)
    || proof.version !== 'heygen-render-provider-claim/v1' || proof.operationState !== 'pending'
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(proof.operationId || ''))
    || !/^[a-f0-9]{64}$/.test(String(proof.requestDigest || ''))
    || proof.bindingId !== providerBinding.bindingId || proof.originScopeKey !== providerBinding.originScopeKey
    || proof.accountId !== claimedJob.accountId || proof.jobId !== claimedJob.id) {
    throw Object.assign(new Error('Provider submission claim is invalid.'), {
      statusCode: 409,
      failureCategory: 'PROVIDER_SUBMIT_UNKNOWN',
      providerSubmissionPossible: true,
    });
  }
  return claimedJob;
}

export function assertProviderAvatarConsentClaim(job, readClaim, provider) {
  if (!job?.accountId || !job.input?.identityId || !job.input?.avatar?.avatarId
    || readClaim?.accountId !== job.accountId || readClaim?.identityId !== job.input.identityId
    || !readClaim?.providerAvatarGroupId || readClaim?.providerRenderableAvatarId !== job.input.avatar.avatarId
    || provider?.ready !== true || provider.avatarGroup?.providerGroupId !== readClaim.providerAvatarGroupId
    || provider.avatarLook?.providerLookId !== readClaim.providerRenderableAvatarId) {
    throw Object.assign(new Error('Provider avatar subject consent is not verified.'), { statusCode: 409, failureCategory: 'CONSENT' });
  }
  return true;
}

export function assertProviderVideoReadClaim(readClaim, providerBinding, { jobId, providerJobId = null }) {
  const mode = providerWorkflowMode(readClaim?.job);
  const readyState = ['provider_ready', 'finishing'].includes(readClaim?.job?.status);
  if (!readClaim || !Object.isFrozen(readClaim) || readClaim.version !== 'heygen-video-read-claim/v1'
    || !readClaim.job || !Object.isFrozen(readClaim.job)
    || readClaim.job.id !== jobId || readClaim.job.accountId !== providerBinding?.applicationAccountId
    || readClaim.job.provider !== 'heygen' || readClaim.job.providerJobId !== readClaim.providerJobId
    || !['provider_submitted', 'provider_rendering', 'provider_ready', 'finishing'].includes(readClaim.job.status)
    || (providerJobId && providerJobId !== readClaim.providerJobId)
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(readClaim.providerJobId || ''))
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(readClaim.operationId || ''))
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(String(readClaim.resourceId || ''))
    || (readyState ? !/^[a-f0-9]{64}$/.test(String(readClaim.sourceUrlDigest || '')) : readClaim.sourceUrlDigest !== null)) {
    throw Object.assign(new Error('Provider video read claim is invalid.'), {
      statusCode: 409,
      failureCategory: 'PROVIDER_OPERATION_CONFLICT',
    });
  }
  return readClaim;
}

// Exported (not just used internally by videoRenderWorkflow below) so a
// non-Vercel worker daemon (worker/render-worker.mjs, for VPS hosting) can
// call these steps directly in its own poll loop instead of going through
// Vercel Workflow's orchestration runtime. 'use step' has no effect outside
// that runtime's build transform -- it's inert here, same as a stray string
// literal -- so these remain safe to call as plain functions.
export async function submitProvider(jobId) {
  'use step';
  let job;
  try { job = await getJob(jobId); } catch (error) { throw heygenPreclaimFailure(error); }
  if (!job) throw new FatalError('Video job not found.');
  if (job.providerJobId) return { providerJobId: job.providerJobId };
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw providerSubmissionPossibleFailure();
  let tier;
  let mode;
  try {
    mode = providerWorkflowMode(job);
    if (mode === 'luxify' && !featureEnabled('VIDEO_OS_HOSTED_FINISHING_ENABLED')) {
      throw Object.assign(new Error('LUXIFY hosted finishing is disabled.'), {
        statusCode: 503,
        failureCategory: 'CONFIG_MISSING',
        code: 'LUXIFY_HOSTED_FINISHING_DISABLED',
      });
    }
    tier = mode === 'luxify' ? 'premium' : renderTierForJob(job);
    if (mode === 'presenter') {
      assertScriptedPhotoJobActivation(job);
      assertScriptedPhotoHeygenInput(job);
      requireReadyFinishingEngineForJob(job);
    }
    assertHeygenConfigured();
    await requireJobRenderAuthorization(job, tier);
    if (providerCreationActivationStatus(process.env, job.accountId).enabled !== true) {
      throw Object.assign(new Error('HeyGen provider creation is not activated.'), {
        statusCode: 503,
        failureCategory: 'CONFIG_MISSING',
        code: 'PROVIDER_CREATION_DISABLED',
      });
    }
    if (mode === 'presenter' && !job.input?.identityId) {
      throw Object.assign(new Error('Provider resources are not registered to an owned identity.'), {
        statusCode: 409,
        failureCategory: 'RECONCILIATION',
        code: 'LEGACY_PROVIDER_RESOURCE_UNREGISTERED',
      });
    }
  } catch (error) {
    throw heygenPreclaimFailure(error);
  }
  let submissionClaimed = false;
  let providerBinding;
  let claimedJob;
  try {
    providerBinding = await resolveFreshHeygenSpaceBinding({ accountId: job.accountId });
    if (!['luxify'].includes(mode)) {
      const avatarRead = await prepareIdentityProviderRead({ accountId: job.accountId, identityId: job.input.identityId, component: 'avatar', providerBinding });
      const avatarStatus = await getHeygenPhotoAvatarStatus({ groupId: avatarRead.providerAvatarGroupId, lookId: avatarRead.providerRenderableAvatarId });
      assertProviderAvatarConsentClaim(job, avatarRead, avatarStatus);
    }
    const transitionedJob = await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding });
    submissionClaimed = true;
    claimedJob = assertRenderProviderClaim(transitionedJob, providerBinding, { jobId, accountId: job.accountId });
    assertFreshHeygenSpaceBinding(providerBinding);
    const claimedMode = providerWorkflowMode(claimedJob);
    if (claimedMode !== mode) throw Object.assign(new Error('Persisted provider workflow mode changed after claim.'), { failureCategory: 'RECONCILIATION' });
    const submitted = claimedMode === 'luxify'
      ? await submitHeygenLuxify(luxifyProviderSubmission(claimedJob))
      : await submitHeygen(claimedJob);
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: submitted.providerJobId, providerBinding });
    return submitted;
  } catch (error) {
    if (!submissionClaimed && error?.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN') {
      throw providerSubmissionPossibleFailure();
    }
    if (!submissionClaimed) throw heygenPreclaimFailure(error);
    const uncertainty = providerSubmissionPossibleFailure();
    try { captureJobError(error, { jobId, accountId: (claimedJob || job).accountId, correlationId: (claimedJob || job).correlationId, stage: 'provider_submit', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') }); } catch {}
    try {
      await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerBinding });
    } catch (persistenceError) {
      try { captureJobError(persistenceError, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'provider_submit_unknown_persistence', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' }); } catch {}
    }
    throw uncertainty;
  }
}

export async function pollProvider(jobId, providerJobId) {
  'use step';
  try {
    const advisoryJob = await getJob(jobId);
    if (!advisoryJob) throw new FatalError('Video job not found.');
    const providerBinding = await resolveFreshHeygenSpaceBinding({ accountId: advisoryJob.accountId });
    const readClaim = assertProviderVideoReadClaim(
      await prepareProviderVideoRead({ jobId, providerJobId, providerBinding }),
      providerBinding,
      { jobId, providerJobId },
    );
    assertFreshHeygenSpaceBinding(providerBinding);
    const status = providerWorkflowMode(readClaim.job) === 'luxify'
      ? await pollHeygenLuxify(readClaim.providerJobId)
      : await pollHeygen(readClaim.providerJobId);
    if (['provider_ready', 'finishing'].includes(readClaim.job.status) && !status.ready) {
      throw Object.assign(new FatalError('Provider state regressed after media became ready.'), { failureCategory: 'RECONCILIATION' });
    }
    if (!status.ready) {
      await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled', providerBinding, details: { providerStatus: status.status } });
    } else {
      if (typeof status.sourceUrl !== 'string' || status.sourceUrl.length === 0) {
        throw Object.assign(new FatalError('Provider ready response did not include media.'), { failureCategory: 'PROVIDER_RESPONSE' });
      }
      const providerSourceUrlDigest = createHash('sha256').update(status.sourceUrl, 'utf8').digest('hex');
      await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready', providerJobId: readClaim.providerJobId, providerBinding, providerSourceUrlDigest });
    }
    return status;
  } catch (error) {
    if (error?.failureCategory === 'PROVIDER_REJECTED') throw error;
    throw providerSubmissionPossibleFailure();
  }
}

export async function finishProviderMedia(jobId, sourceUrl) {
  'use step';
  let providerBinding;
  let readClaim;
  try {
    const advisoryJob = await getJob(jobId);
    if (!advisoryJob) throw new FatalError('Video job not found.');
    if (advisoryJob.status === 'ready') return advisoryJob.output;
    providerBinding = await resolveFreshHeygenSpaceBinding({ accountId: advisoryJob.accountId });
    readClaim = assertProviderVideoReadClaim(
      await prepareProviderVideoFinish({ jobId, providerBinding }),
      providerBinding,
      { jobId, providerJobId: advisoryJob.providerJobId },
    );
    if (typeof sourceUrl !== 'string' || createHash('sha256').update(sourceUrl, 'utf8').digest('hex') !== readClaim.sourceUrlDigest) {
      throw new FatalError('Provider media URL does not match ready evidence.');
    }
    if (!featureEnabled('VIDEO_OS_HOSTED_FINISHING_ENABLED')) {
      await transitionJob({ jobId, stageTo: 'finish_contained', eventType: 'finish.contained', providerBinding, details: { reason: 'hosted_finishing_disabled' } });
      return { contained: true };
    }
    if (readClaim.job.status === 'provider_ready') await transitionJob({ jobId, stageTo: 'finishing', eventType: 'finish.started', providerBinding });
    else if (readClaim.job.status !== 'finishing') throw new FatalError(`Finishing cannot resume from ${readClaim.job.status}.`);
    assertFreshHeygenSpaceBinding(providerBinding);
  } catch {
    throw providerSubmissionPossibleFailure();
  }
  const mode = providerWorkflowMode(readClaim.job);
  let artifact;
  if (mode === 'luxify') {
    const { finishLuxifyMedia } = await import('../services/luxify-finisher.js');
    artifact = await finishLuxifyMedia(readClaim.job, sourceUrl);
  } else {
    const engine = requireReadyFinishingEngineForJob(readClaim.job);
    artifact = engine === 'hyperframes'
      ? await finishMediaWithHyperframes(readClaim.job, sourceUrl)
      : engine === 'remotion'
      ? await finishMediaWithRemotion(readClaim.job, sourceUrl)
      : await finishMedia(readClaim.job, sourceUrl);
  }
  const finalized = await finalizeReadyJob(jobId, artifact, { providerBinding });
  await notifyRenderReady(readClaim.job, finalized);
  return artifact;
}

export async function failWorkflow(jobId, error) {
  'use step';
  const durable = parseDurableRenderFailure(error);
  const category = durable?.failureCategory || classifyFailure(error, 'INTERNAL');
  if (durable?.kind === 'provider-submission-possible' || category === 'PROVIDER_SUBMIT_UNKNOWN' || error?.providerSubmissionPossible === true) return;
  const preclaim = durable?.kind === 'heygen-preclaim' || error?.scriptedPhotoPreclaim === true;
  const options = { protectedStatuses: ['provider_submitting', 'provider_submit_unknown'], ...(preclaim ? { expectedStatuses: ['workflow_started'] } : {}) };
  const message = preclaim ? 'Provider claim failed before submission.' : String(error?.message || 'Workflow failed.').slice(0, 300);
  await markJobFailedAndRelease(jobId, category, message, error?.rejectedArtifact, options);
}

export async function videoRenderWorkflow(jobId) {
  'use workflow';
  try {
    const { providerJobId } = await submitProvider(jobId);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await pollProvider(jobId, providerJobId);
      if (status.ready) return await finishProviderMedia(jobId, status.sourceUrl);
      await sleep('15s');
    }
    throw providerSubmissionPossibleFailure();
  } catch (error) {
    await failWorkflow(jobId, error);
    throw error;
  }
}
