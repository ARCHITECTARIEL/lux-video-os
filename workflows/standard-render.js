import { FatalError, sleep } from 'workflow';
import { database } from '../db/client.js';
import { finalizeReadyJob, getJob, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { standardNarrationRepository } from '../db/standard-narration-repository.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
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

async function resolveAndRenderSimulation(job) {
  await transitionJob({ jobId: job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
  const resolved = await resolvedSources(job);
  await transitionJob({ jobId: job.id, stageTo: 'provider_submitted', eventType: 'provider.submitted' });
  await transitionJob({ jobId: job.id, stageTo: 'provider_rendering', eventType: 'provider.polled' });
  const artifact = await renderStandardSimulation(resolved.input, resolved.assets, { format: job.format, title: job.title });
  await transitionJob({ jobId: job.id, stageTo: 'provider_ready', eventType: 'provider.ready' });
  await transitionJob({ jobId: job.id, stageTo: 'finishing', eventType: 'finish.started' });
  await finalizeReadyJob(job.id, artifact);
  return artifact;
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
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Standard render requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  try {
    return await resolveAndRenderSimulation(job);
  } catch (error) {
    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'standard_render', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') });
    await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    throw Object.assign(new FatalError('Standard render outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  }
}

export async function submitStandardProvider(jobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.providerJobId) return { providerJobId: job.providerJobId };
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Standard provider submission requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  try {
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    const resolved = await resolvedSources(job);
    const submitted = await submitRunpodStandard(resolved, { format: job.format, title: job.title });
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: submitted.providerJobId });
    return submitted;
  } catch (error) {
    const category = classifyFailure(error, 'PROVIDER_SUBMIT');
    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'standard_provider_submit', failureCategory: category });
    if (category !== 'PROVIDER_SUBMIT_UNKNOWN') throw error;
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
  await finalizeReadyJob(jobId, artifact);
  return artifact;
}

export async function driveStandardJob(jobOrId) {
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
  await markJobFailedAndRelease(jobId, category, String(error?.message || 'Workflow failed.').slice(0, 300));
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
