import assert from 'node:assert/strict';
import test from 'node:test';
import { heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';
import { submitHeygen } from '../services/heygen.js';
import { reconcileUnknownHeygenJob } from '../services/heygen-reconciliation.js';

const env = { HEYGEN_API_KEY: 'synthetic-only' };
const job = { id: 'job-qa-1', title: 'T', format: 'vertical', input: { avatar: { avatarId: 'a' }, voice: { voiceId: 'v' }, script: 'Hi' } };

test('idempotency keys remain stable and distinct across 10k job ids', () => {
  const keys = new Set();
  for (let i = 0; i < 10_000; i++) {
    keys.add(heygenSubmissionIdentity(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).idempotencyKey);
  }
  assert.equal(keys.size, 10_000);
  assert.equal(heygenSubmissionIdentity(job.id).idempotencyKey, heygenSubmissionIdentity(job.id).idempotencyKey);
  assert.notEqual(heygenSubmissionIdentity(job.id).idempotencyKey, heygenSubmissionIdentity('other-job').idempotencyKey);
});

test('submit uses only v3 videos with the persisted key and does not retry 500', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, key: options.headers['Idempotency-Key'] });
    return new Response('{}', { status: 429 });
  };
  const identity = heygenSubmissionIdentity(job.id);
  for (const retryCount of [0, 1, 5]) {
    await assert.rejects(submitHeygen({ ...job, output: { heygenSubmission: { ...identity, attempt: 0, retryCount } } }, { env, fetchImpl, random: () => 0 }), { failureCategory: 'PROVIDER_RETRYABLE' });
  }
  assert.ok(seen.every(call => call.url === 'https://api.heygen.com/v3/videos' && call.key === identity.idempotencyKey));
  await assert.rejects(submitHeygen({ ...job, output: { heygenSubmission: identity } }, { env, fetchImpl: async () => new Response('{}', { status: 500 }) }), error => error.failureCategory !== 'PROVIDER_RETRYABLE');
});

test('missing and malformed persisted identities never submit or fall back to the job ID', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('provider called'); };
  const valid = heygenSubmissionIdentity(job.id);
  for (const metadata of [undefined, {}, { ...valid, idempotencyKey: job.id },
    { ...valid, idempotencyKey: 'vos-' }, { ...valid, marker: 'vos-' }]) {
    await assert.rejects(submitHeygen({ ...job, output: { heygenSubmission: metadata } }, { env, fetchImpl }),
      { failureCategory: 'PROVIDER_IDENTITY_MISSING' });
  }
  assert.equal(calls, 0);
});

const base = { ...job, accountId: 'acct', provider: 'heygen', status: 'provider_submit_unknown' };
const claimed = claimedAt => ({ ...base, output: { heygenSubmission: { ...heygenSubmissionIdentity(job.id), claimedAt } } });
const now = () => new Date('2026-10-14T12:00:00Z');
const options = (extra = {}) => ({
  env: { VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: 'true' }, now,
  lookup: async () => ({ complete: true, items: [] }),
  resolveBinding: async () => ({ applicationAccountId: 'acct' }),
  bind: async () => { throw new Error('unexpected bind'); }, release: async () => true,
  ...extra,
});

test('reconciler requires exact enablement and respects grace, 24h cutoff and malformed claim time', async () => {
  let lookups = 0;
  assert.equal((await reconcileUnknownHeygenJob(claimed('2026-10-14T10:00:00Z'), options({ env: {}, lookup: async () => { lookups++; return { complete: true, items: [] }; } }))).outcome, 'disabled');
  assert.equal((await reconcileUnknownHeygenJob(claimed('2026-10-14T10:00:00Z'), options({ env: { VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED: '1' } }))).outcome, 'disabled');
  assert.equal(lookups, 0);
  assert.equal((await reconcileUnknownHeygenJob(claimed('2026-10-14T11:59:00Z'), options())).reason, 'grace_period');
  assert.equal((await reconcileUnknownHeygenJob(claimed('2026-10-13T11:59:59Z'), options())).reason, 'idempotency_window_expired');
  assert.equal((await reconcileUnknownHeygenJob(claimed('2026-10-13T12:00:01Z'), options())).outcome, 'released_for_same_key_retry');
  assert.notEqual((await reconcileUnknownHeygenJob(claimed('not-a-date'), options())).outcome, 'released_for_same_key_retry');
});

test('Luxify held submission uses the marker inventory and releases only verified absence', async () => {
  const held = { ...claimed('2026-10-14T10:00:00Z'), input: { renderMode: 'luxify_cinematic_v1' } };
  const marker = held.output.heygenSubmission.marker;
  let binds = 0;
  let releases = 0;
  const fixture = options({
    bind: async () => { binds++; },
    release: async () => { releases++; return true; },
  });
  const found = await reconcileUnknownHeygenJob(held, { ...fixture, lookup: async () => ({ complete: true, items: [{ title: `Render [${marker}]`, video_id: 'video-1' }] }) });
  assert.deepEqual(found, { outcome: 'found', providerJobId: 'video-1' });
  assert.equal(binds, 1);
  assert.equal(releases, 0);
  assert.equal((await reconcileUnknownHeygenJob(held, { ...fixture, lookup: async () => ({ complete: false, items: [] }) })).outcome, 'attention');
  assert.equal((await reconcileUnknownHeygenJob(held, { ...fixture, lookup: async () => ({ complete: true, items: [{ title: `[${marker}]`, video_id: 'video-1' }, { title: `[${marker}]`, video_id: 'video-2' }] }) })).reason, 'multiple_matches');
  assert.equal(releases, 0);
  assert.equal((await reconcileUnknownHeygenJob(held, fixture)).outcome, 'released_for_same_key_retry');
  assert.equal(releases, 1);
  for (const broken of [{ ...held.output.heygenSubmission, idempotencyKey: 'vos-' }, undefined]) {
    const result = await reconcileUnknownHeygenJob({ ...held, output: { heygenSubmission: broken } }, fixture);
    assert.deepEqual(result, { outcome: 'attention', reason: 'missing_submission_identity' });
  }
  assert.equal(releases, 1);
});
