// Live integration tests against a real (non-production) Postgres target,
// same convention as tests/video-os-watchdog.test.mjs -- skips cleanly
// without DATABASE_URL. Stripe itself is never called for real: every
// scenario injects its own fake `stripe.checkout.sessions.list` via
// reconcileStripePayments({ stripe }), so these tests don't need
// STRIPE_SECRET_KEY and never touch the network for the Stripe side of the
// comparison. listStripeEventsSince()/listStripeCreditTransactionsSince()
// (db/repositories.js) do real, unscoped-by-account DB queries though, so a
// shared/non-empty test database could contain unrelated stripeEvents/
// creditTransactions rows from other runs -- every assertion below is
// therefore scoped to mismatches for *this test's own* Stripe session id
// (a fresh crypto.randomUUID()-derived id every time, so collision with
// real or other-test data is not a realistic concern), never to a global
// mismatchCount/sessionsChecked of zero. See
// tests/video-os-stripe-reconciliation-notify.test.mjs for "a clean run
// never notifies," which is proven directly against notifyStripeReconciliation()
// instead, for exactly this reason.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { ensureAccount, issueStripeCredit } from '../db/repositories.js';
import { stripeEvents, users } from '../db/schema.js';
import { reconcileStripePayments } from '../lib/video-os-stripe-reconciliation.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

const originalFetch = globalThis.fetch;

// reconcileStripePayments() fires a best-effort notification on any
// mismatch (lib/video-os-stripe-reconciliation-notify.js). Scenarios (b)
// and (c) below deliberately produce mismatches, so this stub exists
// purely to guarantee no real Slack/email request ever leaves the process
// during this suite, regardless of what RESEND_API_KEY/
// WATCHDOG_SLACK_WEBHOOK_URL happen to be set to in the environment these
// tests run in. The notification behavior itself is covered by
// tests/video-os-stripe-reconciliation-notify.test.mjs.
function stubFetch() {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function fakeStripeClient(sessions) {
  return {
    checkout: {
      sessions: {
        async list({ limit } = {}) {
          return { data: sessions.slice(0, limit ?? sessions.length), has_more: false };
        },
      },
    },
  };
}

function fakeSession({ id, accountId, packageId = 'credits_500', paymentStatus = 'paid' }) {
  return {
    id,
    payment_status: paymentStatus,
    created: Math.floor(Date.now() / 1000),
    metadata: { packageId, accountId },
    client_reference_id: accountId,
  };
}

function mismatchesFor(result, sessionId) {
  return result.mismatches.filter((mismatch) => mismatch.sessionId === sessionId);
}

// Keyed by sessionId (the unique column reconcileStripePayments() itself
// looks events up by -- see eventBySessionId in
// lib/video-os-stripe-reconciliation.js), not stripeEventId: that way "no
// event row exists for this session" (scenario b) and "reconciliation
// didn't mint/alter one" (every scenario) are both provable with the same
// helper, not just "the specific row I happened to create is unchanged."
async function snapshot(accountId, sessionId) {
  const account = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
  const transactions = await database().query.creditTransactions.findMany({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
  const [event] = await database().select().from(stripeEvents).where(eq(stripeEvents.sessionId, sessionId)).limit(1);
  return { account, transactions, event };
}

async function makeAccount(t, label) {
  const accountId = `test-stripe-recon-${label}-${crypto.randomUUID()}`;
  t.after(async () => {
    // stripeEvents.accountId has no onDelete cascade (see db/schema.js) --
    // must be cleared explicitly before the user row, or the delete below
    // would fail (harmlessly, since it's swallowed) and leak the row.
    await database().delete(stripeEvents).where(eq(stripeEvents.accountId, accountId)).catch(() => {});
    await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
  });
  await ensureAccount({ accountId, email: null, name: `Stripe Reconciliation Test (${label})`, initialCredits: 0 });
  return accountId;
}

test(
  '(a) a paid session with a matching processed stripeEvents row and matching creditTransactions row produces zero mismatches for that session',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    t.after(restoreFetch);
    stubFetch();
    const accountId = await makeAccount(t, 'clean');
    const sessionId = `cs_test_recon_clean_${crypto.randomUUID()}`;
    const stripeEventId = `evt_recon_clean_${crypto.randomUUID()}`;

    const applied = await issueStripeCredit({
      stripeEventId, eventType: 'checkout.session.completed', livemode: false,
      payloadSha256: crypto.createHash('sha256').update(sessionId).digest('hex'),
      accountId, sessionId, credits: 500,
    });
    assert.equal(applied.applied, true, 'setup: the credit grant itself must have applied');

    const before = await snapshot(accountId, sessionId);

    const session = fakeSession({ id: sessionId, accountId, packageId: 'credits_500' });
    const result = await reconcileStripePayments({ stripe: fakeStripeClient([session]), lookbackHours: 48 });

    assert.equal(result.sessionsChecked, 1);
    assert.deepEqual(mismatchesFor(result, sessionId), [], 'a correctly-recorded, correctly-sized grant must produce no mismatch at all');

    const after = await snapshot(accountId, sessionId);
    assert.deepEqual(after, before, 'reconciliation must never write anything, clean run or not');
  },
);

test(
  '(b) a paid session with no matching stripeEvents/creditTransactions row is flagged as a lost webhook',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    t.after(restoreFetch);
    stubFetch();
    const accountId = await makeAccount(t, 'lost');
    const sessionId = `cs_test_recon_lost_${crypto.randomUUID()}`;

    // Deliberately never call issueStripeCredit() -- this is the exact
    // shape of a webhook that never arrived, or was received but never
    // finished processing: Stripe has a real paid session, but nothing in
    // this app's own stripeEvents/creditTransactions tables reflects it.
    const before = await snapshot(accountId, sessionId);
    assert.equal(before.event, undefined, 'setup: no stripeEvents row should exist yet for this session');

    const session = fakeSession({ id: sessionId, accountId, packageId: 'credits_500' });
    const result = await reconcileStripePayments({ stripe: fakeStripeClient([session]), lookbackHours: 48 });

    assert.equal(result.sessionsChecked, 1);
    const mismatches = mismatchesFor(result, sessionId);
    assert.equal(mismatches.length, 1, 'the paid-but-uncredited session must produce exactly one mismatch');
    assert.equal(mismatches[0].type, 'missing_grant');
    assert.equal(mismatches[0].accountId, accountId);
    assert.match(mismatches[0].detail, /webhook may never have arrived/);

    const after = await snapshot(accountId, sessionId);
    assert.deepEqual(after, before, 'detecting a lost webhook must never itself write a repair -- no event/transaction row may be created by the sweep');
    assert.equal(after.event, undefined, 'the sweep must not mint a stripeEvents row just because it detected a gap');
    assert.equal(after.account.balance, 0, 'no credit must ever be granted by the reconciliation sweep itself');
  },
);

test(
  '(c) a paid session whose credited amount does not match its expected package is flagged, not silently accepted',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    t.after(restoreFetch);
    stubFetch();
    const accountId = await makeAccount(t, 'amount');
    const sessionId = `cs_test_recon_amount_${crypto.randomUUID()}`;
    const stripeEventId = `evt_recon_amount_${crypto.randomUUID()}`;

    // credits_500 should grant 500 (see PACKAGE_CREDITS in
    // api/video-os-lite/stripe-webhook-v2.js) -- 400 simulates a bug or a
    // stale package mapping that under/over-credited a real payment.
    const applied = await issueStripeCredit({
      stripeEventId, eventType: 'checkout.session.completed', livemode: false,
      payloadSha256: crypto.createHash('sha256').update(sessionId).digest('hex'),
      accountId, sessionId, credits: 400,
    });
    assert.equal(applied.applied, true, 'setup: the (wrong-amount) credit grant itself must have applied');

    const before = await snapshot(accountId, sessionId);

    const session = fakeSession({ id: sessionId, accountId, packageId: 'credits_500' });
    const result = await reconcileStripePayments({ stripe: fakeStripeClient([session]), lookbackHours: 48 });

    assert.equal(result.sessionsChecked, 1);
    const mismatches = mismatchesFor(result, sessionId);
    assert.equal(mismatches.length, 1, 'a wrong-sized grant must produce exactly one mismatch');
    assert.equal(mismatches[0].type, 'amount_mismatch');
    assert.equal(mismatches[0].accountId, accountId);
    assert.match(mismatches[0].detail, /Credited 400 but this session's package should have granted 500/);

    const after = await snapshot(accountId, sessionId);
    assert.deepEqual(after, before, 'detecting a wrong-sized grant must never itself correct the balance -- report only, per docs/P0-RELEASE-GATE.md');
    assert.equal(after.account.balance, 400, 'the (wrong) 400 credited earlier must remain exactly as it was, untouched by the sweep');
  },
);

test(
  '(d) nothing is ever auto-repaired across a mixed batch: clean, lost-webhook, and wrong-amount sessions checked together leave the DB byte-for-byte identical',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    t.after(restoreFetch);
    stubFetch();
    const cleanAccountId = await makeAccount(t, 'mixed-clean');
    const lostAccountId = await makeAccount(t, 'mixed-lost');
    const amountAccountId = await makeAccount(t, 'mixed-amount');

    const cleanSessionId = `cs_test_recon_mixed_clean_${crypto.randomUUID()}`;
    const cleanEventId = `evt_recon_mixed_clean_${crypto.randomUUID()}`;
    await issueStripeCredit({
      stripeEventId: cleanEventId, eventType: 'checkout.session.completed', livemode: false,
      payloadSha256: crypto.createHash('sha256').update(cleanSessionId).digest('hex'),
      accountId: cleanAccountId, sessionId: cleanSessionId, credits: 1000,
    });

    const lostSessionId = `cs_test_recon_mixed_lost_${crypto.randomUUID()}`;

    const amountSessionId = `cs_test_recon_mixed_amount_${crypto.randomUUID()}`;
    const amountEventId = `evt_recon_mixed_amount_${crypto.randomUUID()}`;
    await issueStripeCredit({
      stripeEventId: amountEventId, eventType: 'checkout.session.completed', livemode: false,
      payloadSha256: crypto.createHash('sha256').update(amountSessionId).digest('hex'),
      accountId: amountAccountId, sessionId: amountSessionId, credits: 1_500,
    });

    const before = {
      clean: await snapshot(cleanAccountId, cleanSessionId),
      lost: await snapshot(lostAccountId, lostSessionId),
      amount: await snapshot(amountAccountId, amountSessionId),
    };

    const sessions = [
      fakeSession({ id: cleanSessionId, accountId: cleanAccountId, packageId: 'credits_1000' }),
      fakeSession({ id: lostSessionId, accountId: lostAccountId, packageId: 'credits_500' }),
      fakeSession({ id: amountSessionId, accountId: amountAccountId, packageId: 'credits_2000' }),
    ];
    const result = await reconcileStripePayments({ stripe: fakeStripeClient(sessions), lookbackHours: 48 });

    assert.equal(result.sessionsChecked, 3);
    assert.deepEqual(mismatchesFor(result, cleanSessionId), [], 'the clean session in this batch must still report zero mismatches');
    assert.equal(mismatchesFor(result, lostSessionId)[0]?.type, 'missing_grant');
    assert.equal(mismatchesFor(result, amountSessionId)[0]?.type, 'amount_mismatch');

    const after = {
      clean: await snapshot(cleanAccountId, cleanSessionId),
      lost: await snapshot(lostAccountId, lostSessionId),
      amount: await snapshot(amountAccountId, amountSessionId),
    };
    assert.deepEqual(after, before, 'a single reconciliation run touching a clean, a lost-webhook, and a wrong-amount session together must leave every one of their rows exactly as found -- detection only, never repair');
  },
);
