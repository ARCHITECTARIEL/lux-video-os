import { FatalError, sleep } from 'workflow';
import { database } from '../db/client.js';
import { finalizeReadyJob, getJob, requireJobRenderAuthorization, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { standardNarrationRepository } from '../db/standard-narration-repository.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { notifyRenderReady } from '../lib/video-os-render-notify.js';
import { persistRunpodStandardOutput, pollRunpodStandard, standardProviderMode, submitRunpodStandard } from '../services/sadtalker-runpod.js';
import { renderStandardSimulation } from '../services/sadtalker-simulator.js';

async function resolvedSources(job) {
  return database().transaction((tx) => standardNarrationRepository.resolveSources(tx, job.accountId, {
    ...job.input,
    jobId: job.id,
    format: job.format,
    correlationId: job.correlationId,
  }));
}

const simulationStages = ['workflow_started', 'provider_submitting', 'provider_submitted', 'provider_rendering', 'provider_ready', 'finishing', 'ready'];

async function advanceSimulation(jobId, from, to, eventType) {
  let current = await getJob(jobId);
  if (current?.status === from) {
    try { return await transitionJob({ jobId, stageTo: to, eventType }); }
    catch (error) {
      if (error?.statusCode !== 409) throw error;
      current = await getJob(jobId);
    }
  }
  if (simulationStages.indexOf(current?.status) >= simulationStages.indexOf(to)) return current;
  throw Object.assign(new FatalError('Simulation cannot resume from this job state.'), { failureCategory: 'RECONCILIATION' });
}

async function resolveAndRenderSimulation(job) {
  const claimed = await advanceSimulation(job.id, 'workflow_started', 'provider_submitting', 'provider.submit_started');
  if (claimed.status === 'ready') return claimed.output;
  const resolved = await resolvedSources(job);
  await advanceSimulation(job.id, 'provider_submitting', 'provider_submitted', 'provider.submitted');
  await advanceSimulation(job.id, 'provider_submitted', 'provider_rendering', 'provider.polled');
  // Recomputing a local simulation after restart has no remote provider spend.
  // Unique temp directories and immutable storage make overlapping retries safe.
  const artifact = await renderStandardSimulation(resolved.input, resolved.assets, { format: job.format, title: job.title });
  const progressed = await advanceSimulation(job.id, 'provider_rendering', 'provider_ready', 'provider.ready');
  if (progressed.status === 'ready') return progressed.output;
  await advanceSimulation(job.id, 'provider_ready', 'finishing', 'finish.started');
  const finalized = await finalizeReadyJob(job.id, artifact);
  await notifyRenderReady(job, finalized);
  return finalized.output;
}

// Kept for the local simulator and existing tests. RunPod mode uses the
// submit/poll/finish steps below so Vercel Workflow and the VPS poller share
// the same provider lifecycle.
export async function resolveAndRender(jobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.status === 'ready') return job.output;
  if (standardProviderMode() !== 'simulation') return driveStandardJob(job);
  if (job.providerJobId || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Standard render requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  if (job.status === 'workflow_started') await requireJobRenderAuthorization(job, 'standard');
  // Simulation has no ambiguous external submission. Decode/storage/finalize
  // rejection must reach failWorkflow so the reservation is released.
  return resolveAndRenderSimulation(job);
}

export async function submitStandardProvider(jobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.providerJobId) return { providerJobId: job.providerJobId };
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Standard provider submission requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await requireJobRenderAuthorization(job, 'standard');
  let submissionClaimed = false;
  try {
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    submissionClaimed = true;
    const resolved = await resolvedSources(job);
    const submitted = await submitRunpodStandard(resolved, { format: job.format, title: job.title });
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: submitted.providerJobId });
    return submitted;
  } catch (error) {
    if (!submissionClaimed && error?.failureCategory === 'ENTITLEMENT') {
      throw Object.assign(new FatalError('Render permission was revoked before submission.'), { failureCategory: 'ENTITLEMENT' });
    }
    // Every submission-time error -- not just ones classified
    // PROVIDER_SUBMIT_UNKNOWN -- routes to the safe held state, same as
    // workflows/video-render.js's submitProvider. A concurrent submit retry
    // (a Vercel Workflow retry racing the VPS poller, for example) can land
    // here with a plain RECONCILIATION-category invalid-transition error
    // from assertJobTransition; conditionally rethrowing that raw would
    // mark the job failed and release its reserved credits while the
    // other concurrent submission may genuinely still be in flight --
    // the exact duplicate-charge/lost-render scenario this function
    // exists to prevent. See GitHub issue #23.
    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'standard_provider_submit', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') });
    await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    throw Object.assign(new FatalError('Standard provider submission outcome is uncertain; automatic resubmission is blocked.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  }
}

export async function pollStandardProvider(jobId, providerJobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  const status = await pollRunpodStandard(providerJobId);
  if (['provider_ready', 'finishing'].includes(job.status) && status.ready) return status;
  if (['provider_ready', 'finishing'].includes(job.status)) throw Object.assign(new FatalError('RunPod state regressed after Standard media became ready.'), { failureCategory: 'RECONCILIATION' });
  if (!status.ready) await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled', details: { providerStatus: status.status } });
  else await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready' });
  return status;
}

export async function finishStandardProvider(jobId, output) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.status === 'ready') return job.output;
  if (job.status === 'provider_ready') await transitionJob({ jobId, stageTo: 'finishing', eventType: 'finish.started' });
  else if (job.status !== 'finishing') throw Object.assign(new FatalError(`Standard finishing cannot resume from ${job.status}.`), { failureCategory: 'RECONCILIATION' });
  const artifact = await persistRunpodStandardOutput(job, output);
  const finalized = await finalizeReadyJob(jobId, artifact);
  await notifyRenderReady(job, finalized);
  return artifact;
}

export async function driveStandardJob(jobOrId) {
  'use step';
  // The VPS poller may call this directly, but its database read must never
  // become part of the restricted durable-workflow bundle.
  const job = typeof jobOrId === 'string' ? await getJob(jobOrId) : jobOrId;
  if (!job) throw new FatalError('Video job not found.');
  if (job.status === 'ready') return job.output;
  if (standardProviderMode() === 'simulation') return resolveAndRender(job.id);
  const submitted = job.providerJobId ? { providerJobId: job.providerJobId } : await submitStandardProvider(job.id);
  const status = await pollStandardProvider(job.id, submitted.providerJobId);
  if (status.ready) return finishStandardProvider(job.id, status.output);
  return status;
}

export async function failWorkflow(jobId, error) {
  'use step';
  const category = classifyFailure(error, 'INTERNAL');
  if (category === 'PROVIDER_SUBMIT_UNKNOWN') return;
  await markJobFailedAndRelease(jobId, category, String(error?.message || 'Workflow failed.').slice(0, 300), error?.rejectedArtifact);
}

export async function standardRenderWorkflow(jobId) {
  'use workflow';
  try {
    if (standardProviderMode() === 'simulation') return await resolveAndRender(jobId);
    const { providerJobId } = await submitStandardProvider(jobId);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await pollStandardProvider(jobId, providerJobId);
      if (status.ready) return await finishStandardProvider(jobId, status.output);
      await sleep('15s');
    }
    throw Object.assign(new Error('RunPod Standard render exceeded the 30 minute workflow deadline.'), { failureCategory: 'PROVIDER_TIMEOUT' });
  } catch (error) {
    await failWorkflow(jobId, error);
    throw error;
  }
}
