import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

if (process.argv.includes('--deadline-fixture')) {
  const service = await import('../services/sadtalker-runpod.js');
  const calls = [];
  let polls = 0;
  const job = { id: 'local-job-1', accountId: 'local-account', correlationId: 'local-correlation', status: 'workflow_started', input: {}, format: 'vertical', title: 'local' };
  mock.module('workflow', { namedExports: { FatalError: class FatalError extends Error {}, sleep: async () => {} } });
  mock.module('../db/client.js', { namedExports: { database: () => ({ transaction: work => work({}) }) } });
  mock.module('../db/standard-narration-repository.js', { namedExports: { standardNarrationRepository: { resolveSources: async () => ({ input: {}, assets: {} }) } } });
  mock.module('../lib/video-os-render-notify.js', { namedExports: { notifyRenderReady: async () => {} } });
  mock.module('../db/repositories.js', { namedExports: {
    finalizeReadyJob: async () => null,
    getJob: async () => job,
    requireJobRenderAuthorization: async () => true,
    markJobFailedAndRelease: async () => null,
    transitionJob: async input => { job.status = input.stageTo; return job; },
  } });
  mock.module('../services/sadtalker-runpod.js', { namedExports: {
    ...service,
    cancelRunpodStandard: async id => { calls.push(id); return { cancelRequested: true }; },
    standardProviderMode: () => 'runpod',
    submitRunpodStandard: async () => ({ providerJobId: 'local-provider-job' }),
    pollRunpodStandard: async () => { polls += 1; return { ready: false, status: 'IN_PROGRESS' }; },
  } });
  const workflow = await import('../workflows/standard-render.js');
  test('loop exit cancels the provider job before reporting timeout', async () => {
    await assert.rejects(workflow.cancelStandardOnDeadline('local-job-1'), { failureCategory: 'PROVIDER_TIMEOUT' });
    assert.deepEqual(calls, ['local-job-1']);
  });
  test('poll bound follows the configured provider timeout beyond 30 minutes', () => {
    assert.equal(workflow.standardPollLimit({ VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS: '3600000' }), 242);
    assert.equal(workflow.standardPollLimit({ VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS: '1800000' }), 122);
  });
  test('workflow loop exhaustion requests cancellation', async () => {
    const prior = process.env.VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS;
    process.env.VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS = '1000';
    try {
      await assert.rejects(workflow.standardRenderWorkflow(job.id), { failureCategory: 'PROVIDER_TIMEOUT' });
      assert.equal(polls, 3);
      assert.deepEqual(calls, ['local-job-1', 'local-provider-job']);
    } finally {
      if (prior === undefined) delete process.env.VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS;
      else process.env.VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS = prior;
    }
  });
} else {
  test('Standard workflow deadline and cancellation', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)), '--deadline-fixture',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
