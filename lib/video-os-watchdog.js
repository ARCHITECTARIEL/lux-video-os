// Operational recovery/supervision for render jobs -- the piece HANDOFF.md
// calls out as missing for both render tiers: "a stalled job currently only
// surfaces via a human checking the 'Needs attention' tab." This closes
// that gap with one hosting-agnostic sweep, callable from either place a
// job can silently stall:
//   - Vercel: routes/video-os-lite/admin.js's operation=watchdog-sweep,
//     triggered on a schedule by .github/workflows/watchdog-sweep.yml (see
//     that file for why this isn't a native Vercel Cron -- the Hobby plan's
//     once-a-day cron cadence is too coarse to matter here).
//   - VPS: worker/render-worker.mjs's own long-running loop calls this
//     directly on its own timer, no HTTP hop needed.
//
// Two different job buckets get two different treatments, and this
// distinction is the entire point -- see GitHub issue #23 for why guessing
// wrong here risks a duplicate charge or a lost render:
//   - "Actionable": a providerJobId is confirmed to exist (submission
//     definitely happened), so one more poll/finish attempt is safe, and if
//     that still doesn't resolve it, so is a timeout failure -- the credits
//     were already correctly reserved against a real provider job, not a
//     guess.
//   - "Ambiguous": no confirmed provider engagement (dispatch may have
//     silently never happened) or already explicitly held pending manual
//     review. Never auto-acted on, only alerted -- exactly the caution this
//     codebase already applies to submission-time errors, extended to
//     silence instead of just exceptions.
import { getJob, listStalledActionableJobs, listStalledAmbiguousJobs, listStalledSafeToReleaseJobs, markJobFailedAndRelease, WATCHDOG_STALE_MINUTES_DEFAULT } from '../db/repositories.js';
import { driveJobSafely } from './video-os-render-driver.js';
import { captureJobError } from './video-os-observability.js';
import { notifyWatchdogSweep } from './video-os-watchdog-notify.js';

const RESOLVED_OR_HELD_STATUSES = Object.freeze(['ready', 'failed', 'cancelled', 'provider_submit_unknown']);

function watchdogAlert(job, message, failureCategory) {
  captureJobError(Object.assign(new Error(message), { failureCategory }), {
    jobId: job.id, accountId: job.accountId, correlationId: job.correlationId, stage: 'watchdog', failureCategory,
  });
}

async function attemptRecovery(job, staleAfterMinutes) {
  // driveJobSafely (also used by worker/render-worker.mjs's own poll loop)
  // already classifies and safely handles anything it throws (holds
  // PROVIDER_SUBMIT_UNKNOWN jobs, fails+releases everything else) --
  // nothing here needs its own try/catch around that call.
  await driveJobSafely(job);
  const after = await getJob(job.id);
  if (!after || RESOLVED_OR_HELD_STATUSES.includes(after.status)) return { jobId: job.id, outcome: 'recovered', status: after?.status || 'missing' };

  // Still sitting in a non-terminal, non-held status after a fair final
  // attempt and staleAfterMinutes of prior silence -- driveJobSafely's one
  // attempt didn't move it, so waiting for another sweep would just repeat
  // this. A providerJobId already exists here (WATCHDOG_ACTIONABLE_STATUSES
  // guarantees it), so failing and releasing credits now is the same safe
  // outcome videoRenderWorkflow/standardRenderWorkflow's own 30-minute
  // Vercel Workflow deadline already produces -- this just makes that
  // enforcement hosting-mode-independent instead of Vercel-only.
  await markJobFailedAndRelease(after.id, 'PROVIDER_TIMEOUT', `Render exceeded the watchdog reconciliation timeout (${staleAfterMinutes} minutes) without provider confirmation.`);
  watchdogAlert(after, `Watchdog timeout: job ${after.id} stuck in ${after.status} for over ${staleAfterMinutes} minutes; failed and released credits.`, 'PROVIDER_TIMEOUT');
  return { jobId: job.id, outcome: 'timed_out', status: after.status };
}

export async function runWatchdogSweep({ staleAfterMinutes = WATCHDOG_STALE_MINUTES_DEFAULT, limit = 25 } = {}) {
  const [actionable, ambiguous, safeToRelease] = await Promise.all([
    listStalledActionableJobs(staleAfterMinutes, limit),
    listStalledAmbiguousJobs(staleAfterMinutes, limit),
    listStalledSafeToReleaseJobs(staleAfterMinutes, limit),
  ]);

  const recovery = [];
  for (const job of actionable) {
    // Sequential, not Promise.all: these jobs already reserved real
    // provider spend, so there's no throughput pressure that justifies the
    // added complexity of concurrent failure handling here.
    recovery.push(await attemptRecovery(job, staleAfterMinutes));
  }

  for (const job of ambiguous) {
    watchdogAlert(
      job,
      `Watchdog alert: job ${job.id} stuck in ${job.status} for over ${staleAfterMinutes} minutes with no confirmed provider engagement.`,
      job.status === 'provider_submit_unknown' ? 'PROVIDER_SUBMIT_UNKNOWN' : 'RECONCILIATION',
    );
  }

  const released = [];
  for (const job of safeToRelease) {
    // Safe to auto-release, unlike the ambiguous bucket above: 'reserved'
    // proves claimWorkflowStart() was never called, so no provider was ever
    // contacted -- see WATCHDOG_SAFE_TO_RELEASE_STATUSES in db/repositories.js.
    const message = `Render was reserved but never dispatched within the watchdog reconciliation timeout (${staleAfterMinutes} minutes); no provider was ever contacted, so credits were safely released automatically.`;
    await markJobFailedAndRelease(job.id, 'RECONCILIATION', message);
    watchdogAlert(job, `Watchdog auto-release: job ${job.id} stuck in 'reserved' for over ${staleAfterMinutes} minutes; failed and released credits automatically.`, 'RECONCILIATION');
    released.push(job.id);
  }

  const result = {
    staleAfterMinutes,
    actionableFound: actionable.length,
    ambiguousFound: ambiguous.length,
    safeToReleaseFound: safeToRelease.length,
    recovered: recovery.filter((r) => r.outcome === 'recovered').length,
    timedOut: recovery.filter((r) => r.outcome === 'timed_out').length,
    alerted: ambiguous.length,
    released: released.length,
    jobs: { recovery, alertedIds: ambiguous.map((job) => job.id), releasedIds: released },
  };

  // Best-effort, same as notifyRenderReady: a broken/unconfigured
  // notification channel must never fail the sweep itself, which is why
  // this isn't awaited into the try/catch chain above.
  try {
    await notifyWatchdogSweep(result);
  } catch (error) {
    captureJobError(error, { stage: 'watchdog_notification' });
  }

  return result;
}
