// Ops notification for lib/video-os-watchdog.js's sweep, alongside its
// always-on Sentry logging (watchdogAlert() in that file). Sentry alone
// requires someone to be actively watching a dashboard; this adds a channel
// that reaches an actual person. Both destinations are optional and
// independent (WATCHDOG_ALERT_EMAIL / WATCHDOG_SLACK_WEBHOOK_URL) -- leaving
// both unset reproduces the previous Sentry-only behavior exactly.
//
// Best-effort by design, same reasoning as notifyRenderReady: a broken or
// unconfigured notification channel must never fail the watchdog sweep
// itself, and one channel failing must never block the other.
import { captureJobError } from './video-os-observability.js';
import { postWatchdogAlertSlack, sendWatchdogAlertEmail } from './video-os-notifications.js';
import { publicOrigin } from './video-os-security.js';
import { and, desc, eq, sql } from 'drizzle-orm';

const DEFAULT_RENOTIFY_HOURS = 6;

export async function claimWatchdogEscalation(jobId, level, {
  store = claimPersistedEscalation, env = process.env, now = () => new Date(),
} = {}) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(jobId) || !['critical', 'warn'].includes(level)) return false;
  const configuredHours = Number(env.VIDEO_OS_WATCHDOG_RENOTIFY_HOURS);
  const hours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : DEFAULT_RENOTIFY_HOURS;
  const at = now();
  return store({ jobId, level, at, intervalMs: hours * 60 * 60_000 });
}

async function claimPersistedEscalation({ jobId, level, at, intervalMs }) {
  const [{ database }, { opsEvents }] = await Promise.all([import('../db/client.js'), import('../db/schema.js')]);
  return database().transaction(async tx => {
    // Transaction-scoped lock serializes claims across instances without a schema change.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`watchdog.escalated:${jobId}:${level}`}, 0))`);
    const rows = await tx.select({ createdAt: opsEvents.createdAt }).from(opsEvents)
      .where(and(eq(opsEvents.event, 'watchdog.escalated'), eq(opsEvents.entityId, jobId),
        eq(opsEvents.code, level))).orderBy(desc(opsEvents.createdAt)).limit(1);
    const last = rows[0]?.createdAt;
    if (last && (level === 'critical' || at.getTime() - new Date(last).getTime() < intervalMs)) return false;
    if (level === 'warn') {
      const critical = await tx.select({ createdAt: opsEvents.createdAt }).from(opsEvents)
        .where(and(eq(opsEvents.event, 'watchdog.escalated'), eq(opsEvents.entityId, jobId),
          eq(opsEvents.code, 'critical'))).orderBy(desc(opsEvents.createdAt)).limit(1);
      if (critical[0] && at.getTime() - new Date(critical[0].createdAt).getTime() < intervalMs) return false;
    }
    await tx.insert(opsEvents).values({ level: level === 'critical' ? 'error' : 'warn',
      event: 'watchdog.escalated', entityType: 'job', entityId: jobId,
      code: level, message: 'Watchdog escalation claimed.', details: { level } });
    return true;
  });
}

function appUrlOrNull() {
  // publicOrigin() throws when VIDEO_OS_PUBLIC_ORIGIN isn't configured --
  // fine for a link that's a nice-to-have in the alert body, not worth
  // failing the whole notification over.
  try {
    return publicOrigin();
  } catch {
    return null;
  }
}

function summarize(result) {
  const lines = [];
  const containedFinish = result.jobs.recovery.filter((item) => item.outcome === 'recovery_failed' && item.status === 'finish_contained').length;
  const failedRecovery = result.jobs.recovery.filter((item) => item.outcome === 'recovery_failed' && item.status !== 'finish_contained').length;
  const ambiguous = Math.max(0, result.alerted - failedRecovery - containedFinish);
  if (result.recovered) lines.push(`${result.recovered} job(s) recovered automatically.`);
  if (result.timedOut) lines.push(`${result.timedOut} job(s) timed out and were failed, with credits released back to the customer.`);
  if (result.released) lines.push(`${result.released} job(s) were reserved but never dispatched, and had their credits released automatically (no provider was ever contacted).`);
  if (failedRecovery) lines.push(`${failedRecovery} job(s) have confirmed provider engagement, but provider state was not confirmed by the recovery check; credits remain reserved for manual review.`);
  if (containedFinish) lines.push(`${containedFinish} job(s) have provider media ready but finishing was contained; credits remain reserved for manual review.`);
  if (ambiguous) lines.push(`${ambiguous} job(s) are stuck with no confirmed provider engagement and need manual review.`);
  const jobIds = [
    ...result.jobs.recovery.filter((r) => r.outcome === 'timed_out').map((r) => r.jobId),
    ...(result.jobs.releasedIds || []),
    ...result.jobs.alertedIds,
  ];
  const order = new Map((result.staleJobs || []).map((job, index) => [job.jobId, index]));
  jobIds.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
  return { lines, jobIds };
}

export async function notifyWatchdogSweep(result) {
  const notable = result.recovered > 0 || result.timedOut > 0 || result.alerted > 0 || result.released > 0;
  if (!notable) return;
  if (result.notificationJobIds && result.notificationJobIds.length === 0 && result.recovered === 0
    && result.timedOut === 0 && result.released === 0) return;

  const { lines, jobIds: allJobIds } = summarize(result);
  const eligible = result.notificationJobIds ? new Set([
    ...result.notificationJobIds,
    ...result.jobs.recovery.filter(item => item.outcome === 'timed_out').map(item => item.jobId),
    ...(result.jobs.releasedIds || []),
  ]) : null;
  const jobIds = eligible ? allJobIds.filter(id => eligible.has(id)) : allJobIds;
  const appUrl = appUrlOrNull();
  const attentionUrl = appUrl ? `${appUrl}/admin-console` : null;
  const oldestHours = Math.floor((result.oldestStaleAgeMinutes || 0) / 60);
  const ageLabel = oldestHours >= 48 ? `${Math.floor(oldestHours / 24)}d` : `${oldestHours}h`;
  const subject = result.severity === 'critical'
    ? `[CRITICAL] job stuck ${ageLabel}: ${jobIds.length} job(s) need attention`
    : `LUX Video OS watchdog: ${jobIds.length} job(s) need attention`;
  const textBody = [
    `Watchdog sweep (stale after ${result.staleAfterMinutes} minutes):`,
    ...lines.map((line) => `- ${line}`),
    ...(result.staleJobs || []).filter(job => !eligible || eligible.has(job.jobId))
      .map(job => `- ${job.jobId} (${job.status}): age ${job.ageMinutes}m, stale ${job.staleMinutes}m`),
    jobIds.length ? `Job IDs: ${jobIds.join(', ')}` : null,
    attentionUrl ? `Review in the admin console: ${attentionUrl}` : null,
  ].filter(Boolean).join('\n');
  const htmlBody = `<p>${textBody.replace(/\n/g, '<br>')}</p>`;

  const attempts = [
    sendWatchdogAlertEmail({ subject, html: htmlBody, text: textBody }),
    postWatchdogAlertSlack({ text: `*${subject}*\n${textBody}` }),
  ];
  const outcomes = await Promise.allSettled(attempts);
  for (const outcome of outcomes) {
    // statusCode 501 just means that channel isn't configured -- not a
    // failure worth reporting, same as sendRenderReadyEmail's own gate.
    if (outcome.status === 'rejected' && outcome.reason?.statusCode !== 501) {
      captureJobError(outcome.reason, { stage: 'watchdog_notification' });
      console.warn('::warning::Watchdog notification delivery failed');
    }
  }
}
