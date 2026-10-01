import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { assertJobTransition } from '../../db/repositories.js';

let job;
let settlements = 0;
let renders = 0;
mock.module('../../db/repositories.js', { namedExports: {
  getJob: async () => job,
  requireJobRenderAuthorization: async () => {},
  markJobFailedAndRelease: async () => {},
  transitionJob: async ({ stageTo }) => { assertJobTransition(job.status, stageTo); job = { ...job, status: stageTo }; return job; },
  finalizeReadyJob: async () => { assert.equal(job.status, 'finishing'); settlements++; job = { ...job, status: 'ready', output: { synthetic: true } }; return job; },
} });
mock.module('../../db/client.js', { namedExports: { database: () => ({ transaction: fn => fn({}) }) } });
mock.module('../../db/standard-narration-repository.js', { namedExports: { standardNarrationRepository: { resolveSources: async () => ({ input: {}, assets: {} }) } } });
mock.module('../../services/sadtalker-simulator.js', { namedExports: { renderStandardSimulation: async () => { renders++; return { synthetic: true }; } } });
mock.module('../../lib/video-os-render-notify.js', { namedExports: { notifyRenderReady: async () => {} } });
process.env.VIDEO_OS_STANDARD_PROVIDER = 'simulation';
const { resolveAndRender } = await import('../../workflows/standard-render.js');
for (const status of ['workflow_started', 'provider_submitting', 'provider_submitted', 'provider_rendering', 'provider_ready', 'finishing']) {
  job = { id: 'simulation-job', accountId: 'simulation-owner', provider: 'sadtalker', status, input: {}, format: 'landscape' };
  settlements = 0; renders = 0;
  assert.deepEqual(await resolveAndRender(job.id), { synthetic: true });
  assert.equal(job.status, 'ready'); assert.equal(settlements, 1); assert.equal(renders, 1);
  await resolveAndRender(job.id);
  assert.equal(settlements, 1); assert.equal(renders, 1);
}
job.status = 'provider_submit_unknown';
await assert.rejects(resolveAndRender(job.id), error => error.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN');
job.status = 'provider_rendering'; job.providerJobId = 'existing-remote-job';
await assert.rejects(resolveAndRender(job.id), error => error.failureCategory === 'PROVIDER_SUBMIT_UNKNOWN');
