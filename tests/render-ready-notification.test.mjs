// sendRenderReadyEmail's config/format/error-handling behavior is pure
// fetch logic, tested the same way as lib/google-oauth.js's tests: mock
// globalThis.fetch, no DB needed. notifyRenderReady's account lookup does
// need a real database, following this repo's convention of skipping
// cleanly (not mocking) when DATABASE_URL isn't configured.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { ensureAccount } from '../db/repositories.js';
import { users } from '../db/schema.js';
import { sendRenderReadyEmail } from '../lib/video-os-notifications.js';
import { notifyRenderReady } from '../lib/video-os-render-notify.js';

const originalFetch = globalThis.fetch;
const originalEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, AUTH_FROM_EMAIL: process.env.AUTH_FROM_EMAIL };

function restore() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('sendRenderReadyEmail refuses to run without Resend configured', async (t) => {
  t.after(restore);
  delete process.env.RESEND_API_KEY;
  delete process.env.AUTH_FROM_EMAIL;
  await assert.rejects(
    sendRenderReadyEmail({ email: 'owner@example.com', jobTitle: 'Demo', appUrl: 'https://video-os.example' }),
    (error) => { assert.equal(error.statusCode, 501); return true; },
  );
});

test('sendRenderReadyEmail posts a correctly-shaped, escaped message to Resend', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: 'email-proof' }), { status: 200 });
  };
  const result = await sendRenderReadyEmail({ email: 'owner@example.com', jobTitle: '<b>Launch</b> Promo', appUrl: 'https://video-os.example' });
  assert.equal(result.id, 'email-proof');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.headers.Authorization, 'Bearer resend-key-proof');
  assert.equal(captured.body.from, 'no-reply@video-os.example');
  assert.deepEqual(captured.body.to, ['owner@example.com']);
  assert.match(captured.body.subject, /Launch/);
  assert.doesNotMatch(captured.body.html, /<b>Launch<\/b>/, 'job title must be HTML-escaped in the email body');
  assert.match(captured.body.html, /&lt;b&gt;Launch&lt;\/b&gt;/);
  assert.match(captured.body.text, /https:\/\/video-os\.example/);
});

test('sendRenderReadyEmail surfaces a sanitized 502 when Resend rejects the message', async (t) => {
  t.after(restore);
  process.env.RESEND_API_KEY = 'resend-key-proof';
  process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
  globalThis.fetch = async () => new Response(JSON.stringify({ name: 'validation_error', message: 'sensitive provider detail' }), { status: 422 });
  await assert.rejects(
    sendRenderReadyEmail({ email: 'owner@example.com', jobTitle: 'Demo', appUrl: 'https://video-os.example' }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.providerCode, 'validation_error');
      assert.doesNotMatch(error.message, /sensitive provider detail/);
      return true;
    },
  );
});

test('notifyRenderReady is a no-op (no fetch call) when the job was not just completed', async (t) => {
  t.after(restore);
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  await notifyRenderReady({ id: 'job-1', accountId: 'acct-1', title: 'Demo' }, { status: 'ready' });
  assert.equal(called, false);
});

let dbAvailable = true;
try { assertDatabaseConfigured(); } catch { dbAvailable = false; }

test(
  'notifyRenderReady sends exactly one email for a freshly-completed job, against a real account',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.RESEND_API_KEY = 'resend-key-proof';
    process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video-os.example';
    t.after(restore);

    const accountId = `test-notify-${crypto.randomUUID()}`;
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });
    await ensureAccount({ accountId, email: 'owner-proof@example.com', name: 'Notify Test', initialCredits: 100 });

    let calls = 0;
    let lastTo;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      lastTo = JSON.parse(options.body).to;
      return new Response(JSON.stringify({ id: 'email-proof' }), { status: 200 });
    };

    const job = { id: 'job-notify-1', accountId, title: 'My Launch Video', correlationId: 'corr-1' };
    await notifyRenderReady(job, { status: 'ready', justCompleted: true });
    assert.equal(calls, 1);
    assert.deepEqual(lastTo, ['owner-proof@example.com']);

    // A workflow-step retry re-running the completion step calls this again
    // with the idempotent-replay shape (no justCompleted) -- must not resend.
    await notifyRenderReady(job, { status: 'ready' });
    assert.equal(calls, 1);
  },
);

test(
  'notifyRenderReady swallows a failing email provider instead of throwing',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.RESEND_API_KEY = 'resend-key-proof';
    process.env.AUTH_FROM_EMAIL = 'no-reply@video-os.example';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video-os.example';
    t.after(restore);

    const accountId = `test-notify-fail-${crypto.randomUUID()}`;
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });
    await ensureAccount({ accountId, email: 'owner-proof@example.com', name: 'Notify Fail Test', initialCredits: 100 });

    globalThis.fetch = async () => new Response('{}', { status: 500 });
    const job = { id: 'job-notify-2', accountId, title: 'My Launch Video', correlationId: 'corr-2' };
    await assert.doesNotReject(notifyRenderReady(job, { status: 'ready', justCompleted: true }));
  },
);
