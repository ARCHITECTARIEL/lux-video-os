// HTTP-handler-level test for routes/video-os-lite/admin.js, same
// request()/response() mock convention as tests/standard-route-http.test.mjs.
// Skips cleanly without DATABASE_URL, same as the other live-DB route tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { claimWorkflowStart, ensureAccount, markJobFailedAndRelease, reserveRender } from '../db/repositories.js';
import { users } from '../db/schema.js';
import adminHandler from '../routes/video-os-lite/admin.js';
import { makeSession } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

function request({ url, cookie, headers = {} }) {
  return {
    method: 'GET',
    url,
    headers: { cookie: cookie ? `vos_admin=${encodeURIComponent(cookie)}` : undefined, ...headers },
    async *[Symbol.asyncIterator]() {},
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ? JSON.parse(body) : undefined; },
  };
}

test('admin route rejects requests with neither a valid admin cookie nor bearer token', async () => {
  const res = response();
  await adminHandler(request({ url: '/api/video-os-lite/admin' }), res);
  assert.equal(res.statusCode, 401);
});

test('admin route accepts VIDEO_OS_ADMIN_TOKEN as a bearer token', async () => {
  const original = process.env.VIDEO_OS_ADMIN_TOKEN;
  process.env.VIDEO_OS_ADMIN_TOKEN = 'proof-admin-token';
  try {
    const res = response();
    await adminHandler(request({ url: '/api/video-os-lite/admin?operation=jobs', headers: { authorization: 'Bearer proof-admin-token' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
    else process.env.VIDEO_OS_ADMIN_TOKEN = original;
  }
});

test('admin route rejects an unknown operation', async () => {
  const original = process.env.VIDEO_OS_ADMIN_TOKEN;
  process.env.VIDEO_OS_ADMIN_TOKEN = 'proof-admin-token';
  try {
    const res = response();
    await adminHandler(request({ url: '/api/video-os-lite/admin?operation=not-a-real-operation', headers: { authorization: 'Bearer proof-admin-token' } }), res);
    assert.equal(res.statusCode, 400);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
    else process.env.VIDEO_OS_ADMIN_TOKEN = original;
  }
});

test('job-events without a jobId is a clean 400, not a crash', async () => {
  const original = process.env.VIDEO_OS_ADMIN_TOKEN;
  process.env.VIDEO_OS_ADMIN_TOKEN = 'proof-admin-token';
  try {
    const res = response();
    await adminHandler(request({ url: '/api/video-os-lite/admin?operation=job-events', headers: { authorization: 'Bearer proof-admin-token' } }), res);
    assert.equal(res.statusCode, 400);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
    else process.env.VIDEO_OS_ADMIN_TOKEN = original;
  }
});

test(
  'a real vos_admin session cookie authorizes overview/attention/accounts/job-events against real data',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
    if (!originalSecret) process.env.VIDEO_OS_SESSION_SECRET = 'admin-route-http-test-secret-with-adequate-length';
    const adminCookie = makeSession('admin', 'owner@example.invalid', 60 * 60);

    const accountId = `test-admin-route-${crypto.randomUUID()}`;
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
      if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    });
    await ensureAccount({ accountId, email: null, name: 'Admin Route Test', initialCredits: 100 });
    const jobId = `job-admin-route-test-${crypto.randomUUID()}`;
    await reserveRender({ jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-admin-route-test', provider: 'sadtalker', title: 'Admin Route Test', format: 'vertical', costCredits: 10, input: {} });
    await claimWorkflowStart(jobId);
    await markJobFailedAndRelease(jobId, 'PROVIDER_SUBMIT', 'Simulated for admin route test.');

    await t.test('operation=overview', async () => {
      const res = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=overview', cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.body.overview.users.total, 'number');
      assert.equal(typeof res.body.overview.reconciliation.stuckJobs, 'number');
    });

    await t.test('operation=attention includes the failed job', async () => {
      const res = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=attention', cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.jobs.some((job) => job.id === jobId));
    });

    await t.test('operation=accounts includes the test account', async () => {
      const res = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=accounts', cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.accounts.some((account) => account.accountId === accountId));
    });

    await t.test('operation=job-events returns the real event timeline', async () => {
      const res = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=job-events&jobId=${jobId}`, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.events.length >= 2);
      assert.ok(res.body.events.some((event) => event.stageTo === 'failed'));
    });
  },
);
