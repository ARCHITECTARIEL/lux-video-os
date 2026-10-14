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
  await assert.rejects(submitHeygen(job, { env, fetchImpl: async () => new Response('{}', { status: 500 }) }), error => error.failureCategory !== 'PROVIDER_RETRYABLE');
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
