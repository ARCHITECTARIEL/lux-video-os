// classifyFailure's allowlist gate had a real, high-severity bug: it never
// included 'PROVIDER_SUBMIT_UNKNOWN', so every guard across this codebase
// that reads `classifyFailure(error, 'INTERNAL') === 'PROVIDER_SUBMIT_UNKNOWN'`
// to decide "hold this job for manual reconciliation, do not touch it" was
// silently dead code -- the category always fell through to the fallback
// ('INTERNAL') instead. That guard exists in three places (driveJobSafely in
// lib/video-os-render-driver.js, and failWorkflow in both
// workflows/video-render.js and workflows/standard-render.js), all guarding
// the same call: markJobFailedAndRelease, which has no transition-table
// guard of its own -- it releases reserved credits and marks the job
// 'failed' unconditionally unless the caller stops it first. A genuinely
// ambiguous provider submission (network failure right as a real
// HeyGen/RunPod render request goes out) was therefore auto-resolved --
// credits refunded, job marked failed -- instead of held, which is exactly
// the duplicate-charge/lost-render race this whole 'held' bucket exists to
// prevent (see GitHub issue #23, referenced in standard-render.js).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { ensureAccount, getJob, reserveRender, transitionJob } from '../db/repositories.js';
import { entitlements, creditAccounts } from '../db/schema.js';
import { classifyFailure, FAILURE_CATEGORIES } from '../lib/video-os-operations.js';
import { driveJobSafely } from '../lib/video-os-render-driver.js';
import { failWorkflow as failPremiumWorkflow } from '../workflows/video-render.js';
import { failWorkflow as failStandardWorkflow } from '../workflows/standard-render.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test('FAILURE_CATEGORIES includes every category this codebase actually throws with, including PROVIDER_SUBMIT_UNKNOWN and FINISH_REMOTION', () => {
  // Not exhaustive by design -- this locks in the two specific categories
  // (services/remotion-finisher.js throws FINISH_REMOTION; the three
  // hold-not-fail guards check for PROVIDER_SUBMIT_UNKNOWN) whose absence
  // from this allowlist caused real, live bugs this file exists to catch a
  // regression of.
  assert.ok(FAILURE_CATEGORIES.includes('PROVIDER_SUBMIT_UNKNOWN'));
  assert.ok(FAILURE_CATEGORIES.includes('FINISH_REMOTION'));
});

test('classifyFailure regression: a Remotion-engine FFmpeg failure is classified as FINISH_REMOTION, not the INTERNAL fallback -- otherwise the render-driver.js/es reconciliation dashboards would be showing generic INTERNAL for every real Remotion finishing failure', () => {
  const error = Object.assign(new Error('Remotion FFmpeg engine exited 1: ...'), { failureCategory: 'FINISH_REMOTION' });
  assert.equal(classifyFailure(error, 'INTERNAL'), 'FINISH_REMOTION');
});

test('classifyFailure returns an error\'s own explicit failureCategory unchanged, for every allowlisted category', () => {
  for (const category of FAILURE_CATEGORIES) {
    const error = Object.assign(new Error('x'), { failureCategory: category });
    assert.equal(classifyFailure(error, 'INTERNAL'), category);
  }
});

test('classifyFailure regression: an error tagged PROVIDER_SUBMIT_UNKNOWN is classified as PROVIDER_SUBMIT_UNKNOWN, not the INTERNAL fallback', () => {
  const error = Object.assign(new Error('Provider submission outcome is uncertain'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  assert.equal(classifyFailure(error, 'INTERNAL'), 'PROVIDER_SUBMIT_UNKNOWN');
});

test('classifyFailure maps bare statusCodes to a category when the error carries no explicit failureCategory', () => {
  assert.equal(classifyFailure({ statusCode: 401 }, 'INTERNAL'), 'AUTH_REQUIRED');
  assert.equal(classifyFailure({ statusCode: 403 }, 'INTERNAL'), 'AUTH_FORBIDDEN');
  assert.equal(classifyFailure({ statusCode: 429 }, 'INTERNAL'), 'RATE_LIMIT');
});

test('classifyFailure falls back to the caller-supplied default for an unrecognized or absent failureCategory', () => {
  assert.equal(classifyFailure(new Error('plain'), 'INTERNAL'), 'INTERNAL');
  assert.equal(classifyFailure(Object.assign(new Error('x'), { failureCategory: 'NOT_A_REAL_CATEGORY' }), 'INTERNAL'), 'INTERNAL');
  assert.equal(classifyFailure(undefined, 'RECONCILIATION'), 'RECONCILIATION');
});

async function reserveJobAtProviderSubmitUnknown({ provider }) {
  const accountId = `acct_psu_${provider}_${crypto.randomUUID()}`;
  const jobId = crypto.randomUUID();
  const costCredits = 25;
  await ensureAccount({ accountId, initialCredits: 100 });
  await database().insert(entitlements).values(['standardRendering', 'liveRendering'].map(entitlementKey => ({ accountId, entitlementKey, enabled: true, sourceType: 'test_fixture' })));
  await reserveRender({
    jobId,
    accountId,
    idempotencyKey: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    provider,
    title: 'PROVIDER_SUBMIT_UNKNOWN regression fixture',
    format: 'landscape',
    costCredits,
    input: {},
  });
  await transitionJob({ jobId, stageTo: 'workflow_started', eventType: 'workflow.prepared' });
  await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
  await transitionJob({ jobId, stageTo: 'provider_submit_unknown', eventType: 'provider.submit_unknown', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  return { accountId, jobId, costCredits };
}

test(
  'regression: failWorkflow (Premium/HeyGen path) holds a PROVIDER_SUBMIT_UNKNOWN job untouched -- it must not mark it failed or release its reserved credits',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    const { accountId, jobId, costCredits } = await reserveJobAtProviderSubmitUnknown({ provider: 'heygen' });
    const error = Object.assign(new Error('Provider submission outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });

    await failPremiumWorkflow(jobId, error);

    const job = await database().query.videoJobs.findFirst({ where: (table, { eq: equals }) => equals(table.id, jobId) });
    assert.equal(job.status, 'provider_submit_unknown');
    const account = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(account.reserved, costCredits);
  },
);

test(
  'regression: failWorkflow (Standard/sadtalker path) holds a PROVIDER_SUBMIT_UNKNOWN job untouched -- same guard, same bug surface, tested independently',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    const { accountId, jobId, costCredits } = await reserveJobAtProviderSubmitUnknown({ provider: 'sadtalker' });
    const error = Object.assign(new Error('Standard render outcome is uncertain; automatic resubmission is blocked to prevent duplicate charges.'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });

    await failStandardWorkflow(jobId, error);

    const job = await database().query.videoJobs.findFirst({ where: (table, { eq: equals }) => equals(table.id, jobId) });
    assert.equal(job.status, 'provider_submit_unknown');
    const account = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(account.reserved, costCredits);
  },
);

test(
  'a genuinely INTERNAL failure at the same provider_submit_unknown-adjacent stage is still failed-and-released normally -- the fix does not make failWorkflow over-hold',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    const accountId = `acct_psu_internal_${crypto.randomUUID()}`;
    const jobId = crypto.randomUUID();
    const costCredits = 25;
    await ensureAccount({ accountId, initialCredits: 100 });
    await database().insert(entitlements).values(['standardRendering', 'liveRendering'].map(entitlementKey => ({ accountId, entitlementKey, enabled: true, sourceType: 'test_fixture' })));
    await reserveRender({ jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), provider: 'heygen', title: 'INTERNAL control fixture', format: 'landscape', costCredits, input: {} });
    await transitionJob({ jobId, stageTo: 'workflow_started', eventType: 'workflow.prepared' });
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });

    await failPremiumWorkflow(jobId, new Error('unexpected internal error'));

    const job = await database().query.videoJobs.findFirst({ where: (table, { eq: equals }) => equals(table.id, jobId) });
    assert.equal(job.status, 'failed');
    const account = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(account.reserved, 0);
  },
);

test(
  'crash-recovery re-drive: a Standard-simulation job left sitting at provider_submitted (worker crashed after that transition, before finishing) is safely failed-and-released on the next drive, not left stuck or double-processed',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async () => {
    // workflows/standard-render.js's resolveAndRenderSimulation always
    // restarts its whole submit->render->finish sequence from the top
    // (unconditionally re-transitioning to 'provider_submitting') -- it does
    // not check whether the job is already past that point. Re-driving a
    // job already at 'provider_submitted' therefore hits an invalid
    // ALLOWED_JOB_TRANSITIONS edge (provider_submitted -> provider_submitting
    // is not allowed), and the catch block's own recovery attempt
    // (transitioning to provider_submit_unknown) hits a second invalid edge
    // for the same reason, so classifyFailure sees a plain RECONCILIATION
    // error rather than PROVIDER_SUBMIT_UNKNOWN. That's a real rough edge
    // (misleading "Invalid job transition" error text in place of an
    // accurate "resuming from a stale intermediate state" message), but this
    // test's job is to prove the outcome at the level that actually
    // matters -- driveJobSafely, the worker's real re-drive entrypoint --
    // still resolves it safely: failed and released, never stuck, never
    // double-charged.
    const accountId = `acct_crash_resume_${crypto.randomUUID()}`;
    const jobId = crypto.randomUUID();
    const costCredits = 25;
    await ensureAccount({ accountId, initialCredits: 100 });
    await database().insert(entitlements).values(['standardRendering', 'liveRendering'].map(entitlementKey => ({ accountId, entitlementKey, enabled: true, sourceType: 'test_fixture' })));
    await reserveRender({ jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), provider: 'sadtalker', title: 'crash-mid-flight fixture', format: 'landscape', costCredits, input: {} });
    await transitionJob({ jobId, stageTo: 'workflow_started', eventType: 'workflow.prepared' });
    await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
    await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted' });

    const job = await getJob(jobId);
    assert.equal(job.status, 'provider_submitted');
    await driveJobSafely(job);

    const after = await getJob(jobId);
    assert.equal(after.status, 'failed');
    const account = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(account.reserved, 0);
  },
);
