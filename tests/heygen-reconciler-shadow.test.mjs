import assert from 'node:assert/strict';
import test from 'node:test';
import { heygenReconcilerMode, heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';
import { prepareOpsEvent } from '../lib/ops-log.js';
import { reconcileUnknownHeygenJob, reconcileUnknownHeygenJobs } from '../services/heygen-reconciliation.js';
import { runHeygenReconciliationIfDue } from '../worker/render-worker.mjs';

const marker = heygenSubmissionIdentity('shadow-fixture').marker;
const job = { id: 'shadow-fixture', accountId: 'account-1', correlationId: 'corr-1', provider: 'heygen', status: 'provider_submit_unknown',
  output: { heygenSubmission: { ...heygenSubmissionIdentity('shadow-fixture'), claimedAt: '2026-10-14T10:00:00Z', retryCount: 0 } } };
const env = { VIDEO_OS_HEYGEN_RECONCILER_MODE: 'shadow', VIDEO_OS_HEYGEN_RECONCILE_GRACE_SECONDS: '60', HEYGEN_API_KEY: 'synthetic-api-key' };
const now = () => new Date('2026-10-14T12:00:00Z');

test('mode parsing has explicit precedence and fails closed', () => {
  for (const [input, expected] of [
    [{}, 'off'], [{ VIDEO_OS_HEYGEN_RECONCILER_MODE: ' OFF ' }, 'off'],
    [{ VIDEO_OS_HEYGEN_RECONCILER_MODE: ' shadow ' }, 'shadow'],
    [{ VIDEO_OS_HEYGEN_RECONCILER_MODE: 'ACT' }, 'act'],
    [{ VIDEO_OS_HEYGEN_RECONCILER_MODE: 'garbage', VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: 'true' }, 'off'],
    [{ VIDEO_OS_HEYGEN_RECONCILER_MODE: ' ', VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: ' TRUE ' }, 'off'],
    [{ VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: 'true' }, 'act'],
    [{ VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: '1' }, 'off'],
  ]) assert.equal(heygenReconcilerMode(input), expected);
});

test('off avoids inventory, mutation and ops events', async () => {
  const fail = () => { throw new Error('off path touched dependency'); };
  const options = { env: {}, lookup: fail, bind: fail, release: fail, resolveBinding: fail, opsLogger: fail, listJobs: fail };
  assert.deepEqual(await reconcileUnknownHeygenJob(job, options), { outcome: 'disabled' });
  assert.deepEqual(await reconcileUnknownHeygenJobs(options), []);
});

test('shadow decisions preserve held job for every branch and log one safe decision', async () => {
  const cases = [
    ['found', { complete: true, pages: 2, truncated: false, items: [{ title: `secret title [${marker}]`, video_id: 'video-1', status: 'completed' }] }, 'bind_found', 'single_match'],
    ['absent', { complete: true, pages: 1, items: [] }, 'release_same_key_retry', 'verified_absence'],
    ['multiple', { complete: true, items: [{ title: `[${marker}]`, video_id: 'video-1' }, { title: `[${marker}]`, video_id: 'video-2' }] }, 'attention', 'multiple_matches'],
    ['invalid', { complete: true, items: [{ title: `[${marker}]`, video_id: 'bad/id' }] }, 'attention', 'invalid_match'],
    ['incomplete', { complete: false, truncated: true, items: [] }, 'attention', 'incomplete_inventory'],
  ];
  for (const [label, inventory, action, reason] of cases) {
    const before = structuredClone(job);
    const events = [];
    const fail = () => { throw new Error(`${label} wrote job state`); };
    const result = await reconcileUnknownHeygenJob(job, { env, now, lookup: async () => inventory,
      bind: fail, release: fail, resolveBinding: fail, opsLogger: async input => events.push(input) });
    assert.equal(result.outcome, 'shadow', label);
    assert.equal(result.proposedAction, action, label);
    assert.equal(result.reason, reason, label);
    assert.deepEqual(job, before, label);
    assert.equal(events.length, 1, label);
    const row = prepareOpsEvent(events[0]).row;
    assert.equal(row.event, 'heygen.reconciler.shadow_decision');
    assert.equal(row.entityId, job.id);
    assert.equal(row.correlationId, job.correlationId);
    assert.equal(row.details.proposedAction, action);
    assert.equal(row.details.marker, marker);
    assert.equal(JSON.stringify(row).includes('secret title'), false);
    assert.equal(JSON.stringify(row).includes(job.output.heygenSubmission.idempotencyKey), false);
    assert.equal(JSON.stringify(row).includes(env.HEYGEN_API_KEY), false);
  }
});

test('shadow holds thrown lookup, grace, first-claim expiry, retry limit and missing identity', async () => {
  const fail = () => { throw new Error('mutation attempted'); };
  const common = { env, now, bind: fail, release: fail, resolveBinding: fail, opsLogger: async () => {} };
  const empty = async () => ({ complete: true, items: [] });
  const variants = [
    [{ ...common, lookup: async () => { throw new Error('private URL https://example.com'); } }, job, 'incomplete_inventory'],
    [{ ...common, lookup: empty }, { ...job, output: { heygenSubmission: { ...job.output.heygenSubmission, claimedAt: '2026-10-14T11:59:30Z' } } }, 'grace_period'],
    [{ ...common, lookup: empty }, { ...job, output: { heygenSubmission: { ...job.output.heygenSubmission, firstClaimedAt: '2026-10-13T11:00:00Z' } } }, 'idempotency_window_expired'],
    [{ ...common, lookup: empty }, { ...job, output: { heygenSubmission: { ...job.output.heygenSubmission, retryCount: 6 } } }, 'ambiguous_retry_limit'],
    [{ ...common, lookup: fail }, { ...job, output: {} }, 'missing_submission_identity'],
  ];
  for (const [options, held, reason] of variants) {
    const result = await reconcileUnknownHeygenJob(held, options);
    assert.equal(result.outcome, 'shadow');
    assert.equal(result.reason, reason);
  }
});

test('shadow provider transport only GETs paginated v3 inventory', async () => {
  const requests = [];
  const fail = () => { throw new Error('mutation attempted'); };
  const result = await reconcileUnknownHeygenJob(job, { env, now, bind: fail, release: fail, resolveBinding: fail,
    opsLogger: async () => {}, fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ parsed, options });
      return Response.json(requests.length === 1
        ? { data: [], has_more: true, next_token: 'private-cursor' }
        : { data: [{ title: `[${marker}]`, video_id: 'video-1' }], has_more: false });
    } });
  assert.equal(result.proposedAction, 'bind_found');
  assert.equal(requests.length, 2);
  for (const { parsed, options } of requests) {
    assert.equal(options?.method ?? 'GET', 'GET');
    assert.equal(parsed.pathname, '/v3/videos');
    assert.equal(parsed.searchParams.get('title'), marker);
    assert.equal(parsed.searchParams.has('next_token'), false);
  }
  assert.equal(requests[1].parsed.searchParams.get('token'), 'private-cursor');
});

test('batch writes one shadow summary and act writes an act decision', async () => {
  const events = [];
  await reconcileUnknownHeygenJobs({ env, now, listJobs: async () => [job], lookup: async () => ({ complete: true, pages: 1, items: [] }),
    bind: () => { throw new Error('bind'); }, release: () => { throw new Error('release'); }, resolveBinding: () => { throw new Error('binding'); },
    opsLogger: async input => events.push(input) });
  assert.deepEqual(events.map(event => event.event), ['heygen.reconciler.shadow_decision', 'heygen.reconciler.shadow_run']);
  assert.equal(prepareOpsEvent(events[1]).row.details.jobsScanned, 1);
  assert.equal(prepareOpsEvent(events[1]).row.details.byProposedAction.release_same_key_retry, 1);
  assert.equal(prepareOpsEvent(events[1]).row.details.listCalls, 1);
  const actEvents = [];
  let binds = 0;
  const found = await reconcileUnknownHeygenJob(job, { env: { VIDEO_OS_HEYGEN_RECONCILER_MODE: 'act' }, now,
    lookup: async () => ({ complete: true, items: [{ title: `[${marker}]`, video_id: 'video-1' }] }),
    resolveBinding: async () => ({ applicationAccountId: job.accountId }), bind: async () => { binds++; },
    opsLogger: async input => actEvents.push(input) });
  assert.deepEqual(found, { outcome: 'found', providerJobId: 'video-1' });
  assert.equal(binds, 1);
  assert.equal(actEvents[0].event, 'heygen.reconciler.act_decision');
});

test('ops persistence failure does not change shadow decision', async () => {
  const result = await reconcileUnknownHeygenJob(job, { env, now, lookup: async () => ({ complete: true, items: [] }),
    opsLogger: async () => { throw new Error('offline ops store'); },
    resolveBinding: () => { throw new Error('binding read'); }, release: () => { throw new Error('release write'); } });
  assert.equal(result.proposedAction, 'release_same_key_retry');
});

test('act batch records an attention decision when binding fails', async () => {
  const events = [];
  const results = await reconcileUnknownHeygenJobs({ env: { VIDEO_OS_HEYGEN_RECONCILER_MODE: 'act' }, now,
    listJobs: async () => [job], lookup: async () => ({ complete: true, items: [{ title: `[${marker}]`, video_id: 'video-1' }] }),
    resolveBinding: async () => { throw new Error('synthetic failure'); },
    bind: () => { throw new Error('must not bind'); }, opsLogger: async input => events.push(input) });
  assert.deepEqual(results, [{ jobId: job.id, outcome: 'attention', reason: 'lookup_or_binding_failed' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'heygen.reconciler.act_decision');
  assert.equal(prepareOpsEvent(events[0]).row.details.reason, 'lookup_or_binding_failed');
});

test('ops row allow list excludes hostile fields and values', () => {
  const fullKey = job.output.heygenSubmission.idempotencyKey;
  const row = prepareOpsEvent({ event: 'heygen.reconciler.shadow_decision', entityType: 'job', entityId: job.id,
    details: { mode: 'shadow', marker, heygenVideoId: fullKey, heygenStatus: 'https://private.example',
      next_token: 'cursor', apiKey: 'synthetic-api-key', title: 'private title', email: 'x@example.com',
      script: 'private script', url: 'https://private.example' } }).row;
  const encoded = JSON.stringify(row);
  for (const secret of [fullKey, 'cursor', 'synthetic-api-key', 'private title', 'x@example.com', 'private script', 'https://private.example']) assert.equal(encoded.includes(secret), false);
  assert.equal(row.details.marker, marker);
  assert.equal(row.details.heygenVideoId, null);
});

test('worker shadow runs when due and off never reconciles', async () => {
  let calls = 0;
  const reconcile = async ({ mode }) => { calls++; assert.equal(mode, 'shadow'); return []; };
  assert.equal((await runHeygenReconciliationIfDue({ env, nowMs: 59_999, lastRunAt: 1, reconcile })).ran, false);
  assert.equal((await runHeygenReconciliationIfDue({ env: {}, nowMs: 100_000, reconcile })).ran, false);
  assert.equal((await runHeygenReconciliationIfDue({ env, nowMs: 60_000, reconcile })).ran, true);
  assert.equal(calls, 1);
});
