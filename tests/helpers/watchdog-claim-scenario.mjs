import assert from 'node:assert/strict';
import { mock } from 'node:test';

process.env.DATABASE_URL = '';
const job = { id: 'synthetic-watchdog-job', accountId: 'synthetic-account', status: 'provider_rendering', createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000), updatedAt: new Date(Date.now() - 60 * 60_000) };
const secondJob = { ...job, id: 'synthetic-watchdog-job-2', status: 'workflow_started', createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) };
let bucket = 'actionable';
let claimFails = false;
let releaseRace = false;
let recoveryCalls = 0;
let releaseCalls = 0;
let alerts = 0;
let notifications = 0;
let storeWarnings = 0;
let lastNotice;
let afterRecoveryStatus = 'ready';
const sentryLevels = [];
const claimed = new Set();
const claimArgs = [];

mock.module('../../db/repositories.js', { namedExports: {
  WATCHDOG_STALE_MINUTES_DEFAULT: 30,
  listStalledActionableJobs: async () => ['actionable', 'mixed'].includes(bucket) ? [job] : [],
  listStalledAmbiguousJobs: async () => bucket === 'ambiguous' ? [job] : bucket === 'mixed' ? [secondJob] : bucket === 'many' ? [job, secondJob] : [],
  listStalledSafeToReleaseJobs: async () => bucket === 'safe' ? [job] : [],
  claimWatchdogJobs: async jobs => {
    claimArgs.push(jobs);
    if (claimFails) throw new Error('claim unavailable');
    if (jobs.some(current => claimed.has(current.id))) return false;
    jobs.forEach(current => claimed.add(current.id));
    return true;
  },
  getJob: async () => ({ ...job, status: afterRecoveryStatus }),
  markJobFailedAndRelease: async (_id, _category, _message, _artifact, options) => {
    releaseCalls++;
    assert.deepEqual(options.expectedStatuses, bucket === 'safe' ? ['reserved'] : [afterRecoveryStatus]);
    assert.deepEqual(options.expectedUpdatedAt, job.updatedAt);
    assert.equal(options.withTransition, true);
    return releaseRace
      ? { job: { ...job, status: 'workflow_started' }, transitioned: false }
      : { job: { ...job, status: 'failed' }, transitioned: true };
  },
} });
mock.module('../../lib/video-os-render-driver.js', { namedExports: {
  driveJob: async () => { recoveryCalls++; await new Promise(resolve => setTimeout(resolve, 20)); },
} });
mock.module('../../lib/video-os-observability.js', { namedExports: {
  captureJobError: (_error, context) => {
    if (context?.failureCategory === 'ESCALATION_STORE_UNAVAILABLE') storeWarnings++;
    else alerts++;
  },
} });
mock.module('@sentry/node', { namedExports: {
  withScope: callback => callback({ setLevel: level => sentryLevels.push(level) }),
} });
mock.module('../../lib/video-os-watchdog-notify.js', { namedExports: {
  claimWatchdogEscalation: async () => true,
  notifyWatchdogSweep: async result => {
    lastNotice = result;
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
assert.deepEqual(claimArgs.at(-1).map(current => current.id), [secondJob.id, job.id]);
const completed = mixed.find(result => result.claimConflicts === 0);
assert.equal(completed.severity, 'critical');
assert.ok(sentryLevels.includes('fatal'), 'first critical escalation must use Sentry fatal level');
assert.ok(completed.oldestStaleAgeMinutes >= 31 * 24 * 60 - 1);
assert.deepEqual(completed.staleJobs.map(item => item.jobId), [secondJob.id, job.id]);
assert.ok(completed.staleJobs.every(item => item.ageMinutes > item.staleMinutes));
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
claimFails = false;

// A broken marker store must not mute stuck-job alerts, and fallback claims
// remain bounded per job/level across sweeps in this process.
const logs = [];
const originalError = console.error;
console.error = (...args) => logs.push(args);
try {
  bucket = 'ambiguous';
  job.id = 'synthetic-watchdog-fallback';
  const unavailable = async () => { throw new Error('private store detail'); };
  claimed.clear();
  const first = await runWatchdogSweep({ escalationGate: unavailable });
  assert.deepEqual(first.notificationJobIds, [job.id]);
  assert.equal(first.severity, 'critical');
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], ['watchdog.escalation_store_unavailable', { event: 'watchdog.escalation_store_unavailable' }]);
  assert.equal(storeWarnings, 1);
  claimed.clear();
  const second = await runWatchdogSweep({ escalationGate: unavailable });
  assert.deepEqual(second.notificationJobIds, []);
  assert.equal(logs.length, 2, 'each failed sweep logs exactly once');
  assert.equal(storeWarnings, 2);
  assert.equal(alerts - before.alerts, 1, 'a deduped sweep must not send another job event to Sentry');
  bucket = 'many';
  secondJob.id = 'synthetic-watchdog-fallback-2';
  claimed.clear();
  const beforeMany = { logs: logs.length, warnings: storeWarnings };
  const many = await runWatchdogSweep({ escalationGate: unavailable });
  assert.deepEqual(many.notificationJobIds, [secondJob.id]);
  assert.equal(logs.length - beforeMany.logs, 1, 'multiple failing claims log once per sweep');
  assert.equal(storeWarnings - beforeMany.warnings, 1, 'multiple failing claims warn Sentry once per sweep');

  // Once the store recovers, its own critical/warn claims govern delivery.
  bucket = 'ambiguous';
  const persisted = new Set();
  const recoveredGate = async (_id, level) => {
    if (persisted.has(level)) return false;
    persisted.add(level);
    return true;
  };
  claimed.clear();
  const recovered = await runWatchdogSweep({ escalationGate: recoveredGate });
  assert.deepEqual(recovered.notificationJobIds, [job.id]);
  assert.deepEqual([...persisted], ['critical'], 'held fallback critical covers warn');
  claimed.clear();
  const deduped = await runWatchdogSweep({ escalationGate: recoveredGate });
  assert.deepEqual(deduped.notificationJobIds, []);

  job.id = 'synthetic-watchdog-warn-fallback';
  claimed.clear();
  const warned = await runWatchdogSweep({ escalationGate: async (_id, level) => level === 'warn' });
  assert.equal(warned.severity, 'warn');
  assert.deepEqual(warned.notificationJobIds, [job.id]);
  assert.equal(sentryLevels.at(-1), 'warning');
  job.id = 'synthetic-watchdog-job';

  bucket = 'safe';
  releaseRace = false;
  claimed.clear();
  const releasedNotice = await runWatchdogSweep({ escalationGate: unavailable });
  assert.equal(releasedNotice.released, 1);
  assert.deepEqual(releasedNotice.notificationJobIds, [job.id]);
  assert.equal(lastNotice.released, 1);

  bucket = 'actionable';
  afterRecoveryStatus = 'provider_rendering';
  claimed.clear();
  const timedOutNotice = await runWatchdogSweep({ escalationGate: unavailable });
  assert.equal(timedOutNotice.timedOut, 1);
  assert.deepEqual(timedOutNotice.notificationJobIds, [job.id]);
  assert.equal(lastNotice.timedOut, 1);
} finally {
  console.error = originalError;
}
