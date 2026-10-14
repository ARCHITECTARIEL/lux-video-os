import assert from 'node:assert/strict';
import test from 'node:test';
import { HEYGEN_ACTIVE_STATUSES, heygenCapacityAvailable, heygenLimits, heygenRetryDelayMs, heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';
import { submitHeygen } from '../services/heygen.js';
import { reconcileUnknownHeygenJob } from '../services/heygen-reconciliation.js';
import { cancelRunpodStandard, pollRunpodStandard } from '../services/sadtalker-runpod.js';
import { classifyFailure } from '../lib/video-os-operations.js';

const env = { HEYGEN_API_KEY: 'synthetic-only' };
const job = { id: 'job-safe-1', title: 'A title', format: 'vertical', input: { avatar: { avatarId: 'avatar-1' }, voice: { voiceId: 'voice-1' }, script: 'Hello' } };

test('HeyGen admission statuses are the shared active-status contract', () => {
  assert.deepEqual(HEYGEN_ACTIVE_STATUSES, ['provider_submitting', 'provider_submitted', 'provider_rendering', 'provider_submit_unknown']);
});

test('HeyGen limits clamp and ambiguous submissions retain a conservative slot', () => {
  assert.equal(classifyFailure({ failureCategory: 'PROVIDER_RETRY_DEFERRED' }), 'PROVIDER_RETRY_DEFERRED');
  assert.deepEqual(heygenLimits({}), { global: 8, perAccount: 2, maxRetries: 6 });
  assert.deepEqual(heygenLimits({ VIDEO_OS_HEYGEN_MAX_CONCURRENCY: '99', VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT: '99' }), { global: 10, perAccount: 10, maxRetries: 6 });
  assert.deepEqual(heygenLimits({ VIDEO_OS_HEYGEN_MAX_CONCURRENCY: '1', VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT: '0' }), { global: 1, perAccount: 1, maxRetries: 6 });
  assert.deepEqual(heygenLimits({ VIDEO_OS_HEYGEN_MAX_CONCURRENCY: '1' }), { global: 1, perAccount: 1, maxRetries: 6 });
  assert.deepEqual(heygenLimits({ VIDEO_OS_HEYGEN_MAX_CONCURRENCY: 'bad', VIDEO_OS_HEYGEN_MAX_PER_ACCOUNT: 'bad' }), { global: 8, perAccount: 2, maxRetries: 6 });
  assert.ok(HEYGEN_ACTIVE_STATUSES.includes('provider_submit_unknown'));
});

test('twenty parallel admissions under one transaction lock respect global and account limits', async () => {
  const active = [];
  let tail = Promise.resolve();
  const accounts = Array.from({ length: 20 }, (_, index) => `account-${index % 5}`);
  const admitted = await Promise.all(accounts.map(accountId => {
    const transaction = tail.then(async () => {
      const counts = [...new Set(active)].map(id => ({ account_id: id, count: active.filter(value => value === id).length }));
      const allowed = heygenCapacityAvailable(counts, accountId, heygenLimits({}));
      if (allowed) active.push(accountId);
      return allowed;
    });
    tail = transaction.then(() => {});
    return transaction;
  }));
  assert.equal(admitted.filter(Boolean).length, 8);
  assert.ok([...new Set(active)].every(id => active.filter(value => value === id).length <= 2));
});

test('Retry-After seconds and HTTP-date are capped; fallback uses bounded full jitter', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  assert.equal(heygenRetryDelayMs({ retryAfter: '12', retryNumber: 1, now }), 12_000);
  assert.equal(heygenRetryDelayMs({ retryAfter: 'Wed, 14 Oct 2026 12:02:00 GMT', retryNumber: 1, now }), 120_000);
  assert.equal(heygenRetryDelayMs({ retryAfter: '9999', retryNumber: 1, now }), 900_000);
  assert.equal(heygenRetryDelayMs({ retryAfter: null, retryNumber: 3, now, random: () => 0 }), 0);
  assert.equal(heygenRetryDelayMs({ retryAfter: null, retryNumber: 3, now, random: () => 0.999 }), 3_996);
});

test('definitive 429/503 POST retries preserve the exact key and marker', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return new Response('{}', { status: calls.length === 1 ? 429 : 503, headers: { 'Retry-After': calls.length === 1 ? '5' : 'Wed, 14 Oct 2026 12:02:00 GMT' } });
  };
  const identity = heygenSubmissionIdentity(job.id);
  const persisted = { ...job, output: { heygenSubmission: { ...identity, attempt: 0, retryCount: 0 } } };
  await assert.rejects(submitHeygen(persisted, { env, fetchImpl, now: Date.parse('2026-10-14T12:00:00Z') }), { failureCategory: 'PROVIDER_RETRYABLE', retryDelayMs: 5_000 });
  await assert.rejects(submitHeygen(persisted, { env, fetchImpl, now: Date.parse('2026-10-14T12:00:00Z') }), { failureCategory: 'PROVIDER_RETRYABLE', retryDelayMs: 120_000 });
  assert.equal(calls[0].headers['Idempotency-Key'], identity.idempotencyKey);
  assert.equal(calls[1].headers['Idempotency-Key'], identity.idempotencyKey);
  assert.match(JSON.parse(calls[0].body).title, new RegExp(identity.marker));
  const long = await submitHeygen({ ...persisted, title: 'x'.repeat(120) }, { env, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).title.length, 120);
    return new Response(JSON.stringify({ data: { video_id: 'provider-1' } }), { status: 200 });
  } });
  assert.equal(long.providerJobId, 'provider-1');
});

test('ambiguous POST replay uses the same key and one provider resource', async () => {
  const keys = new Set();
  let created = 0;
  const fetchImpl = async (_url, options) => {
    const key = options.headers['Idempotency-Key'];
    if (!keys.has(key)) { keys.add(key); created += 1; }
    return new Response(JSON.stringify({ data: { video_id: 'provider-1' } }), { status: 200 });
  };
  const persisted = { ...job, output: { heygenSubmission: heygenSubmissionIdentity(job.id) } };
  const first = await submitHeygen(persisted, { env, fetchImpl });
  const second = await submitHeygen(persisted, { env, fetchImpl });
  assert.equal(first.providerJobId, 'provider-1');
  assert.equal(second.providerJobId, 'provider-1');
  assert.equal(created, 1);
});

const unknown = { ...job, accountId: 'account-1', provider: 'heygen', status: 'provider_submit_unknown',
  output: { heygenSubmission: { ...heygenSubmissionIdentity(job.id), claimedAt: '2026-10-14T11:00:00Z' } } };
const reconEnv = { VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: 'true', VIDEO_OS_HEYGEN_RECONCILE_GRACE_SECONDS: '60' };

test('reconciler binds one match, releases verified absence, and holds ambiguity', async () => {
  const calls = [];
  const common = { env: reconEnv, now: () => new Date('2026-10-14T12:00:00Z'), resolveBinding: async () => ({ applicationAccountId: 'account-1' }),
    bind: async input => calls.push(input), release: async input => { calls.push(input); return true; } };
  const found = await reconcileUnknownHeygenJob(unknown, { ...common, lookup: async () => ({ complete: true, items: [{ title: `[${unknown.output.heygenSubmission.marker}]`, video_id: 'provider-1' }] }) });
  assert.equal(found.outcome, 'found');
  assert.equal(calls[0].stageTo, 'provider_submitted');
  const absent = await reconcileUnknownHeygenJob(unknown, { ...common, lookup: async () => ({ complete: true, items: [] }) });
  assert.equal(absent.outcome, 'released_for_same_key_retry');
  const multiple = await reconcileUnknownHeygenJob(unknown, { ...common, lookup: async () => ({ complete: true, items: Array(2).fill({ title: `[${unknown.output.heygenSubmission.marker}]`, video_id: 'provider-1' }) }) });
  assert.equal(multiple.outcome, 'attention');
  const incomplete = await reconcileUnknownHeygenJob(unknown, { ...common, lookup: async () => ({ complete: false, items: [] }) });
  assert.equal(incomplete.outcome, 'attention');
  const exhausted = await reconcileUnknownHeygenJob({ ...unknown, output: { heygenSubmission: { ...unknown.output.heygenSubmission, retryCount: 6 } } },
    { ...common, lookup: async () => ({ complete: true, items: [] }) });
  assert.equal(exhausted.reason, 'ambiguous_retry_limit');
});

test('reconciler uses the first claim for the 24 hour idempotency cutoff', async () => {
  const stale = { ...unknown, output: { heygenSubmission: {
    ...unknown.output.heygenSubmission,
    firstClaimedAt: '2026-10-13T11:00:00Z',
    claimedAt: '2026-10-14T11:00:00Z',
  } } };
  const result = await reconcileUnknownHeygenJob(stale, {
    env: reconEnv,
    now: () => new Date('2026-10-14T12:00:00Z'),
    lookup: async () => ({ complete: true, items: [] }),
    release: async () => { throw new Error('expired claim must not be released'); },
  });
  assert.deepEqual(result, { outcome: 'attention', reason: 'idempotency_window_expired' });
});

test('RunPod timeout requests cancellation on the existing endpoint base', async () => {
  const calls = [];
  const deps = { env: { RUNPOD_API_KEY: 'synthetic-only', VIDEO_OS_RUNPOD_ENDPOINT_ID: 'endpoint-1', VIDEO_OS_RUNPOD_JOB_TIMEOUT_MS: '1000' },
    submittedAt: '2026-10-14T12:00:00Z', now: Date.parse('2026-10-14T12:00:02Z'),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}', { status: 200 }); } };
  await assert.rejects(pollRunpodStandard('run-1', deps), { failureCategory: 'PROVIDER_TIMEOUT' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.runpod.ai/v2/endpoint-1/cancel/run-1');
  assert.equal(calls[0].options.method, 'POST');
  await assert.rejects(cancelRunpodStandard('../bad', deps), { failureCategory: 'VALIDATION' });
  await assert.rejects(cancelRunpodStandard('run-1', { ...deps, fetchImpl: async () => new Response('{}', { status: 429 }) }), { failureCategory: 'PROVIDER_CANCEL_UNKNOWN' });
});
