// Shared by worker/render-worker.mjs (the VPS poll loop) and
// lib/video-os-watchdog.js (the stalled-job sweep, both hosting modes) --
// pulled out of render-worker.mjs specifically so the watchdog can import
// this without creating a circular import (render-worker.mjs's own main
// loop also calls the watchdog, on its own timer; see that file).
//
// Every step function this drives (submitProvider, pollProvider,
// finishProviderMedia, driveStandardJob) already re-checks the job's
// current DB state before acting -- that's what makes it safe to call
// repeatedly, from either caller, without its own "is this already in
// progress" bookkeeping.
import { markJobFailedAndRelease } from '../db/repositories.js';
import { classifyFailure } from './video-os-operations.js';
import { captureJobError } from './video-os-observability.js';
import { failWorkflow as failPremiumWorkflow, finishProviderMedia, pollProvider, submitProvider } from '../workflows/video-render.js';
import { driveStandardJob, failWorkflow as failStandardWorkflow } from '../workflows/standard-render.js';

export function log(event, details = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...details }));
}

export async function driveJob(job) {
  if (job.provider === 'sadtalker') {
    await driveStandardJob(job);
    return;
  }
  // Premium (HeyGen): each call re-derives the correct next action from the
  // job's current DB state, so calling all three in sequence every poll
  // cycle is safe even when most of them are no-ops for a given job.
  const submitted = job.providerJobId ? { providerJobId: job.providerJobId } : await submitProvider(job.id);
  const status = await pollProvider(job.id, submitted.providerJobId);
  if (status.ready) await finishProviderMedia(job.id, status.sourceUrl);
}

export async function driveJobSafely(job) {
  try {
    await driveJob(job);
    log('render_worker.job_driven', { jobId: job.id, provider: job.provider, status: job.status });
  } catch (error) {
    const category = classifyFailure(error, 'INTERNAL');
    captureJobError(error, { jobId: job.id, accountId: job.accountId, correlationId: job.correlationId, stage: 'render_worker', failureCategory: category });
    if (category === 'PROVIDER_SUBMIT_UNKNOWN') {
      // Held pending reconciliation -- the step function already recorded
      // this in the job's own state. Do not retry-loop; do not fail it.
      log('render_worker.job_held', { jobId: job.id, reason: category });
      return;
    }
    try {
      if (job.provider === 'sadtalker') await failStandardWorkflow(job.id, error);
      else await failPremiumWorkflow(job.id, error);
    } catch (cleanupError) {
      // failWorkflow itself failing is the one case worth a direct release
      // fallback, so a bug in that path doesn't leave credits reserved forever.
      log('render_worker.cleanup_failed', { jobId: job.id, error: String(cleanupError?.message || cleanupError) });
      await markJobFailedAndRelease(job.id, category, String(error?.message || 'Worker failed.').slice(0, 300)).catch(() => {});
    }
  }
}
