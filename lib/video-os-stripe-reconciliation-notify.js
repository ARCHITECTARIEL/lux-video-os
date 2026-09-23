// Ops notification for lib/video-os-stripe-reconciliation.js's sweep --
// same shape as lib/video-os-watchdog-notify.js (best-effort, both channels
// independent, silent on a clean run), reusing the same generic Resend/
// Slack senders rather than duplicating them: a payment mismatch is exactly
// as much "something a human needs to see" as a stuck render job.
import { captureJobError } from './video-os-observability.js';
import { postWatchdogAlertSlack, sendWatchdogAlertEmail } from './video-os-notifications.js';
import { publicOrigin } from './video-os-security.js';

function appUrlOrNull() {
  try {
    return publicOrigin();
  } catch {
    return null;
  }
}

function summarizeMismatch(mismatch) {
  return `[${mismatch.type}] session ${mismatch.sessionId}${mismatch.accountId ? ` (account ${mismatch.accountId})` : ''}: ${mismatch.detail}`;
}

export async function notifyStripeReconciliation(result) {
  if (!result.mismatchCount) return;

  const appUrl = appUrlOrNull();
  const attentionUrl = appUrl ? `${appUrl}/admin-console` : null;
  const subject = `LUX Video OS: ${result.mismatchCount} Stripe reconciliation mismatch(es)`;
  const textBody = [
    `Stripe reconciliation (lookback ${result.lookbackHours}h, ${result.sessionsChecked} paid session(s) and ${result.creditTransactionsChecked} Stripe credit transaction(s) checked):`,
    ...result.mismatches.map((mismatch) => `- ${summarizeMismatch(mismatch)}`),
    'These are reported only, never auto-repaired -- resolve and record a receipt per docs/P0-RELEASE-GATE.md.',
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
    // failure worth reporting, same gate as every other best-effort
    // notification path in this codebase.
    if (outcome.status === 'rejected' && outcome.reason?.statusCode !== 501) {
      captureJobError(outcome.reason, { stage: 'stripe_reconciliation_notification' });
    }
  }
}
