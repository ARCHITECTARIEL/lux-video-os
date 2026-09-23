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
// Also runs lib/video-os-watchdog.js's stalled-job sweep on its own, much
// slower timer -- this daemon is already a long-running process, so it's
// the natural place for the VPS half of operational recovery/supervision
// (see that module's own comment for the Vercel half, and for why a stuck
// job needs more than just this poll loop: a job can go non-terminal
// without ever throwing, e.g. a provider that silently stops responding,
// and nothing here would otherwise notice).
//
// Same reasoning for lib/video-os-stripe-reconciliation.js's Stripe-vs-
// ledger check, on its own much-slower-still timer (default 24h, matching
// docs/P0-RELEASE-GATE.md's "reconcile daily") -- the VPS half of that
// gate's requirement, mirroring .github/workflows/stripe-reconciliation.yml
// on the Vercel side.
//
// Run with: node worker/render-worker.mjs
// Env: RENDER_WORKER_POLL_MS (default 8000), RENDER_WORKER_CONCURRENCY (default 4),
//      RENDER_WORKER_WATCHDOG_INTERVAL_MS (default 300000 / 5 minutes),
//      RENDER_WORKER_STRIPE_RECONCILIATION_INTERVAL_MS (default 86400000 / 24 hours)

import { listInFlightJobs } from '../db/repositories.js';
import { driveJobSafely, log } from '../lib/video-os-render-driver.js';
import { reconcileStripePayments } from '../lib/video-os-stripe-reconciliation.js';
import { runWatchdogSweep } from '../lib/video-os-watchdog.js';

const POLL_INTERVAL_MS = Number(process.env.RENDER_WORKER_POLL_MS || 8000);
const CONCURRENCY = Math.max(1, Number(process.env.RENDER_WORKER_CONCURRENCY || 4));
const WATCHDOG_INTERVAL_MS = Number(process.env.RENDER_WORKER_WATCHDOG_INTERVAL_MS || 5 * 60_000);
const STRIPE_RECONCILIATION_INTERVAL_MS = Number(process.env.RENDER_WORKER_STRIPE_RECONCILIATION_INTERVAL_MS || 24 * 60 * 60_000);

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

async function runWatchdogSweepSafely() {
  try {
    const result = await runWatchdogSweep();
    if (result.actionableFound || result.ambiguousFound) log('render_worker.watchdog_swept', result);
  } catch (error) {
    log('render_worker.watchdog_failed', { error: String(error?.message || error) });
  }
}

async function runStripeReconciliationSafely() {
  try {
    const result = await reconcileStripePayments();
    log('render_worker.stripe_reconciled', { sessionsChecked: result.sessionsChecked, mismatchCount: result.mismatchCount });
  } catch (error) {
    // Expected/benign until real STRIPE_SECRET_KEY is configured
    // (reconcileStripePayments() fails loud with a 503-shaped error in
    // that case) -- log at the same level regardless, an operator reading
    // logs can tell the two apart from the message.
    log('render_worker.stripe_reconciliation_failed', { error: String(error?.message || error) });
  }
}

async function mainLoop() {
  log('render_worker.started', { pollIntervalMs: POLL_INTERVAL_MS, concurrency: CONCURRENCY, watchdogIntervalMs: WATCHDOG_INTERVAL_MS, stripeReconciliationIntervalMs: STRIPE_RECONCILIATION_INTERVAL_MS });
  let stopping = false;
  let lastWatchdogRunAt = 0;
  let lastStripeReconciliationRunAt = 0;
  const stop = () => { stopping = true; log('render_worker.stopping'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      log('render_worker.poll_failed', { error: String(error?.message || error) });
    }
    // Decoupled from the 8s poll cadence -- the watchdog only looks at
    // jobs stale by 30+ minutes, so running it every cycle would just be
    // an identical, wasted query almost every time.
    if (Date.now() - lastWatchdogRunAt >= WATCHDOG_INTERVAL_MS) {
      lastWatchdogRunAt = Date.now();
      await runWatchdogSweepSafely();
    }
    if (Date.now() - lastStripeReconciliationRunAt >= STRIPE_RECONCILIATION_INTERVAL_MS) {
      lastStripeReconciliationRunAt = Date.now();
      await runStripeReconciliationSafely();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  log('render_worker.stopped');
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || import.meta.url.endsWith(process.argv[1] || '\0')) {
  mainLoop();
}
