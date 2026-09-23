// Closes a real gap found in a 2026-09-23 system-design audit: docs/P0-RELEASE-GATE.md's
// operating contract requires "Reconcile daily: ... every Stripe event has
// at most one applied grant ... Report mismatches and repair only with a
// separate receipt" -- but until this module, nothing ever independently
// compared Stripe's own record of what was paid against this app's own
// stripeEvents/creditTransactions tables. issueStripeCredit() (db/
// repositories.js) is correct and idempotent on the *inbound* webhook path,
// but a reconciliation job exists precisely so a missed/lost webhook,
// Stripe outage, or a bug in that path someday doesn't go unnoticed
// indefinitely. This must exist and be proven correct before
// VIDEO_OS_BILLING_ENABLED or real STRIPE_* keys ever go live -- as of this
// module's introduction, neither has happened yet.
//
// Same conservative philosophy as lib/video-os-watchdog.js's ambiguous
// bucket: this only detects and reports. It never writes to
// creditAccounts/creditTransactions/stripeEvents -- "repair only with a
// separate receipt" per the gate doc means a human decides and acts, not
// this sweep.
import Stripe from 'stripe';
import { listStripeCreditTransactionsSince, listStripeEventsSince } from '../db/repositories.js';
import { PACKAGE_CREDITS } from '../api/video-os-lite/stripe-webhook-v2.js';
import { captureJobError } from './video-os-observability.js';
import { notifyStripeReconciliation } from './video-os-stripe-reconciliation-notify.js';

export const STRIPE_RECONCILIATION_LOOKBACK_HOURS_DEFAULT = 48;

function realStripeClient() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) throw Object.assign(new Error('Stripe reconciliation is not configured. Add STRIPE_SECRET_KEY.'), { statusCode: 503 });
  return new Stripe(secret);
}

// Paginated, bounded fetch of every Checkout Session created within the
// lookback window -- not just completed ones, so a session that was
// created but never paid is visibly absent from credited-mismatches (it
// should be), while one that *was* paid is checked regardless of which
// event type technically fired.
async function listStripeSessionsSince(stripe, sinceUnixSeconds, limit) {
  const sessions = [];
  let startingAfter;
  while (sessions.length < limit) {
    const page = await stripe.checkout.sessions.list({
      created: { gte: sinceUnixSeconds },
      limit: Math.min(100, limit - sessions.length),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    sessions.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return sessions;
}

function expectedCreditsForSession(session) {
  return PACKAGE_CREDITS[session.metadata?.packageId] ?? null;
}

export async function reconcileStripePayments({
  stripe,
  lookbackHours = STRIPE_RECONCILIATION_LOOKBACK_HOURS_DEFAULT,
  limit = 500,
} = {}) {
  const client = stripe || realStripeClient();
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const sinceUnixSeconds = Math.floor(since.getTime() / 1000);

  const [sessions, events, creditTransactions] = await Promise.all([
    listStripeSessionsSince(client, sinceUnixSeconds, limit),
    listStripeEventsSince(since, limit),
    listStripeCreditTransactionsSince(since, limit),
  ]);

  const eventBySessionId = new Map(events.filter((event) => event.sessionId).map((event) => [event.sessionId, event]));
  const creditTxBySessionId = new Map(creditTransactions.map((tx) => [tx.sourceId, tx]));
  const paidSessionById = new Map(sessions.filter((session) => session.payment_status === 'paid').map((session) => [session.id, session]));

  const mismatches = [];

  // Forward direction: every real, paid Stripe session must have a
  // processed event and a matching, correctly-sized credit grant.
  for (const session of paidSessionById.values()) {
    const event = eventBySessionId.get(session.id);
    const tx = creditTxBySessionId.get(session.id);
    const expectedCredits = expectedCreditsForSession(session);
    if (!event || event.status !== 'processed' || !tx) {
      mismatches.push({
        type: 'missing_grant', sessionId: session.id, accountId: session.metadata?.accountId || session.client_reference_id || null,
        detail: !event ? 'No stripeEvents row recorded for this paid session -- the webhook may never have arrived.'
          : event.status !== 'processed' ? `stripeEvents row exists but is still '${event.status}', not 'processed'.`
          : 'stripeEvents row is processed but no matching creditTransactions row exists.',
      });
      continue;
    }
    if (expectedCredits === null) {
      mismatches.push({ type: 'unknown_package', sessionId: session.id, accountId: session.metadata?.accountId || null, detail: `Session metadata.packageId ('${session.metadata?.packageId}') does not match any known package.` });
      continue;
    }
    if (tx.amount !== expectedCredits) {
      mismatches.push({ type: 'amount_mismatch', sessionId: session.id, accountId: tx.accountId, detail: `Credited ${tx.amount} but this session's package should have granted ${expectedCredits}.` });
    }
  }

  // Reverse direction: every credit this app believes came from Stripe must
  // correspond to a real, paid Stripe session -- should be structurally
  // impossible given stripe-webhook-v2.js's own verification, but that's
  // exactly the invariant a reconciliation job exists to independently
  // confirm rather than assume.
  for (const tx of creditTransactions) {
    const session = paidSessionById.get(tx.sourceId);
    if (!session) {
      mismatches.push({ type: 'unverified_credit', sessionId: tx.sourceId, accountId: tx.accountId, detail: 'A creditTransactions row claims this Stripe session, but no matching paid session was found in Stripe for the lookback window.' });
    }
  }

  const result = {
    lookbackHours,
    sessionsChecked: paidSessionById.size,
    creditTransactionsChecked: creditTransactions.length,
    mismatchCount: mismatches.length,
    mismatches,
  };

  // Best-effort, same reasoning as runWatchdogSweep's own notification
  // call: a broken/unconfigured notification channel must never fail the
  // reconciliation run itself.
  try {
    await notifyStripeReconciliation(result);
  } catch (error) {
    captureJobError(error, { stage: 'stripe_reconciliation_notification' });
  }

  return result;
}
