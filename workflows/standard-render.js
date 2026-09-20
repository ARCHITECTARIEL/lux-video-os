import { FatalError } from 'workflow';
import { database } from '../db/client.js';
import { finalizeReadyJob, getJob, markJobFailedAndRelease, transitionJob } from '../db/repositories.js';
import { standardNarrationRepository } from '../db/standard-narration-repository.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { notifyRenderReady } from '../lib/video-os-render-notify.js';
import { renderStandardSimulation } from '../services/sadtalker-simulator.js';

// Exported for the same reason as workflows/video-render.js's step exports:
// worker/render-worker.mjs (VPS hosting) calls this directly.
export async function resolveAndRender(jobId) {
  'use step';
  const job = await getJob(jobId);
  if (!job) throw new FatalError('Video job not found.');
  if (job.status === 'ready') return job.output;
  if (job.status === 'provider_submitting' || job.status === 'provider_submit_unknown') throw Object.assign(new FatalError('Standard render requires reconciliation.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  try {
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    const resolved = await database().transaction((tx) => standardNarrationRepository.resolveSources(tx, job.accountId, {
      ...job.input,
      jobId,
      format: job.format,
      correlationId: job.correlationId,
    }));
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted' });
    await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled' });
    const artifact = await renderStandardSimulation(resolved.input, resolved.assets, { format: job.format, title: job.title });
    await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready' });
    await transitionJob({ jobId, stageTo: 'finishing', eventType: 'finish.started' });
    const finalized = await finalizeReadyJob(jobId, artifact);
    await notifyRenderReady(job, finalized);
    return artifact;
  } catch (error) {
    captureJobError(error, { jobId, accountId: job.accountId, correlationId: job.correlationId, stage: 'standard_render', failureCategory: classifyFailure(error, 'PROVIDER_SUBMIT') });
    await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    throw Object.assign(new FatalError('Standard render outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  }
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
    return await resolveAndRender(jobId);
  } catch (error) {
    await failWorkflow(jobId, error);
    throw error;
  }
}
