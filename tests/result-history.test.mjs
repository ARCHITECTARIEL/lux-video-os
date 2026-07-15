import assert from 'node:assert/strict';
import test from 'node:test';

import { RESULT_HISTORY_LIMIT, limitRecentJobs } from '../lib/video-os-account.js';

test('result history returns the newest thirty jobs in deterministic order', () => {
  const jobs = Array.from({ length: 35 }, (_, index) => ({
    id: `job-${index}`,
    updatedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
  })).reverse();

  const results = limitRecentJobs(jobs);

  assert.equal(RESULT_HISTORY_LIMIT, 30);
  assert.equal(results.length, 30);
  assert.equal(results[0].id, 'job-34');
  assert.equal(results.at(-1).id, 'job-5');
});

test('result history prefers updatedAt and tolerates missing input', () => {
  const results = limitRecentJobs([
    { id: 'older-created', createdAt: '2026-07-01T00:00:00.000Z' },
    { id: 'recently-updated', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' },
  ]);

  assert.deepEqual(results.map((job) => job.id), ['recently-updated', 'older-created']);
  assert.deepEqual(limitRecentJobs(null), []);
});