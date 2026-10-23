// Same testing approach as tests/render-ready-notification.test.mjs: pure
// fetch logic, mocked globalThis.fetch, no DB needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Sentry from '@sentry/node';
import { postWatchdogAlertSlack, sendWatchdogAlertEmail } from '../lib/video-os-notifications.js';
import { claimWatchdogEscalation, notifyWatchdogSweep } from '../lib/video-os-watchdog-notify.js';

test('escalation claims critical once and warn again only after six hours using an injectable store', async () => {
  const claims = new Map();
  const store = async ({ jobId, level, at, intervalMs }) => {
    const key = `${jobId}:${level}`;
    const last = claims.get(key);
    if (last && (level === 'critical' || at - last < intervalMs)) return false;
    claims.set(key, at);
    return true;
  };
  const at = '2026-10-15T00:00:00Z';
  const gate = (jobId, level, hours = 0, env = {}) => claimWatchdogEscalation(jobId, level, {
    store, env, now: () => new Date(Date.parse(at) + hours * 60 * 60_000),
  });
  assert.equal(await gate('job-a', 'critical'), true);
  assert.equal(await gate('job-a', 'critical', 24), false);
  assert.equal(await gate('job-b', 'critical'), true);
  // The real store's critical marker covers warn during the same window.
  assert.equal(await gate('job-a', 'warn'), true);
  assert.equal(await gate('job-a', 'warn', 5.99), false);
  assert.equal(await gate('job-a', 'warn', 6), true);
  assert.equal(await gate('job-a', 'warn', 7, { VIDEO_OS_WATCHDOG_RENOTIFY_HOURS: '2' }), false);
  assert.equal(await gate('job-a', 'warn', 8, { VIDEO_OS_WATCHDOG_RENOTIFY_HOURS: '2' }), true);
  assert.equal(await gate('bad/id', 'critical'), false);
});

test('terminal release and timeout notify even with an empty escalation ID list', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'test-only';
  process.env.AUTH_FROM_EMAIL = 'ops@example.invalid';
  process.env.WATCHDOG_ALERT_EMAIL = 'ops@example.invalid';
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ id: 'test' }), { status: 200 });
  };
  await notifyWatchdogSweep(cleanResult({ released: 1, notificationJobIds: [],
    jobs: { recovery: [], alertedIds: [], releasedIds: ['released-job'] } }));
  await notifyWatchdogSweep(cleanResult({ timedOut: 1, notificationJobIds: [],
    jobs: { recovery: [{ jobId: 'timeout-job', outcome: 'timed_out' }], alertedIds: [], releasedIds: [] } }));
  assert.equal(sent.length, 2);
  assert.match(sent[0], /released-job/);
  assert.match(sent[1], /timeout-job/);
});

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

test('zero-job watchdog sweep sends no email, Slack, or Sentry notification', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'test-only';
  process.env.AUTH_FROM_EMAIL = 'ops@example.invalid';
  process.env.WATCHDOG_ALERT_EMAIL = 'ops@example.invalid';
  process.env.WATCHDOG_SLACK_WEBHOOK_URL = 'https://hooks.slack.example/services/T/B/X';
  const calls = { email: 0, slack: 0, sentry: 0 };
  globalThis.fetch = async (url) => {
    if (url === 'https://api.resend.com/emails') calls.email++;
    if (url === process.env.WATCHDOG_SLACK_WEBHOOK_URL) calls.slack++;
    return new Response(JSON.stringify({ id: 'test' }), { status: 200 });
  };
  t.mock.method(Sentry.Scope.prototype, 'captureException', () => { calls.sentry++; });

  await notifyWatchdogSweep(cleanResult({
    recovered: 0,
    timedOut: 0,
    released: 0,
    alerted: 1,
    notificationJobIds: [],
    jobs: { recovery: [], alertedIds: ['j1'], releasedIds: [] },
  }));

  assert.deepEqual(calls, { email: 0, slack: 0, sentry: 0 });
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

test('notifyWatchdogSweep treats an auto-released reserved-only job as notable and reports it distinctly from a timed-out or alerted one', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  let called = false;
  let body = '';
  globalThis.fetch = async (url, options) => {
    called = true;
    body = String(options?.body || '');
    return new Response(JSON.stringify({ id: 'proof' }), { status: 200 });
  };
  const result = cleanResult({
    released: 1,
    jobs: { recovery: [], alertedIds: [], releasedIds: ['job-reserved-only'] },
  });
  await notifyWatchdogSweep(result);
  assert.equal(called, true, 'a sweep that only auto-released a job must still notify -- it is notable, not a clean/silent sweep');
  assert.match(body, /reserved but never dispatched/, 'the summary must explain what happened, not just that something did');
  assert.match(body, /job-reserved-only/, 'the released job\'s ID must be included in the notification');
});

test('notification distinguishes failed provider recovery from ambiguous submission', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  process.env.WATCHDOG_ALERT_EMAIL = 'ariel@luxmarketingcompany.com';
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  let body = '';
  globalThis.fetch = async (_url, options) => {
    body = String(options?.body || '');
    return new Response(JSON.stringify({ id: 'proof' }), { status: 200 });
  };
  await notifyWatchdogSweep(cleanResult({
    alerted: 3,
    jobs: { recovery: [
      { jobId: 'job-provider', outcome: 'recovery_failed' },
      { jobId: 'job-contained', outcome: 'recovery_failed', status: 'finish_contained' },
    ], alertedIds: ['job-provider', 'job-contained', 'job-ambiguous'] },
  }));
  assert.match(body, /provider state was not confirmed/);
  assert.match(body, /provider media ready but finishing was contained/);
  assert.match(body, /no confirmed provider engagement/);
  assert.match(body, /credits remain reserved/);
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

test('critical stale job notification leads with the oldest age and includes both job ages', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'FAKE1';
  process.env.AUTH_FROM_EMAIL = 'ops@example.invalid';
  process.env.WATCHDOG_ALERT_EMAIL = 'ops@example.invalid';
  delete process.env.WATCHDOG_SLACK_WEBHOOK_URL;
  let email;
  globalThis.fetch = async (_url, options) => {
    email = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'FAKE1' }), { status: 200 });
  };
  await notifyWatchdogSweep(cleanResult({ alerted: 2, severity: 'critical', oldestStaleAgeMinutes: 30 * 24 * 60,
    staleJobs: [
      { jobId: 'job-2305', status: 'workflow_started', ageMinutes: 30 * 24 * 60, staleMinutes: 20 },
      { jobId: 'job-new', status: 'provider_submitting', ageMinutes: 60, staleMinutes: 35 },
    ],
    jobs: { recovery: [], alertedIds: ['job-new', 'job-2305'] } }));
  assert.match(email.subject, /^\[CRITICAL\] job stuck 30d/);
  assert.match(email.text, /job-2305 \(workflow_started\): age 43200m, stale 20m/);
  assert.match(email.text, /Job IDs: job-2305, job-new/);
});
