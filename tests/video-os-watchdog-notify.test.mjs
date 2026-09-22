// Same testing approach as tests/render-ready-notification.test.mjs: pure
// fetch logic, mocked globalThis.fetch, no DB needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { postWatchdogAlertSlack, sendWatchdogAlertEmail } from '../lib/video-os-notifications.js';
import { notifyWatchdogSweep } from '../lib/video-os-watchdog-notify.js';

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
    staleAfterMinutes: 30,
    actionableFound: 0,
    ambiguousFound: 0,
    recovered: 0,
    timedOut: 0,
    alerted: 0,
    jobs: { recovery: [], alertedIds: [] },
    ...overrides,
  };
}

test('sendWatchdogAlertEmail refuses to run without WATCHDOG_ALERT_EMAIL configured, even if Resend itself is', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  delete process.env.WATCHDOG_ALERT_EMAIL;
  await assert.rejects(
    sendWatchdogAlertEmail({ subject: 'Test', html: '<p>x</p>', text: 'x' }),
    (error) => { assert.equal(error.statusCode, 501); return true; },
  );
});

test('sendWatchdogAlertEmail posts a correctly-shaped message to Resend when configured', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'email-proof' }), { status: 200 });
  };
  const result = await sendWatchdogAlertEmail({ subject: 'Watchdog: 2 job(s) need attention', html: '<p>hi</p>', text: 'hi' });
  assert.equal(result.id, 'email-proof');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.deepEqual(captured.body.to, ['ariel@luxmarketingcompany.com']);
  assert.equal(captured.body.subject, 'Watchdog: 2 job(s) need attention');
});

test('postWatchdogAlertSlack refuses to run without WATCHDOG_SLACK_WEBHOOK_URL configured', async (t) => {
  t.after(restore);
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  await assert.rejects(
    postWatchdogAlertSlack({ text: 'x' }),
    (error) => { assert.equal(error.statusCode, 501); return true; },
  );
});

test('postWatchdogAlertSlack posts to the configured webhook URL', async (t) => {
  t.after(restore);
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response('ok', { status: 200 });
  };
  await postWatchdogAlertSlack({ text: 'hello' });
  assert.equal(captured.url, 'https://hooks.slack.example/services/T/B/X');
  assert.equal(captured.body.text, 'hello');
});

test('notifyWatchdogSweep is a no-op on a clean sweep, even with both channels configured', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  await notifyWatchdogSweep(cleanResult());
  assert.equal(called, false, 'a sweep that found nothing must not trigger any notification');
});

test('notifyWatchdogSweep sends to both configured channels when the sweep is notable', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  delete process.env.VIDEO_OS_PUBLIC_ORIGIN;
  const calledUrls = [];
  globalThis.fetch = async (url, options) => {
    calledUrls.push(url);
    return new Response(JSON.stringify({ id: 'proof' }), { status: 200 });
  };
  const result = cleanResult({
    timedOut: 1,
    alerted: 1,
    jobs: { recovery: [{ jobId: 'job-a', outcome: 'timed_out' }], alertedIds: ['job-b'] },
  });
  await notifyWatchdogSweep(result);
  assert.deepEqual(calledUrls.sort(), ['https://api.resend.com/emails', 'https://hooks.slack.example/services/T/B/X'].sort());
});

test('notifyWatchdogSweep never throws when only one channel is configured (the other 501s)', async (t) => {
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
  await notifyWatchdogSweep(cleanResult({ alerted: 1, jobs: { recovery: [], alertedIds: ['job-b'] } }));
  assert.equal(emailSent, true, 'the configured channel should still fire even though Slack is unset');
});

test('notifyWatchdogSweep never throws when a configured channel itself fails', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  globalThis.fetch = async () => new Response('server error', { status: 500 });
  await assert.doesNotReject(notifyWatchdogSweep(cleanResult({ alerted: 1, jobs: { recovery: [], alertedIds: ['job-b'] } })));
});
