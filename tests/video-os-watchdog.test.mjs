// Live integration tests against a real (non-production) Postgres target,
// same convention as tests/render-worker.test.mjs and
// tests/standard-narration-repository.test.mjs -- skips cleanly without
// DATABASE_URL.
//
// Covers what's fully real-testable without provider credentials or new
// mocking infrastructure: the stale-job query layer, and
// runWatchdogSweep's ambiguous-bucket behavior (alert only, no DB
// mutation, no provider calls). The actionable-bucket recovery path
// (driveJobSafely against a real HeyGen/RunPod job) is NOT covered here --
// see lib/video-os-watchdog.js's own PR description for why, and
// docs/P0-RELEASE-GATE.md for where that gets exercised for real.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import {
  claimWorkflowStart, ensureAccount, getJob, listFailedOrStuckJobs, listStalledActionableJobs, listStalledAmbiguousJobs,
  reserveRender, transitionJob,
} from '../db/repositories.js';
import { users, videoJobs } from '../db/schema.js';
import { runWatchdogSweep } from '../lib/video-os-watchdog.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

async function backdateUpdatedAt(jobId, minutesAgo) {
  await database().update(videoJobs).set({ updatedAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(videoJobs.id, jobId));
}

async function makeJob(accountId, { status, providerJobId, minutesAgo }) {
  const jobId = `job-watchdog-test-${crypto.randomUUID()}`;
  await reserveRender({
    jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: `corr-${jobId}`,
    provider: 'heygen', title: 'Watchdog Test', format: 'vertical', costCredits: 5, input: {},
  });
  await claimWorkflowStart(jobId);
  if (status !== 'workflow_started') {
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    if (status !== 'provider_submitting') {
      await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted', providerJobId: providerJobId || 'watchdog-test-provider-job' });
      if (status !== 'provider_submitted') {
        await transitionJob({ jobId, stageTo: status, eventType: 'provider.polled' });
      }
    }
  }
  if (minutesAgo) await backdateUpdatedAt(jobId, minutesAgo);
  return jobId;
}

test(
  'watchdog: stale-job queries find the right bucket and nothing else',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-watchdog-${crypto.randomUUID()}`;
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });
    await ensureAccount({ accountId, email: null, name: 'Watchdog Test', initialCredits: 1000 });

    const freshRendering = await makeJob(accountId, { status: 'provider_rendering', minutesAgo: 5 });
    const staleRendering = await makeJob(accountId, { status: 'provider_rendering', providerJobId: 'watchdog-stale-rendering', minutesAgo: 45 });
    const staleSubmitting = await makeJob(accountId, { status: 'provider_submitting', minutesAgo: 45 });
    const freshSubmitting = await makeJob(accountId, { status: 'provider_submitting', minutesAgo: 5 });

    await t.test('listStalledActionableJobs finds only the stale, providerJobId-bearing job', async () => {
      const actionable = await listStalledActionableJobs(30, 200);
      const ids = actionable.map((job) => job.id);
      assert.ok(ids.includes(staleRendering), 'stale provider_rendering job should be found');
      assert.ok(!ids.includes(freshRendering), 'fresh provider_rendering job should not be found');
      assert.ok(!ids.includes(staleSubmitting), 'provider_submitting has no confirmed providerJobId -- must not appear here');
    });

    await t.test('listStalledAmbiguousJobs finds only the stale, no-confirmed-provider job', async () => {
      const ambiguous = await listStalledAmbiguousJobs(30, 200);
      const ids = ambiguous.map((job) => job.id);
      assert.ok(ids.includes(staleSubmitting), 'stale provider_submitting job should be found');
      assert.ok(!ids.includes(freshSubmitting), 'fresh provider_submitting job should not be found');
      assert.ok(!ids.includes(staleRendering), 'provider_rendering belongs to the actionable bucket, not this one');
    });

    await t.test('the admin attention list surfaces the stale ambiguous job too, not just the actionable one', async () => {
      const attention = await listFailedOrStuckJobs(200);
      const ids = attention.map((job) => job.id);
      assert.ok(ids.includes(staleSubmitting), 'a long-stuck provider_submitting job needs a human, same as failed/cancelled/provider_submit_unknown');
      assert.ok(!ids.includes(freshSubmitting), 'a merely-in-progress submission must not show up as needing attention');
      assert.ok(!ids.includes(staleRendering), 'the attention list is for jobs a human must act on -- the watchdog handles provider_rendering on its own');
    });
  },
);

test(
  'watchdog: ambiguous jobs are alerted on, never touched',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-watchdog-ambiguous-${crypto.randomUUID()}`;
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });
    await ensureAccount({ accountId, email: null, name: 'Watchdog Ambiguous Test', initialCredits: 1000 });

    const jobId = await makeJob(accountId, { status: 'provider_submitting', minutesAgo: 45 });
    const before = await getJob(jobId);

    const result = await runWatchdogSweep({ staleAfterMinutes: 30, limit: 200 });
    assert.ok(result.ambiguousFound >= 1);
    assert.ok(result.jobs.alertedIds.includes(jobId));

    const after = await getJob(jobId);
    assert.equal(after.status, before.status, 'an ambiguous job must never have its status changed by the sweep -- see GitHub issue #23');
    assert.deepEqual(after.updatedAt, before.updatedAt, 'no write should happen to an ambiguous job at all, not even a touch');
  },
);
