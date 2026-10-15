// QA-only: real-module mocks; shadow must never reach repository/binding functions, even via defaults.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const calls = { transitionJob: 0, releaseHeygenUnknownForRetry: 0, resolveFreshHeygenSpaceBinding: 0, listHeygenUnknownJobs: 0 };
let jobs = [];
mock.module('../../db/repositories.js', { namedExports: {
  transitionJob: async () => { calls.transitionJob++; return {}; },
  releaseHeygenUnknownForRetry: async () => { calls.releaseHeygenUnknownForRetry++; return true; },
  listHeygenUnknownJobs: async () => { calls.listHeygenUnknownJobs++; return jobs; },
} });
mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
  resolveFreshHeygenSpaceBinding: async () => { calls.resolveFreshHeygenSpaceBinding++; return { applicationAccountId: 'acct' }; },
} });
const { heygenSubmissionIdentity } = await import('../../lib/heygen-provider-safety.js');
const { reconcileUnknownHeygenJobs, reconcileUnknownHeygenJob } = await import('../../services/heygen-reconciliation.js');
const id = heygenSubmissionIdentity('job-qa-shadow');
const mk = (claimedAt, jobId = 'job-qa-shadow') => ({ id: jobId, accountId: 'acct', provider: 'heygen', status: 'provider_submit_unknown',
  output: { heygenSubmission: { ...id, claimedAt } } });
const now = () => new Date('2026-10-15T12:00:00Z');
const requests = [];
const fetchFor = pages => async (url, init = {}) => { requests.push({ url: new URL(url), method: init.method ?? 'GET', body: init.body }); return Response.json(pages.shift()); };
const scenarios = {
  found: [mk('2026-10-15T11:00:00Z'), [{ data: [{ title: `x [${id.marker}]`, id: 'v_found' }], has_more: false }]],
  absentPastGrace: [mk('2026-10-15T10:00:00Z'), [{ data: [], has_more: false }]],
  inGrace: [mk('2026-10-15T11:59:00Z'), [{ data: [], has_more: false }]],
  multiple: [mk('2026-10-15T10:00:00Z'), [{ data: [{ title: `[${id.marker}]`, id: 'a' }, { title: `[${id.marker}]`, id: 'b' }], has_more: false }]],
  incomplete: [mk('2026-10-15T10:00:00Z'), [{ data: [] }]],
  paged: [mk('2026-10-15T10:00:00Z'), [{ data: [], has_more: true, next_token: 'c2' }, { data: [], has_more: false }]],
};
const reset = () => { for (const k of Object.keys(calls)) calls[k] = 0; };
for (const [name, [job, pages]] of Object.entries(scenarios)) {
  for (const via of ['env', 'explicit']) {
    test(`shadow (${via}) ${name}: zero real repository/binding writes or reads`, async () => {
      reset(); jobs = [job];
      const env = { HEYGEN_API_KEY: 'synthetic-only', ...(via === 'env' ? { VIDEO_OS_HEYGEN_RECONCILER_MODE: ' Shadow ' } : {}) };
      const results = await reconcileUnknownHeygenJobs({ env, ...(via === 'explicit' ? { mode: 'shadow' } : {}), now, fetchImpl: fetchFor(structuredClone(pages)), opsLogger: async () => {} });
      assert.equal(results.length, 1); assert.equal(results[0].outcome, 'shadow');
      assert.deepEqual([calls.transitionJob, calls.releaseHeygenUnknownForRetry, calls.resolveFreshHeygenSpaceBinding], [0, 0, 0]);
      assert.equal(calls.listHeygenUnknownJobs, 1);
    });
  }
}
test('shadow single-job entry point with defaults also never reaches repositories', async () => {
  reset();
  for (const [job, pages] of Object.values(scenarios)) await reconcileUnknownHeygenJob(job, { env: { HEYGEN_API_KEY: 'synthetic-only', VIDEO_OS_HEYGEN_RECONCILER_MODE: 'shadow' }, now, fetchImpl: fetchFor(structuredClone(pages)), opsLogger: async () => {} });
  assert.deepEqual([calls.transitionJob, calls.releaseHeygenUnknownForRetry, calls.resolveFreshHeygenSpaceBinding], [0, 0, 0]);
});
test('control: act reaches the same mocked functions (mock is wired)', async () => {
  reset();
  await reconcileUnknownHeygenJob(scenarios.found[0], { env: { HEYGEN_API_KEY: 'synthetic-only', VIDEO_OS_HEYGEN_RECONCILER_MODE: 'act' }, now, fetchImpl: fetchFor(structuredClone(scenarios.found[1])), opsLogger: async () => {} });
  await reconcileUnknownHeygenJob(scenarios.absentPastGrace[0], { env: { HEYGEN_API_KEY: 'synthetic-only', VIDEO_OS_HEYGEN_RECONCILER_MODE: 'act' }, now, fetchImpl: fetchFor(structuredClone(scenarios.absentPastGrace[1])), opsLogger: async () => {} });
  assert.deepEqual([calls.transitionJob, calls.releaseHeygenUnknownForRetry, calls.resolveFreshHeygenSpaceBinding], [1, 1, 2]);
});
test('off: no list, no fetch, no logging', async () => {
  reset(); const before = requests.length; let logs = 0;
  assert.deepEqual(await reconcileUnknownHeygenJobs({ env: { VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: 'true', VIDEO_OS_HEYGEN_RECONCILER_MODE: 'nope' }, opsLogger: async () => { logs++; } }), []);
  assert.equal(calls.listHeygenUnknownJobs, 0); assert.equal(requests.length, before); assert.equal(logs, 0);
});
test('provider traffic: only GET https://api.heygen.com/v3/videos with title, limit, token', () => {
  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.method, 'GET'); assert.equal(r.body, undefined);
    assert.equal(r.url.origin + r.url.pathname, 'https://api.heygen.com/v3/videos');
    for (const k of r.url.searchParams.keys()) assert.ok(['title', 'limit', 'token'].includes(k), k);
    assert.equal(r.url.searchParams.get('title'), id.marker); assert.equal(r.url.searchParams.get('limit'), '100');
  }
  assert.ok(requests.some(r => r.url.searchParams.get('token') === 'c2'));
});
