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
  if (result.recovered) lines.push(`${result.recovered} job(s) recovered automatically.`);
  if (result.timedOut) lines.push(`${result.timedOut} job(s) timed out and were failed, with credits released back to the customer.`);
  if (result.released) lines.push(`${result.released} job(s) were reserved but never dispatched, and had their credits released automatically (no provider was ever contacted).`);
  if (result.alerted) lines.push(`${result.alerted} job(s) are stuck with no confirmed provider engagement and need manual review.`);
  const jobIds = [
    ...result.jobs.recovery.filter((r) => r.outcome === 'timed_out').map((r) => r.jobId),
    ...(result.jobs.releasedIds || []),
    ...result.jobs.alertedIds,
  ];
  return { lines, jobIds };
}

export async function notifyWatchdogSweep(result) {
  const notable = result.recovered > 0 || result.timedOut > 0 || result.alerted > 0 || result.released > 0;
  if (!notable) return;

  const { lines, jobIds } = summarize(result);
  const appUrl = appUrlOrNull();
  const attentionUrl = appUrl ? `${appUrl}/admin-console` : null;
  const subject = `LUX Video OS watchdog: ${jobIds.length} job(s) need attention`;
  const textBody = [
    `Watchdog sweep (stale after ${result.staleAfterMinutes} minutes):`,
    ...lines.map((line) => `- ${line}`),
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
    }
  }
}
