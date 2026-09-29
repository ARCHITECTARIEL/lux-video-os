// HTTP-handler-level test for routes/video-os-lite/admin.js, same
// request()/response() mock convention as tests/standard-route-http.test.mjs.
// Skips cleanly without DATABASE_URL, same as the other live-DB route tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { addUploadMediaAsset, claimWorkflowStart, ensureAccount, finalizeReadyJob, getJob, markJobFailedAndRelease, reserveRender, transitionJob } from '../db/repositories.js';
import { users } from '../db/schema.js';
import adminHandler from '../routes/video-os-lite/admin.js';
import { makeSession } from '../lib/video-os-account.js';
import { getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { isTesterAccountId } from '../lib/video-os-testers.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

let blobAvailable = dbAvailable;
try {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('no blob token');
} catch {
  blobAvailable = false;
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
    chunks: [],
    setHeader(name, value) { this.headers[name] = value; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(body) { this.body = body ? JSON.parse(body) : undefined; },
  };
}

test('admin route rejects requests with neither a valid admin cookie nor bearer token', async () => {
  const res = response();
  await adminHandler(request({ url: '/api/video-os-lite/admin' }), res);
  assert.equal(res.statusCode, 401);
});

test(
  'admin route accepts VIDEO_OS_ADMIN_TOKEN as a bearer token',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
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
  },
);

test(
  'admin route rejects a wrong bearer token, whether same length or a different length',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    const original = process.env.VIDEO_OS_ADMIN_TOKEN;
    process.env.VIDEO_OS_ADMIN_TOKEN = 'proof-admin-token';
    try {
      const sameLength = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=jobs', headers: { authorization: 'Bearer proof-wrong-token' } }), sameLength);
      assert.equal(sameLength.statusCode, 401, 'a same-length wrong token must still be rejected under timingSafeMatch');

      const differentLength = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=jobs', headers: { authorization: 'Bearer x' } }), differentLength);
      assert.equal(differentLength.statusCode, 401, 'a different-length wrong token must be rejected');
    } finally {
      if (original === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
      else process.env.VIDEO_OS_ADMIN_TOKEN = original;
    }
  },
);

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

test(
  'POST operation=stripe-reconciliation is wired to the real reconciliation sweep and fails loud (503), not a silent "clean," when Stripe is not configured',
  async () => {
    // Doesn't need DATABASE_URL: reconcileStripePayments() (lib/video-os-
    // stripe-reconciliation.js) builds its own Stripe client before it ever
    // touches the DB, so an unconfigured STRIPE_SECRET_KEY fails before any
    // repository call happens. Full mocked-success coverage of the
    // reconciliation sweep itself lives in
    // tests/video-os-stripe-reconciliation.test.mjs, which injects a fake
    // Stripe client directly -- something an HTTP caller of this admin
    // route deliberately cannot do.
    const originalToken = process.env.VIDEO_OS_ADMIN_TOKEN;
    const originalStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.VIDEO_OS_ADMIN_TOKEN = 'proof-admin-token';
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=stripe-reconciliation', body: {}, headers: { authorization: 'Bearer proof-admin-token' } }), res);
      assert.equal(res.statusCode, 503, 'this must fail loud, not silently report a clean sweep, when Stripe is not configured -- see .github/workflows/stripe-reconciliation.yml\'s header comment for why');
      assert.match(res.body.error, /STRIPE_SECRET_KEY/);
    } finally {
      if (originalToken === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
      else process.env.VIDEO_OS_ADMIN_TOKEN = originalToken;
      if (originalStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = originalStripeKey;
    }
  },
);

test('POST operation=stripe-reconciliation is rejected the same as any other operation without valid admin auth', async () => {
  const res = response();
  await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=stripe-reconciliation', body: {} }), res);
  assert.equal(res.statusCode, 401);
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

    await t.test('POST operation=grant-credit adds real credits to the real account balance', async () => {
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 180, note: 'backfilling a pre-fix trial grant', idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.applied, true);
      assert.equal(res.body.balanceAfter, before.balance + 180);

      const accountsRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=accounts', cookie: adminCookie }), accountsRes);
      assert.equal(accountsRes.body.accounts.find((account) => account.accountId === accountId).balance, before.balance + 180);

      const ledgerRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=credit-ledger', cookie: adminCookie }), ledgerRes);
      assert.ok(ledgerRes.body.transactions.some((tx) => tx.accountId === accountId && tx.sourceType === 'admin_grant' && tx.amount === 180), 'the grant must be visible in the credit ledger');
    });

    await t.test('POST operation=grant-credit replays idempotently on the same key, without double-granting', async () => {
      const key = crypto.randomUUID();
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const first = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 50, idempotencyKey: key }, cookie: adminCookie }), first);
      assert.equal(first.body.applied, true);

      const second = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 50, idempotencyKey: key }, cookie: adminCookie }), second);
      assert.equal(second.statusCode, 200);
      assert.equal(second.body.applied, false);
      assert.equal(second.body.duplicate, true);

      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(after.balance, before.balance + 50, 'a replayed request with the same idempotencyKey must not grant twice');
    });

    await t.test('POST operation=grant-credit under real concurrency: exactly one of two simultaneous identical requests applies, the other gets a clean duplicate response', async () => {
      const key = crypto.randomUUID();
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const first = response();
      const second = response();
      // Genuinely concurrent, not sequential -- this is the exact race the
      // fix targets: two requests racing to claim the same idempotencyKey,
      // not one request replaying after the first has already committed.
      await Promise.all([
        adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 30, idempotencyKey: key }, cookie: adminCookie }), first),
        adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 30, idempotencyKey: key }, cookie: adminCookie }), second),
      ]);

      const results = [first, second];
      assert.equal(results.filter((r) => r.statusCode === 200).length, 2, 'neither concurrent request should surface a raw, unhandled error');
      const applied = results.filter((r) => r.body.applied === true);
      const duplicates = results.filter((r) => r.body.applied === false && r.body.duplicate === true);
      assert.equal(applied.length, 1, 'exactly one of the two concurrent requests must win the grant');
      assert.equal(duplicates.length, 1, 'the loser must get a clean duplicate response, not a raw constraint-violation error');

      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(after.balance, before.balance + 30, 'the amount must be applied exactly once, even under real concurrency');
    });

    await t.test('POST operation=grant-credit rejects a negative amount that would take the balance below zero', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: -1_000_000, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 400);
    });

    await t.test('POST operation=grant-credit validates its inputs before touching the database', async () => {
      const missingAccount = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { amount: 10, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), missingAccount);
      assert.equal(missingAccount.statusCode, 400);

      const zeroAmount = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 0, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), zeroAmount);
      assert.equal(zeroAmount.statusCode, 400);

      const fractionalAmount = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 1.5, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), fractionalAmount);
      assert.equal(fractionalAmount.statusCode, 400);

      const tooLarge = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 1_000_000, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), tooLarge);
      assert.equal(tooLarge.statusCode, 400);

      const missingKey = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId, amount: 10 }, cookie: adminCookie }), missingKey);
      assert.equal(missingKey.statusCode, 400);
    });

    await t.test('POST operation=grant-credit 404s cleanly for an account that does not exist', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=grant-credit', body: { accountId: `test-admin-route-nonexistent-${crypto.randomUUID()}`, amount: 10, idempotencyKey: crypto.randomUUID() }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 404);
    });

    // operation=accounts returns real customer email addresses (see
    // listRecentAccounts()) -- confirming this specific PII-bearing
    // endpoint, not just the generic default operation, is unreachable
    // without real admin auth.
    await t.test('operation=accounts (which returns real customer emails) is rejected without valid admin auth', async () => {
      const res = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=accounts' }), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.accounts, undefined, 'a rejected request must never carry real account data in the response body');
    });

    const testerEmail = `test-admin-tester-${crypto.randomUUID()}@luxmarketingcompany.com`;
    let testerAccountId;
    await t.test('POST operation=register-tester creates a real tester account with full entitlements', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=register-tester', body: { email: testerEmail, name: 'Admin Route Tester', credits: 2500, note: 'proof test' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.tester.user.email, testerEmail);
      assert.equal(res.body.tester.user.role, 'tester');
      assert.equal(res.body.tester.credits.balance, 2500);
      assert.equal(res.body.tester.entitlements.liveRendering, true);
      assert.equal(res.body.tester.entitlements.standardRendering, true);
      testerAccountId = res.body.tester.user.id;
      t.after(async () => { await database().delete(users).where(eq(users.id, testerAccountId)).catch(() => {}); });

      assert.equal(isTesterAccountId(testerAccountId), true, 'registerAdminTester must actually register the account in the in-memory tester set, not just the database');

      const listRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=testers', cookie: adminCookie }), listRes);
      assert.equal(listRes.statusCode, 200);
      assert.ok(listRes.body.testers.some((row) => row.accountId === testerAccountId), 'the newly registered tester must appear in the admin testers listing');
    });

    await t.test('POST operation=register-tester rejects a missing or invalid email before touching the database', async () => {
      const missing = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=register-tester', body: { name: 'No Email' }, cookie: adminCookie }), missing);
      assert.equal(missing.statusCode, 400);

      const invalid = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=register-tester', body: { email: 'not-an-email' }, cookie: adminCookie }), invalid);
      assert.equal(invalid.statusCode, 400);
    });

    await t.test('POST operation=revoke-tester actually revokes: role reverts, entitlements disable, and the in-memory registration is removed', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=revoke-tester', body: { accountId: testerAccountId }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.result.user.role, 'customer');
      assert.equal(res.body.result.entitlements.liveRendering, undefined, 'a disabled entitlement must not appear as granted');

      assert.equal(isTesterAccountId(testerAccountId), false, 'revoke must actually clear the in-memory tester registration, not just flip the DB role -- otherwise the account stays a tester in effect until the next process restart');
    });

    await t.test('POST operation=revoke-tester requires accountId', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=revoke-tester', body: {}, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 400);
    });

    // Real bug found and fixed during this beta-test pass (db/repositories.js
    // listAdminTesters()): loading the admin testers list used to call
    // registerTesterAccountId() for EVERY row the broad domain-wildcard
    // query matched, not just ones explicitly registered via
    // registerAdminTester -- silently re-registering any @luxmarketingcompany.com
    // account into the in-memory tester set, which lib/video-os-security.js's
    // containedRenderingEntitlementKeys() treats as full Premium access via
    // isTesterAccountId(). That reopened the exact liveRendering leak the
    // entitlement fix (containedRenderingEntitlementKeys splitting exact vs
    // domain-only matches) was meant to close, through a different trigger:
    // an admin merely viewing the tester list, not an explicit grant.
    await t.test('viewing the admin testers list does NOT silently register a plain domain-matched account as a tester (regression proof for the just-fixed liveRendering leak)', async () => {
      const domainMatchedAccountId = `test-admin-domain-only-${crypto.randomUUID()}`;
      const domainMatchedEmail = `plain-employee-${crypto.randomUUID()}@luxmarketingcompany.com`;
      await ensureAccount({ accountId: domainMatchedAccountId, email: domainMatchedEmail, name: 'Plain Domain Match', initialCredits: 0 });
      t.after(async () => { await database().delete(users).where(eq(users.id, domainMatchedAccountId)).catch(() => {}); });

      assert.equal(isTesterAccountId(domainMatchedAccountId), false, 'a freshly created domain-matched account must not already be tester-registered');

      const listRes = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=testers', cookie: adminCookie }), listRes);
      assert.equal(listRes.statusCode, 200);
      assert.ok(listRes.body.testers.some((row) => row.accountId === domainMatchedAccountId), 'the account should still be VISIBLE in the listing (it does match the domain), just not silently registered as a side effect of being listed');

      assert.equal(isTesterAccountId(domainMatchedAccountId), false, 'merely appearing in the admin testers listing (via the domain-wildcard clause, never through registerAdminTester) must NOT register the account as a tester -- doing so would silently grant it full liveRendering on its next sign-in, reopening the leak fixed in containedRenderingEntitlementKeys()');
    });

    await t.test('POST operation=watchdog-sweep is wired to the real sweep and returns a well-shaped result', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=watchdog-sweep', body: {}, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.sweep, 'must return a real sweep result object');
      assert.equal(typeof res.body.sweep.actionableFound, 'number');
      assert.equal(typeof res.body.sweep.ambiguousFound, 'number');
      assert.equal(typeof res.body.sweep.safeToReleaseFound, 'number');
    });

    await t.test('POST operation=watchdog-sweep is rejected without valid admin auth, same as any other mutating operation', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=watchdog-sweep', body: {} }), res);
      assert.equal(res.statusCode, 401);
    });
  },
);

test(
  'admin console: video preview, approve, delete-video and retry-job operate on a real ready job',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
    if (!originalSecret) process.env.VIDEO_OS_SESSION_SECRET = 'admin-route-http-test-secret-with-adequate-length';
    const adminCookie = makeSession('admin', 'owner@example.invalid', 60 * 60);

    const accountId = `test-admin-video-${crypto.randomUUID()}`;
    const pathname = `video-os/finals/${accountId}/${crypto.randomUUID()}.mp4`;
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
      if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    });
    await ensureAccount({ accountId, email: null, name: 'Admin Video Test', initialCredits: 200 });

    const heygenJobId = `job-admin-video-test-${crypto.randomUUID()}`;
    await reserveRender({ jobId: heygenJobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-admin-video-test', provider: 'heygen', title: 'Admin Video Test', format: 'landscape', costCredits: 40, input: {} });
    await claimWorkflowStart(heygenJobId);
    const videoBytes = Buffer.from('fake-mp4-bytes');
    await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, videoBytes, { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
    await finalizeReadyJob(heygenJobId, { privatePathname: pathname, filename: 'final.mp4', bytes: videoBytes.length, sha256: crypto.createHash('sha256').update(videoBytes).digest('hex') });

    await t.test('operation=video streams the real blob bytes for a ready job', async () => {
      const res = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=video&jobId=${heygenJobId}`, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'video/mp4');
      assert.ok(Buffer.concat(res.chunks).equals(videoBytes));
    });

    await t.test('operation=video 404s cleanly for a job that does not exist', async () => {
      const res = response();
      await adminHandler(request({ url: '/api/video-os-lite/admin?operation=video&jobId=job-does-not-exist' , cookie: adminCookie}), res);
      assert.equal(res.statusCode, 404);
    });

    await t.test('POST operation=approve-job sets reviewedAt without touching status', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=approve-job', body: { jobId: heygenJobId }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.job.reviewedAt);
      assert.equal(res.body.job.status, 'ready');
    });

    await t.test('POST operation=retry-job on a heygen job reserves a fresh job and charges credits normally', async () => {
      const originalMode = process.env.WORKFLOW_DISPATCH_MODE;
      process.env.WORKFLOW_DISPATCH_MODE = 'worker'; // avoid a real Vercel Workflow dispatch in this test
      try {
        const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
        const res = response();
        await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=retry-job', body: { jobId: heygenJobId }, cookie: adminCookie }), res);
        assert.equal(res.statusCode, 200);
        assert.notEqual(res.body.job.id, heygenJobId, 'retry must create a new job, not mutate the original');
        assert.equal(res.body.job.status, 'workflow_started');
        assert.equal(res.body.job.provider, 'heygen');
        t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });

        const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
        assert.equal(after.reserved - before.reserved, 40, 'the retry must reserve credits normally, same as a customer-initiated render');
      } finally {
        if (originalMode === undefined) delete process.env.WORKFLOW_DISPATCH_MODE;
        else process.env.WORKFLOW_DISPATCH_MODE = originalMode;
      }
    });

    const sadtalkerJobId = `job-admin-video-sadtalker-test-${crypto.randomUUID()}`;
    await t.test('POST operation=retry-job rejects a sadtalker job (Standard tier retry is not supported yet)', async () => {
      await reserveRender({ jobId: sadtalkerJobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-admin-video-sadtalker-test', provider: 'sadtalker', title: 'Sadtalker Retry Test', format: 'vertical', costCredits: 10, input: {} });
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=retry-job', body: { jobId: sadtalkerJobId }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 409);
    });

    await t.test('POST operation=delete-video removes the blob and marks videoDeletedAt, and the video stream then 410s', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=delete-video', body: { jobId: heygenJobId }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.job.videoDeletedAt);
      assert.equal(res.body.job.status, 'ready', 'delete-video must not change the job status, only mark videoDeletedAt');

      const streamRes = response();
      await adminHandler(request({ url: `/api/video-os-lite/admin?operation=video&jobId=${heygenJobId}`, cookie: adminCookie }), streamRes);
      assert.equal(streamRes.statusCode, 410);

      assert.equal(await getPrivateBlob(pathname), null, 'the underlying blob must actually be gone from storage');
    });

    await t.test('POST operation=delete-video 404s cleanly for a job that does not exist', async () => {
      const res = response();
      await adminHandler(request({ method: 'POST', url: '/api/video-os-lite/admin?operation=delete-video', body: { jobId: 'job-does-not-exist' }, cookie: adminCookie }), res);
      assert.equal(res.statusCode, 404);
    });
  },
);
