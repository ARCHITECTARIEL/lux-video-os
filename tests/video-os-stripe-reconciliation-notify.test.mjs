// Same testing approach as tests/video-os-watchdog-notify.test.mjs: pure
// fetch logic, mocked globalThis.fetch, no DB needed. Covers
// notifyStripeReconciliation() in isolation from reconcileStripePayments()
// itself (see tests/video-os-stripe-reconciliation.test.mjs for the
// DB-backed sweep logic), which is also the only reliable way to prove "a
// clean reconciliation never notifies" without depending on a real
// database being entirely free of unrelated Stripe rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { postWatchdogAlertSlack, sendWatchdogAlertEmail } from '../lib/video-os-notifications.js';
import { notifyStripeReconciliation } from '../lib/video-os-stripe-reconciliation-notify.js';

const originalFetch = globalThis.fetch;
const ENV_KEYS = ['RESEND_API_KEY', 'AUTH_FROM_EMAIL', 'WATCHDOG_ALERT_EMAIL', 'WATCHDOG_SLACK_WEBHOOK_URL', 'VIDEO_OS_PUBLIC_ORIGIN'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restore() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function cleanResult(overrides = {}) {
  return {
    lookbackHours: 48,
    sessionsChecked: 3,
    creditTransactionsChecked: 3,
    mismatchCount: 0,
    mismatches: [],
    ...overrides,
  };
}

function mismatchResult(overrides = {}) {
  return cleanResult({
    mismatchCount: 1,
    mismatches: [{ type: 'missing_grant', sessionId: 'cs_test_proof_session', accountId: 'test-account-proof', detail: 'No stripeEvents row recorded for this paid session -- the webhook may never have arrived.' }],
    ...overrides,
  });
}

test('notifyStripeReconciliation is a no-op on a clean run (mismatchCount 0), even with both channels configured', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  await notifyStripeReconciliation(cleanResult());
  assert.equal(called, false, 'a reconciliation run that found nothing must not trigger any notification');
});

test('notifyStripeReconciliation sends to both configured channels when mismatches are found', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  delete process.env.VIDEO_OS_PUBLIC_ORIGIN;
  const calledUrls = [];
  let body = '';
  globalThis.fetch = async (url, options) => {
    calledUrls.push(url);
    body = String(options?.body || '');
    return new Response(JSON.stringify({ id: 'proof' }), { status: 200 });
  };
  await notifyStripeReconciliation(mismatchResult());
  assert.deepEqual(calledUrls.sort(), ['https://api.resend.com/emails', 'https://hooks.slack.example/services/T/B/X'].sort());
  assert.match(body, /cs_test_proof_session/, 'the mismatched session id must be included in the notification');
  assert.match(body, /never auto-repaired/, 'the notification must make clear this is report-only, per docs/P0-RELEASE-GATE.md');
});

test('notifyStripeReconciliation never throws when only one channel is configured (the other 501s)', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  let emailSent = false;
  globalThis.fetch = async (url) => {
    if (url === 'https://api.resend.com/emails') emailSent = true;
    return new Response(JSON.stringify({ id: 'proof' }), { status: 200 });
  };
  await notifyStripeReconciliation(mismatchResult());
  assert.equal(emailSent, true, 'the configured channel should still fire even though Slack is unset');
});

test('notifyStripeReconciliation never throws when neither channel is configured', async (t) => {
  t.after(restore);
  delete process.env.RESEND_API_KEY;
  delete process.env.WATCHDOG_ALERT_EMAIL;
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  await assert.doesNotReject(notifyStripeReconciliation(mismatchResult()));
  assert.equal(called, false, 'neither channel is configured, so fetch should never be reached at all');
});

test('notifyStripeReconciliation never throws when a configured channel itself fails', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  await assert.doesNotReject(notifyStripeReconciliation(mismatchResult()));
});

// Sanity-checks that this module really is reusing lib/video-os-notifications.js's
// generic senders rather than a silently-diverged copy -- same direct-import
// proof as tests/video-os-watchdog-notify.test.mjs runs on those senders.
test('the underlying senders this module depends on behave as expected in isolation', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'email-proof' }), { status: 200 });
  };
  const result = await sendWatchdogAlertEmail({ subject: 'Stripe reconciliation: 1 mismatch(es)', html: '<p>hi</p>', text: 'hi' });
  assert.equal(result.id, 'email-proof');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.deepEqual(captured.body.to, ['ariel@luxmarketingcompany.com']);

  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  await assert.rejects(postWatchdogAlertSlack({ text: 'x' }), (error) => { assert.equal(error.statusCode, 501); return true; });
});
