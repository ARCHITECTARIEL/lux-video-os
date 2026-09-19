// HTTP-handler-level test for routes/video-os-lite/admin.js, same
// request()/response() mock convention as tests/standard-route-http.test.mjs.
// Skips cleanly without DATABASE_URL, same as the other live-DB route tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { addUploadMediaAsset, claimWorkflowStart, ensureAccount, getJob, markJobFailedAndRelease, reserveRender, transitionJob } from '../db/repositories.js';
import { users } from '../db/schema.js';
import adminHandler from '../routes/video-os-lite/admin.js';
import { makeSession } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

function request({ method = 'GET', url, body, cookie, headers = {} }) {
  const bodyBuffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: { cookie: cookie ? `vos_admin=${encodeURIComponent(cookie)}` : undefined, 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer.length) yield bodyBuffer;
    },
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

    await t.test('operation=credit-ledger and operation=stripe-events return real, well-shaped arrays', async () => {
      const ledgerRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=credit-ledger', cookie: adminCookie }), ledgerRes);
      assert.equal(ledgerRes.statusCode, 200);
      assert.ok(Array.isArray(ledgerRes.body.transactions));

      const stripeRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=stripe-events', cookie: adminCookie }), stripeRes);
      assert.equal(stripeRes.statusCode, 200);
      assert.ok(Array.isArray(stripeRes.body.events));
    });

    const mediaAssetId = crypto.randomUUID();
    await t.test('operation=job-assets lists a media asset attached to the job', async () => {
      await addUploadMediaAsset({
        id: mediaAssetId, accountId, jobId, kind: 'identity-photo-source',
        privatePathname: `video-os/uploads/${accountId}/${mediaAssetId}.jpg`, contentType: 'image/jpeg', bytes: 1234, sha256: crypto.randomBytes(32).toString('hex'),
      });
      const res = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=job-assets&jobId=${jobId}`, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.assets.some((asset) => asset.id === mediaAssetId));
      assert.equal(res.body.assets.find((asset) => asset.id === mediaAssetId).quarantinedAt, null);
    });

    await t.test('POST operation=quarantine-asset sets quarantinedAt on the real asset', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=quarantine-asset', body: { mediaAssetId, reason: 'proof test' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.asset.quarantinedAt);

      const assetsRes = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=job-assets&jobId=${jobId}`, cookie: adminCookie }), assetsRes);
      assert.ok(assetsRes.body.assets.find((asset) => asset.id === mediaAssetId).quarantinedAt);
    });

    await t.test('POST operation=quarantine-asset 404s cleanly for an asset that does not exist', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=quarantine-asset', body: { mediaAssetId: crypto.randomUUID() }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 404);
    });

    const stuckJobId = `job-admin-route-test-stuck-${crypto.randomUUID()}`;
    await t.test('POST operation=resolve-job closes out a real job stuck in provider_submit_unknown and releases its credits', async () => {
      await reserveRender({ jobId: stuckJobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-admin-route-stuck-test', provider: 'heygen', title: 'Stuck Job', format: 'landscape', costCredits: 25, input: {} });
      await claimWorkflowStart(stuckJobId);
      await transitionJob({ jobId: stuckJobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
      await transitionJob({ jobId: stuckJobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });

      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=resolve-job', body: { jobId: stuckJobId, note: 'confirmed with provider support: never actually submitted' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.job.status, 'failed');
      assert.equal(res.body.job.failureCategory, 'ADMIN_MANUAL_RESOLUTION');

      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(before.reserved - after.reserved, 25, 'the reserved credits must be released back');

      const timelineRes = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=job-events&jobId=${stuckJobId}`, cookie: adminCookie }), timelineRes);
      assert.ok(timelineRes.body.events.some((event) => event.failureCategory === 'ADMIN_MANUAL_RESOLUTION'), 'the admin resolution must be visible in the job’s own timeline');
    });

    await t.test('POST operation=resolve-job is idempotent on an already-failed job and leaves it failed', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=resolve-job', body: { jobId, note: 'closing this out' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.job.status, 'failed');
      const job = await getJob(jobId);
      assert.equal(job.status, 'failed');
    });

    await t.test('POST operation=resolve-job 404s cleanly for a job that does not exist', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=resolve-job', body: { jobId: 'job-does-not-exist' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 404);
    });
  },
);
