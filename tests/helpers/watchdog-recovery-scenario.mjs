import assert from 'node:assert/strict';
import { mock } from 'node:test';

process.env.DATABASE_URL = '';

const originalUpdatedAt = new Date('2026-10-17T00:00:00.000Z');
const checkedUpdatedAt = new Date('2026-10-17T00:30:00.000Z');
const job = {
  id: 'synthetic-watchdog-recovery-job',
  accountId: 'synthetic-account',
  correlationId: 'synthetic-correlation',
  provider: 'heygen',
  providerJobId: 'confirmed-provider-job',
  status: 'provider_rendering',
  updatedAt: originalUpdatedAt,
};

let driveError = null;
let readError = null;
let actionableStatus = 'provider_rendering';
let afterStatus = 'provider_rendering';
let driveResultStatus = null;
let providerPayload = null;
let lastDrivenStatus = null;
let releaseCalls = 0;
let alerts = 0;
let notifications = 0;

mock.module('../../db/repositories.js', { namedExports: {
  WATCHDOG_STALE_MINUTES_DEFAULT: 30,
  listStalledActionableJobs: async () => [{ ...job, status: actionableStatus }],
  listStalledAmbiguousJobs: async () => [],
  listStalledSafeToReleaseJobs: async () => [],
  claimWatchdogJobs: async () => true,
  getJob: async () => {
    if (readError) throw readError;
    return { ...job, status: afterStatus, updatedAt: checkedUpdatedAt };
  },
  markJobFailedAndRelease: async (id, category, message, _artifact, options) => {
    releaseCalls++;
    assert.equal(id, job.id);
    assert.equal(category, 'PROVIDER_TIMEOUT');
    assert.match(message, /successful provider check confirmed it remains unresolved/);
    assert.deepEqual(options, {
      expectedStatuses: [afterStatus],
      expectedUpdatedAt: checkedUpdatedAt,
      withTransition: true,
    });
    return { job: { ...job, status: 'failed' }, transitioned: true };
  },
} });

mock.module('../../lib/video-os-render-driver.js', { namedExports: {
  driveJob: async (selectedJob) => {
    lastDrivenStatus = selectedJob.status;
    if (driveError) throw driveError;
    if (providerPayload) {
      await pollHeygen(job.providerJobId, {
        env: { HEYGEN_API_KEY: 'fixture-key' },
        fetchImpl: async () => new Response(JSON.stringify(providerPayload), { status: 200 }),
      });
      return;
    }
    if (driveResultStatus) afterStatus = driveResultStatus;
  },
} });

mock.module('../../lib/video-os-observability.js', { namedExports: {
  captureJobError: () => { alerts++; },
} });

mock.module('../../lib/video-os-watchdog-notify.js', { namedExports: {
  claimWatchdogEscalation: async () => true,
  notifyWatchdogSweep: async (result) => {
    if (result.recovered || result.timedOut || result.alerted || result.released) notifications++;
  },
} });

mock.module('../../lib/provider-consent-url-cleanup.js', { namedExports: {
  sweepExpiredHostedConsentUrls: async () => ({}),
} });

mock.module('../../lib/video-os-operations.js', { namedExports: {
  classifyFailure: (error, fallback) => error?.failureCategory
    || (error?.statusCode === 401 ? 'AUTH_REQUIRED' : fallback),
} });

const { runWatchdogSweep } = await import('../../lib/video-os-watchdog.js');
const { pollHeygen } = await import('../../services/heygen.js');

for (const error of [
  Object.assign(new Error('revoked provider credential'), { statusCode: 401 }),
  Object.assign(new Error('provider poll unavailable'), { failureCategory: 'PROVIDER_POLL' }),
  Object.assign(new Error('provider dependency unavailable'), { failureCategory: 'CONFIG_MISSING' }),
]) {
  driveError = error;
  readError = null;
  actionableStatus = 'provider_rendering';
  afterStatus = 'provider_rendering';
  driveResultStatus = null;
  const before = { releaseCalls, alerts, notifications };
  const result = await runWatchdogSweep();

  assert.equal(result.timedOut, 0);
  assert.equal(result.alerted, 1);
  assert.deepEqual(result.jobs.alertedIds, [job.id]);
  assert.deepEqual(result.jobs.recovery, [{
    jobId: job.id,
    outcome: 'recovery_failed',
    status: job.status,
    failureCategory: error.failureCategory || 'AUTH_REQUIRED',
  }]);
  assert.equal(releaseCalls, before.releaseCalls, 'failed provider checks must leave the reservation held');
  assert.equal(alerts, before.alerts + 1, 'failed provider checks must emit an operations alert');
  assert.equal(notifications, before.notifications + 1, 'failed provider checks must notify the configured operator channel');
}

driveError = null;
readError = new Error('database read unavailable');
actionableStatus = 'provider_rendering';
afterStatus = 'provider_rendering';
driveResultStatus = null;
const beforeReadFailure = { releaseCalls, alerts, notifications };
const readFailure = await runWatchdogSweep();
assert.equal(readFailure.timedOut, 0);
assert.equal(readFailure.alerted, 1);
assert.equal(readFailure.jobs.recovery[0].outcome, 'recovery_failed');
assert.equal(readFailure.jobs.recovery[0].failureCategory, 'RECOVERY');
assert.equal(releaseCalls, beforeReadFailure.releaseCalls, 'an unconfirmed post-poll read must not release credits');
assert.equal(alerts, beforeReadFailure.alerts + 1);
assert.equal(notifications, beforeReadFailure.notifications + 1);

readError = null;
driveError = null;
for (const payload of [{ data: {} }, { data: { status: 'completed' } }]) {
  providerPayload = payload;
  actionableStatus = 'provider_rendering';
  afterStatus = 'provider_rendering';
  const beforeMalformed = { releaseCalls, alerts, notifications };
  const malformed = await runWatchdogSweep();
  assert.equal(malformed.jobs.recovery[0].outcome, 'recovery_failed');
  assert.equal(malformed.jobs.recovery[0].failureCategory, 'PROVIDER_RESPONSE');
  assert.equal(releaseCalls, beforeMalformed.releaseCalls, 'malformed provider status must hold credits');
  assert.equal(alerts, beforeMalformed.alerts + 1);
  assert.equal(notifications, beforeMalformed.notifications + 1);
}
providerPayload = null;

readError = null;
actionableStatus = 'provider_rendering';
afterStatus = 'provider_rendering';
driveResultStatus = null;
const beforeConfirmedUnresolved = { releaseCalls, alerts, notifications };
const confirmedUnresolved = await runWatchdogSweep();
assert.equal(confirmedUnresolved.timedOut, 1);
assert.equal(confirmedUnresolved.alerted, 0);
assert.deepEqual(confirmedUnresolved.jobs.recovery, [{
  jobId: job.id,
  outcome: 'timed_out',
  status: 'provider_rendering',
}]);
assert.equal(releaseCalls, beforeConfirmedUnresolved.releaseCalls + 1, 'only a successful provider check may reach timeout release');
assert.equal(alerts, beforeConfirmedUnresolved.alerts + 1, 'the confirmed timeout remains observable');
assert.equal(notifications, beforeConfirmedUnresolved.notifications + 1);

actionableStatus = 'provider_ready';
afterStatus = 'provider_ready';
driveResultStatus = 'finish_contained';
const beforeContainedFinish = { releaseCalls, alerts, notifications };
const containedFinish = await runWatchdogSweep();
assert.equal(lastDrivenStatus, 'provider_ready', 'regression starts from the actionable provider_ready stage');
assert.equal(containedFinish.recovered, 0, 'contained finishing still needs manual review');
assert.equal(containedFinish.timedOut, 0, 'contained finishing is not a provider timeout');
assert.equal(containedFinish.alerted, 1);
assert.deepEqual(containedFinish.jobs.alertedIds, [job.id]);
assert.deepEqual(containedFinish.jobs.recovery, [{
  jobId: job.id,
  outcome: 'recovery_failed',
  status: 'finish_contained',
  failureCategory: 'CONFIG_MISSING',
}]);
assert.equal(releaseCalls, beforeContainedFinish.releaseCalls, 'provider_ready -> finish_contained must keep reserved credits held');
assert.equal(alerts, beforeContainedFinish.alerts + 1, 'contained finishing must emit an operations alert');
assert.equal(notifications, beforeContainedFinish.notifications + 1, 'contained finishing must notify the configured operator channel');
