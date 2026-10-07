import { FatalError, sleep } from 'workflow';
import { createHash } from 'node:crypto';
import { finalizeReadyJob, getJob, prepareProviderVideoFinish, prepareProviderVideoRead, prepareIdentityProviderRead, requireJobRenderAuthorization, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { featureEnabled } from '../lib/video-os-security.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { notifyRenderReady } from '../lib/video-os-render-notify.js';
import { assertHeygenConfigured, getHeygenPhotoAvatarStatus, pollHeygen, submitHeygen } from '../services/heygen.js';
import {
  assertFreshHeygenSpaceBinding,
  resolveFreshHeygenSpaceBinding,
} from '../db/heygen-space-binding-repository.js';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';
import { finishMedia } from '../services/media-finisher.js';
import { finishMediaWithHyperframes } from '../services/hyperframes-finisher.js';
import { finishMediaWithRemotion } from '../services/remotion-finisher.js';
import { assertScriptedPhotoHeygenInput, assertScriptedPhotoJobActivation, durableHeygenPreclaimMessage, durableProviderSubmissionPossibleMessage, parseDurableRenderFailure, renderTierForJob } from '../lib/scripted-photo-contract.js';

export function finishingEngine(env = process.env) {
  const requested = String(env.VIDEO_OS_COMPOSITION_ENGINE || 'ffmpeg').trim().toLowerCase();
  if (requested === 'ffmpeg' || requested === '') return 'ffmpeg';
  if (requested === 'remotion') return 'remotion';
  if (requested !== 'hyperframes') throw Object.assign(new Error(`Unsupported composition engine: ${requested}`), { failureCategory: 'CONFIG_MISSING' });
  if (String(env.VIDEO_OS_HYPERFRAMES_ENABLED || '').toLowerCase() !== 'true') throw Object.assign(new Error('HyperFrames was requested but disabled.'), { failureCategory: 'CONFIG_MISSING' });
  return 'hyperframes';
}

function heygenPreclaimFailure(error) {
  return new FatalError(durableHeygenPreclaimMessage(classifyFailure(error, 'RECONCILIATION')));
}

function providerSubmissionPossibleFailure() {
  return new FatalError(durableProviderSubmissionPossibleMessage());
}

function assertRenderProviderClaim(claimedJob, providerBinding, { jobId, accountId }) {
  const proof = claimedJob?.providerClaimProof;
  if (!claimedJob || !Object.isFrozen(claimedJob) || !proof || !Object.isFrozen(proof)
    || claimedJob.id !== jobId || claimedJob.accountId !== accountId || claimedJob.accountId !== providerBinding?.applicationAccountId
    || claimedJob.provider !== 'heygen' || claimedJob.status !== 'provider_submitting' || !claimedJob.input?.identityId
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
  try {
    tier = renderTierForJob(job);
    assertScriptedPhotoJobActivation(job);
    assertScriptedPhotoHeygenInput(job);
    assertHeygenConfigured();
    await requireJobRenderAuthorization(job, tier);
    if (providerCreationActivationStatus().enabled !== true) {
      throw Object.assign(new Error('HeyGen provider creation is not activated.'), {
        statusCode: 503,
        failureCategory: 'CONFIG_MISSING',
        code: 'PROVIDER_CREATION_DISABLED',
      });
    }
    if (!job.input?.identityId) {
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
    const avatarRead = await prepareIdentityProviderRead({ accountId: job.accountId, identityId: job.input.identityId, component: 'avatar', providerBinding });
    const avatarStatus = await getHeygenPhotoAvatarStatus({ groupId: avatarRead.providerAvatarGroupId, lookId: avatarRead.providerRenderableAvatarId });
    assertProviderAvatarConsentClaim(job, avatarRead, avatarStatus);
    const transitionedJob = await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding });
    submissionClaimed = true;
    claimedJob = assertRenderProviderClaim(transitionedJob, providerBinding, { jobId, accountId: job.accountId });
    assertFreshHeygenSpaceBinding(providerBinding);
    const submitted = await submitHeygen(claimedJob);
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
    const status = await pollHeygen(readClaim.providerJobId);
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
  const artifact = finishingEngine() === 'hyperframes'
    ? await finishMediaWithHyperframes(readClaim.job, sourceUrl)
    : finishingEngine() === 'remotion'
    ? await finishMediaWithRemotion(readClaim.job, sourceUrl)
    : await finishMedia(readClaim.job, sourceUrl);
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
