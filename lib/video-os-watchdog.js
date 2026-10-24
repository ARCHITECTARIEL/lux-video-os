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
//     definitely happened), so one more poll/finish attempt is safe. A
//     timeout failure is safe only when that attempt successfully checks the
//     provider and confirms the job is still unresolved. Provider/auth/
//     dependency failures leave the reservation held for manual review.
//   - "Ambiguous": no confirmed provider engagement (dispatch may have
//     silently never happened) or already explicitly held pending manual
//     review. Never auto-acted on, only alerted -- exactly the caution this
//     codebase already applies to submission-time errors, extended to
//     silence instead of just exceptions.
import { claimWatchdogJobs, getJob, listStalledActionableJobs, listStalledAmbiguousJobs, listStalledSafeToReleaseJobs, markJobFailedAndRelease, WATCHDOG_STALE_MINUTES_DEFAULT } from '../db/repositories.js';
import { driveJob } from './video-os-render-driver.js';
import { classifyFailure } from './video-os-operations.js';
import { captureJobError } from './video-os-observability.js';
import { claimWatchdogEscalation, notifyWatchdogSweep } from './video-os-watchdog-notify.js';
import { sweepExpiredHostedConsentUrls } from './provider-consent-url-cleanup.js';
import * as Sentry from '@sentry/node';

const RESOLVED_STATUSES = Object.freeze(['ready', 'failed', 'cancelled']);
const HELD_FOR_REVIEW_STATUSES = Object.freeze(['provider_submit_unknown', 'finish_contained']);
const DEFAULT_ESCALATE_HOURS = 24;
const DEFAULT_RENOTIFY_HOURS = 6;
const FALLBACK_CLAIM_LIMIT = 2000;
const fallbackClaims = new Map();

function fallbackClaim(jobId, level) {
  const configured = Number(process.env.VIDEO_OS_WATCHDOG_RENOTIFY_HOURS);
  const intervalMs = (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RENOTIFY_HOURS) * 60 * 60_000;
  const now = Date.now();
  const key = `${jobId}:${level}`;
  if (now - (fallbackClaims.get(key) ?? -Infinity) < intervalMs) return false;
  rememberClaim(jobId, level);
  return true;
}

function rememberClaim(jobId, level) {
  const key = `${jobId}:${level}`;
  fallbackClaims.delete(key);
  fallbackClaims.set(key, Date.now());
  if (fallbackClaims.size > FALLBACK_CLAIM_LIMIT) fallbackClaims.delete(fallbackClaims.keys().next().value);
}

function fallbackCriticalHeld(jobId) {
  const configured = Number(process.env.VIDEO_OS_WATCHDOG_RENOTIFY_HOURS);
  const intervalMs = (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RENOTIFY_HOURS) * 60 * 60_000;
  return Date.now() - (fallbackClaims.get(`${jobId}:critical`) ?? -Infinity) < intervalMs;
}

export function watchdogEscalateHours(env = process.env) {
  const hours = Number(env.VIDEO_OS_WATCHDOG_ESCALATE_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_ESCALATE_HOURS;
}

export function watchdogSeverity(ageMinutes, env = process.env) {
  return ageMinutes >= watchdogEscalateHours(env) * 60 ? 'critical' : 'warn';
}

function jobAgeMinutes(value, now) {
  const date = value instanceof Date ? value : new Date(value);
  const elapsed = now - date.getTime();
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 60_000)) : null;
}

function staleJobDetails(job, now) {
  return { jobId: job.id, status: job.status,
    ageMinutes: jobAgeMinutes(job.createdAt, now), staleMinutes: jobAgeMinutes(job.updatedAt, now) };
}

async function watchdogAlert(job, message, failureCategory, gate = claimWatchdogEscalation, onStoreUnavailable = () => {}, terminal = false) {
  const severity = watchdogSeverity(jobAgeMinutes(job.createdAt, Date.now()) || 0);
  let claimed = terminal;
  let level = severity;
  if (!terminal) {
    let storeFailed = false;
    try { claimed = await gate(job.id, severity); if (claimed) rememberClaim(job.id, severity); }
    catch { onStoreUnavailable(); storeFailed = true; claimed = fallbackClaim(job.id, severity); }
    if (!claimed && severity === 'critical' && !storeFailed && !fallbackCriticalHeld(job.id)) {
      level = 'warn';
      try { claimed = await gate(job.id, 'warn'); if (claimed) rememberClaim(job.id, 'warn'); }
      catch { onStoreUnavailable(); claimed = fallbackClaim(job.id, 'warn'); }
    }
  }
  if (claimed) Sentry.withScope(scope => {
    scope.setLevel(level === 'critical' ? 'fatal' : 'warning');
    captureJobError(Object.assign(new Error(message), { failureCategory }), {
      jobId: job.id, accountId: job.accountId, correlationId: job.correlationId, stage: 'watchdog', failureCategory,
      severity: level,
    });
  });
  return { jobId: job.id, level, claimed, terminal };
}

async function holdRecoveryForReview(job, error, gate, onStoreUnavailable, onAlert) {
  const failureCategory = classifyFailure(error, 'RECOVERY');
  const alert = await watchdogAlert(
    job,
    `Watchdog recovery check failed for job ${job.id}; provider state was not confirmed, so the job and reserved credits remain held for manual review.`,
    failureCategory, gate, onStoreUnavailable,
  );
  onAlert(alert);
  return { jobId: job.id, outcome: 'recovery_failed', status: job.status, failureCategory };
}

async function holdRecoveryStatusForReview(job, gate, onStoreUnavailable, onAlert) {
  const finishContained = job.status === 'finish_contained';
  const failureCategory = finishContained ? 'CONFIG_MISSING' : 'PROVIDER_SUBMIT_UNKNOWN';
  const alert = await watchdogAlert(
    job,
    finishContained
      ? `Watchdog recovery contained finishing for job ${job.id}; the job and reserved credits remain held for manual review.`
      : `Watchdog recovery left job ${job.id} in ${job.status}; the job and reserved credits remain held for manual review.`,
    failureCategory, gate, onStoreUnavailable,
  );
  onAlert(alert);
  return { jobId: job.id, outcome: 'recovery_failed', status: job.status, failureCategory };
}

async function attemptRecovery(job, staleAfterMinutes, gate, onStoreUnavailable, onAlert) {
  // The ordinary worker uses driveJobSafely(), which converts deterministic
  // failures into terminal failures. The watchdog must be stricter: revoked
  // credentials and unavailable dependencies make provider state unknown,
  // so they must never be mistaken for a confirmed provider timeout.
  try {
    await driveJob(job);
  } catch (error) {
    return holdRecoveryForReview(job, error, gate, onStoreUnavailable, onAlert);
  }

  let after;
  try {
    after = await getJob(job.id);
  } catch (error) {
    return holdRecoveryForReview(job, error, gate, onStoreUnavailable, onAlert);
  }
  if (!after || RESOLVED_STATUSES.includes(after.status)) return { jobId: job.id, outcome: 'recovered', status: after?.status || 'missing' };
  if (HELD_FOR_REVIEW_STATUSES.includes(after.status)) return holdRecoveryStatusForReview(after, gate, onStoreUnavailable, onAlert);

  // driveJob() returned successfully, which means this actionable job's
  // provider poll completed without an auth/provider/dependency error. The
  // fresh read still shows an unresolved state, so the timeout transition is
  // now based on confirmed provider evidence rather than configuration alone.
  const timeout = await markJobFailedAndRelease(after.id, 'PROVIDER_TIMEOUT', `Render exceeded the watchdog reconciliation timeout (${staleAfterMinutes} minutes); a successful provider check confirmed it remains unresolved.`, undefined, {
    expectedStatuses: [after.status], expectedUpdatedAt: after.updatedAt, withTransition: true,
  });
  if (!timeout.transitioned) return { jobId: job.id, outcome: 'concurrent_progress', status: timeout.job?.status || 'missing' };
  const alert = await watchdogAlert(after, `Watchdog timeout: job ${after.id} stuck in ${after.status} for over ${staleAfterMinutes} minutes; failed and released credits.`, 'PROVIDER_TIMEOUT', gate, onStoreUnavailable, true);
  onAlert(alert);
  return { jobId: job.id, outcome: 'timed_out', status: after.status };
}

export async function runWatchdogSweep({ staleAfterMinutes = WATCHDOG_STALE_MINUTES_DEFAULT, limit = 25,
  escalationGate = claimWatchdogEscalation } = {}) {
  const [actionable, ambiguous, safeToRelease] = await Promise.all([
    listStalledActionableJobs(staleAfterMinutes, limit),
    listStalledAmbiguousJobs(staleAfterMinutes, limit),
    listStalledSafeToReleaseJobs(staleAfterMinutes, limit),
  ]);

  const now = Date.now();
  const selectedJobs = [...actionable, ...ambiguous, ...safeToRelease].sort((a, b) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const staleJobs = selectedJobs.map(job => staleJobDetails(job, now));
  const oldestStaleAgeMinutes = staleJobs.reduce((oldest, job) => Math.max(oldest, job.ageMinutes || 0), 0);
  const severity = watchdogSeverity(oldestStaleAgeMinutes);
  if (!await claimWatchdogJobs(selectedJobs)) {
    return {
      staleAfterMinutes, oldestStaleAgeMinutes, severity, staleJobs,
      actionableFound: actionable.length, ambiguousFound: ambiguous.length,
      safeToReleaseFound: safeToRelease.length, claimConflicts: selectedJobs.length,
      recovered: 0, timedOut: 0, alerted: 0, released: 0,
      jobs: { recovery: [], alertedIds: [], releasedIds: [] },
    };
  }

  const recovery = [];
  const alerts = [];
  let storeUnavailableLogged = false;
  const onStoreUnavailable = () => {
    if (storeUnavailableLogged) return;
    storeUnavailableLogged = true;
    try { console.error('watchdog.escalation_store_unavailable', { event: 'watchdog.escalation_store_unavailable' }); } catch { /* keep alert delivery open */ }
    try {
      Sentry.withScope(scope => {
        scope.setLevel('warning');
        captureJobError(new Error('Watchdog escalation store unavailable.'), { stage: 'watchdog', failureCategory: 'ESCALATION_STORE_UNAVAILABLE' });
      });
    } catch { /* keep alert delivery open */ }
  };
  for (const job of actionable) {
    // Sequential, not Promise.all: these jobs already reserved real
    // provider spend, so there's no throughput pressure that justifies the
    // added complexity of concurrent failure handling here.
    const outcome = await attemptRecovery(job, staleAfterMinutes, escalationGate, onStoreUnavailable, alert => alerts.push(alert));
    recovery.push(outcome);
  }

  const alertedIds = recovery
    .filter((result) => result.outcome === 'recovery_failed')
    .map((result) => result.jobId);
  for (const job of ambiguous) {
    alerts.push(await watchdogAlert(
      job,
      `Watchdog alert: job ${job.id} stuck in ${job.status} for over ${staleAfterMinutes} minutes with no confirmed provider engagement.`,
      job.status === 'provider_submit_unknown' ? 'PROVIDER_SUBMIT_UNKNOWN' : 'RECONCILIATION', escalationGate, onStoreUnavailable,
    ));
    alertedIds.push(job.id);
  }

  const released = [];
  for (const job of safeToRelease) {
    // Safe to auto-release, unlike the ambiguous bucket above: 'reserved'
    // proves claimWorkflowStart() was never called, so no provider was ever
    // contacted -- see WATCHDOG_SAFE_TO_RELEASE_STATUSES in db/repositories.js.
    const message = `Render was reserved but never dispatched within the watchdog reconciliation timeout (${staleAfterMinutes} minutes); no provider was ever contacted, so credits were safely released automatically.`;
    const resolution = await markJobFailedAndRelease(job.id, 'RECONCILIATION', message, undefined, {
      expectedStatuses: ['reserved'], expectedUpdatedAt: job.updatedAt, withTransition: true,
    });
    if (!resolution.transitioned) continue;
    alerts.push(await watchdogAlert(job, `Watchdog auto-release: job ${job.id} stuck in 'reserved' for over ${staleAfterMinutes} minutes; failed and released credits automatically.`, 'RECONCILIATION', escalationGate, onStoreUnavailable, true));
    released.push(job.id);
  }

  const result = {
    staleAfterMinutes, oldestStaleAgeMinutes,
    severity: alerts.some(alert => alert.claimed && alert.level === 'critical') ? 'critical' : 'warn',
    notificationJobIds: alerts.filter(alert => alert.claimed).map(alert => alert.jobId), staleJobs,
    actionableFound: actionable.length,
    ambiguousFound: ambiguous.length,
    safeToReleaseFound: safeToRelease.length,
    claimConflicts: 0,
    recovered: recovery.filter((r) => r.outcome === 'recovered').length,
    timedOut: recovery.filter((r) => r.outcome === 'timed_out').length,
    alerted: alertedIds.length,
    released: released.length,
    jobs: { recovery, alertedIds, releasedIds: released },
  };

  // Hosted links stay private and reusable during their 24-hour provider
  // window. The ordinary watchdog cadence removes them after expiry, even
  // when new consent sessions have been disabled in the meantime.
  if (process.env.DATABASE_URL) {
    try {
      result.hostedConsentUrlCleanup = await sweepExpiredHostedConsentUrls({ execute: true });
      if (result.hostedConsentUrlCleanup.failed > 0) {
        captureJobError(new Error('Expired hosted consent URL cleanup needs retry.'), { stage: 'hosted_consent_url_cleanup' });
      }
    } catch (error) {
      captureJobError(error, { stage: 'hosted_consent_url_cleanup' });
      result.hostedConsentUrlCleanup = { failed: true };
    }
  }

  // Best-effort, same as notifyRenderReady: a broken/unconfigured
  // notification channel must never fail the sweep itself, which is why
  // this isn't awaited into the try/catch chain above.
  try {
    await notifyWatchdogSweep(result);
  } catch (error) {
    captureJobError(error, { stage: 'watchdog_notification' });
    console.warn('::warning::Watchdog notification delivery failed');
  }

  return result;
}
