import assert from 'node:assert/strict';
import { mock } from 'node:test';

process.env.DATABASE_URL = '';
const job = { id: 'synthetic-watchdog-job', accountId: 'synthetic-account', status: 'provider_rendering', updatedAt: new Date('2026-10-17T00:00:00.000Z') };
const secondJob = { ...job, id: 'synthetic-watchdog-job-2', status: 'provider_submitting' };
let bucket = 'actionable';
let claimFails = false;
let releaseRace = false;
let recoveryCalls = 0;
let releaseCalls = 0;
let alerts = 0;
let notifications = 0;
const claimed = new Set();
const claimArgs = [];

mock.module('../../db/repositories.js', { namedExports: {
  WATCHDOG_STALE_MINUTES_DEFAULT: 30,
  listStalledActionableJobs: async () => ['actionable', 'mixed'].includes(bucket) ? [job] : [],
  listStalledAmbiguousJobs: async () => bucket === 'ambiguous' ? [job] : bucket === 'mixed' ? [secondJob] : [],
  listStalledSafeToReleaseJobs: async () => bucket === 'safe' ? [job] : [],
  claimWatchdogJobs: async jobs => {
    claimArgs.push(jobs);
    if (claimFails) throw new Error('claim unavailable');
    if (jobs.some(current => claimed.has(current.id))) return false;
    jobs.forEach(current => claimed.add(current.id));
    return true;
  },
  getJob: async () => ({ ...job, status: 'ready' }),
  markJobFailedAndRelease: async (_id, _category, _message, _artifact, options) => {
    releaseCalls++;
    assert.deepEqual(options.expectedStatuses, ['reserved']);
    assert.deepEqual(options.expectedUpdatedAt, job.updatedAt);
    assert.equal(options.withTransition, true);
    return releaseRace
      ? { job: { ...job, status: 'workflow_started' }, transitioned: false }
      : { job: { ...job, status: 'failed' }, transitioned: true };
  },
} });
mock.module('../../lib/video-os-render-driver.js', { namedExports: {
  driveJobSafely: async () => { recoveryCalls++; await new Promise(resolve => setTimeout(resolve, 20)); },
} });
mock.module('../../lib/video-os-observability.js', { namedExports: {
  captureJobError: () => { alerts++; },
} });
mock.module('../../lib/video-os-watchdog-notify.js', { namedExports: {
  notifyWatchdogSweep: async result => {
    if (result.recovered || result.timedOut || result.alerted || result.released) notifications++;
  },
} });
mock.module('../../lib/provider-consent-url-cleanup.js', { namedExports: {
  sweepExpiredHostedConsentUrls: async () => ({}),
} });

const { runWatchdogSweep } = await import('../../lib/video-os-watchdog.js');

for (const selected of ['actionable', 'ambiguous', 'safe']) {
  bucket = selected;
  claimed.clear();
  const before = { recoveryCalls, releaseCalls, alerts, notifications };
  const results = await Promise.all([runWatchdogSweep(), runWatchdogSweep()]);
  assert.deepEqual(results.map(result => result.claimConflicts).sort(), [0, 1]);
  assert.equal(results.reduce((count, result) => count + result.recovered + result.alerted + result.released, 0), 1);
  assert.equal(notifications - before.notifications, 1);
  assert.equal(recoveryCalls - before.recoveryCalls, selected === 'actionable' ? 1 : 0);
  assert.equal(releaseCalls - before.releaseCalls, selected === 'safe' ? 1 : 0);
  assert.equal(alerts - before.alerts, selected === 'ambiguous' || selected === 'safe' ? 1 : 0);
}

assert.ok(claimArgs.every(args => args.length === 1 && args[0].id === job.id));
bucket = 'mixed';
claimed.clear();
const beforeMixed = { recoveryCalls, alerts, notifications };
const mixed = await Promise.all([runWatchdogSweep(), runWatchdogSweep()]);
assert.deepEqual(mixed.map(result => result.claimConflicts).sort(), [0, 2]);
assert.equal(recoveryCalls - beforeMixed.recoveryCalls, 1);
assert.equal(alerts - beforeMixed.alerts, 1);
assert.equal(notifications - beforeMixed.notifications, 1);
assert.deepEqual(claimArgs.at(-1).map(current => current.id), [job.id, secondJob.id]);
bucket = 'safe';
claimed.clear();
releaseRace = true;
const alertsBeforeRace = alerts;
const noticesBeforeRace = notifications;
const race = await runWatchdogSweep();
assert.equal(race.safeToReleaseFound, 1);
assert.equal(race.released, 0);
assert.equal(alerts, alertsBeforeRace);
assert.equal(notifications, noticesBeforeRace);
claimFails = true;
claimed.clear();
bucket = 'actionable';
const before = { recoveryCalls, releaseCalls, alerts, notifications };
await assert.rejects(runWatchdogSweep(), /claim unavailable/);
assert.deepEqual({ recoveryCalls, releaseCalls, alerts, notifications }, before);
