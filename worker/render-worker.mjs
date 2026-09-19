#!/usr/bin/env node
// VPS-hosted replacement for Vercel Workflow's durable dispatch. Vercel
// Workflow gives each render job automatic checkpointing/retry/resume
// across process restarts; this daemon gets the same practical outcome a
// simpler way, because the actual job state machine already lives in
// Postgres (db/repositories.js's transitionJob/ALLOWED_JOB_TRANSITIONS),
// not in the workflow engine. Every step function this daemon calls
// (submitProvider, pollProvider, finishProviderMedia, resolveAndRender)
// already re-checks the job's current DB state before acting -- that's
// what made them safe to call from Vercel Workflow's own retry semantics,
// and it's exactly what makes them safe to call repeatedly from a plain
// poll loop too. If this process crashes mid-job, the job just sits at its
// last successfully-transitioned status until the next poll cycle picks it
// back up -- there is no separate "resume" logic to get wrong.
//
// Run with: node worker/render-worker.mjs
// Env: RENDER_WORKER_POLL_MS (default 8000), RENDER_WORKER_CONCURRENCY (default 4)

import { listInFlightJobs, markJobFailedAndRelease } from '../db/repositories.js';
import { classifyFailure } from '../lib/video-os-operations.js';
import { captureJobError } from '../lib/video-os-observability.js';
import { failWorkflow as failPremiumWorkflow, finishProviderMedia, pollProvider, submitProvider } from '../workflows/video-render.js';
import { failWorkflow as failStandardWorkflow, resolveAndRender } from '../workflows/standard-render.js';

const POLL_INTERVAL_MS = Number(process.env.RENDER_WORKER_POLL_MS || 8000);
const CONCURRENCY = Math.max(1, Number(process.env.RENDER_WORKER_CONCURRENCY || 4));

function log(event, details = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...details }));
}

export async function driveJob(job) {
  if (job.provider === 'sadtalker') {
    await resolveAndRender(job.id);
    return;
  }
  // Premium (HeyGen): each call re-derives the correct next action from the
  // job's current DB state, so calling all three in sequence every poll
  // cycle is safe even when most of them are no-ops for a given job.
  const submitted = job.providerJobId ? { providerJobId: job.providerJobId } : await submitProvider(job.id);
  const status = await pollProvider(job.id, submitted.providerJobId);
  if (status.ready) await finishProviderMedia(job.id, status.sourceUrl);
}

async function driveJobSafely(job) {
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

async function runBatch(jobs) {
  const queue = [...jobs];
  async function worker() {
    let job;
    while ((job = queue.shift())) await driveJobSafely(job);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
}

export async function pollOnce() {
  const jobs = await listInFlightJobs();
  if (jobs.length) log('render_worker.poll', { inFlight: jobs.length });
  await runBatch(jobs);
  return jobs.length;
}

async function mainLoop() {
  log('render_worker.started', { pollIntervalMs: POLL_INTERVAL_MS, concurrency: CONCURRENCY });
  let stopping = false;
  const stop = () => { stopping = true; log('render_worker.stopping'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      log('render_worker.poll_failed', { error: String(error?.message || error) });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  log('render_worker.stopped');
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || import.meta.url.endsWith(process.argv[1] || '\0')) {
  mainLoop();
}
