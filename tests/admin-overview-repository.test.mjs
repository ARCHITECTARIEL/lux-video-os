// Live integration test against the real (non-production) Postgres, same
// convention as tests/standard-narration-repository.test.mjs. Global
// aggregate queries (getAdminOverview) are asserted with monotonic deltas
// (before/after, >=) rather than exact values, since other test files can
// run concurrently against the same database and only ever add rows, never
// remove them mid-run.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import {
  claimWorkflowStart, ensureAccount, getAdminOverview, getJobEventTimeline,
  listFailedOrStuckJobs, listRecentAccounts, markJobFailedAndRelease, recordSignIn, reserveRender,
} from '../db/repositories.js';
import { users } from '../db/schema.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test(
  'admin overview, sign-in recording, and failed/stuck job visibility against a real database',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-admin-overview-${crypto.randomUUID()}`;
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    const beforeAccountCreated = await getAdminOverview();
    await ensureAccount({ accountId, email: `${accountId}@example.com`, name: 'Admin Overview Test', initialCredits: 500 });

    await t.test('creating the account is reflected in getAdminOverview', async () => {
      const after = await getAdminOverview();
      assert.ok(after.users.total >= beforeAccountCreated.users.total + 1, 'the newly created account must be counted');
    });

    await t.test('recordSignIn is queryable and getAdminOverview counts it without blocking on failure', async () => {
      const before = await getAdminOverview();
      await recordSignIn(accountId);
      await recordSignIn(accountId);
      const after = await getAdminOverview();
      assert.ok(after.signIns.last30d >= before.signIns.last30d + 2, 'two recorded sign-ins must be reflected in the 30-day window');
      // recordSignIn must never throw even with a nonsense/foreign-key-violating account id -- it's best-effort analytics, not a gate on sign-in itself.
      await assert.doesNotReject(recordSignIn('this-account-does-not-exist'));
    });

    await t.test('listRecentAccounts surfaces the new account with its real credit balance', async () => {
      const accounts = await listRecentAccounts(200);
      const found = accounts.find((account) => account.accountId === accountId);
      assert.ok(found, 'the newly created account must appear in the recent-accounts list');
      assert.equal(found.balance, 500);
      assert.equal(found.email, `${accountId}@example.com`);
    });

    const jobId = `job-admin-overview-test-${crypto.randomUUID()}`;
    await reserveRender({
      jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-admin-overview-test',
      provider: 'sadtalker', title: 'Admin Overview Test Job', format: 'vertical', costCredits: 40, input: {},
    });
    await claimWorkflowStart(jobId);

    await t.test('a job absent from listFailedOrStuckJobs before failing, present after', async () => {
      const before = await listFailedOrStuckJobs(200);
      assert.ok(!before.some((job) => job.id === jobId));
      await markJobFailedAndRelease(jobId, 'PROVIDER_SUBMIT', 'Simulated failure for admin overview test.');
      const after = await listFailedOrStuckJobs(200);
      const found = after.find((job) => job.id === jobId);
      assert.ok(found, 'a failed job must appear in the attention list');
      assert.equal(found.status, 'failed');
      assert.equal(found.failureCategory, 'PROVIDER_SUBMIT');
    });

    await t.test('getJobEventTimeline returns the real, ordered stage history for the job', async () => {
      const timeline = await getJobEventTimeline(jobId);
      assert.ok(timeline.length >= 2, 'reserve + claim + fail must each leave an event');
      const stages = timeline.map((event) => event.stageTo);
      assert.ok(stages.includes('workflow_started'));
      assert.ok(stages.includes('failed'));
      for (let i = 1; i < timeline.length; i += 1) {
        assert.ok(new Date(timeline[i].createdAt).getTime() >= new Date(timeline[i - 1].createdAt).getTime(), 'events must be in chronological order');
      }
    });

    await t.test('getAdminOverview reflects the failed job in its status breakdown and reconciliation stays a real query', async () => {
      const overview = await getAdminOverview();
      assert.ok(overview.jobsByStatus.failed >= 1);
      assert.equal(typeof overview.reconciliation.stuckJobs, 'number');
      assert.equal(typeof overview.reconciliation.readyWithoutAsset, 'number');
      assert.equal(typeof overview.credits.balance, 'number');
    });
  },
);
