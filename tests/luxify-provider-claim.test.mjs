import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

import * as schema from '../db/schema.js';
import { heygenSubmissionIdentity } from '../lib/heygen-provider-safety.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';

const ACCOUNT = 'luxify-claim-owner';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const LOOK_A = '22222222-2222-4222-8222-222222222222';
const LOOK_B = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY = '44444444-4444-4444-8444-444444444444';
const SECRET = 'luxify-provider-claim-secret-at-least-32-bytes';
const REVISION = 'luxify-look-eligibility-v1:canary:claim-r1';
const LOOK_BINDINGS = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'look_a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'look_b' }),
]);
const PROVIDER_BINDING = Object.freeze({
  applicationAccountId: ACCOUNT,
  bindingId: '55555555-5555-4555-8555-555555555555',
  originScopeKey: 'a'.repeat(64),
});

const runFixture = process.argv.includes('--luxify-provider-claim-fixture');

if (runFixture) {
process.env.VIDEO_OS_SESSION_SECRET = SECRET;
process.env.VIDEO_OS_LUXIFY_ENABLED = 'true';
process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = ACCOUNT;
process.env.VIDEO_OS_LUXIFY_720P_LUX_CREDITS = '41';
process.env.VIDEO_OS_LUXIFY_1080P_LUX_CREDITS = '97';
let currentDb;
mock.module('../db/client.js', { namedExports: { database: () => currentDb } });
const providerRepository = await import('../db/provider-reconciliation-repository.js');
let lookReferenceClaims = [];
let operationClaims = [];
let unknownClaims = [];
mock.module('../db/provider-reconciliation-repository.js', { namedExports: {
  ...providerRepository,
  assertProviderJobLookReferencesActiveTx: async (_tx, input) => {
    lookReferenceClaims.push(input);
    return input.lookBindings.map((binding, index) => ({
      id: `look-resource-${index}`,
      kind: 'avatar_look',
      providerResourceId: binding.providerLookId,
      state: 'ready',
    }));
  },
  reserveProviderOperationTx: async (_tx, input) => {
    operationClaims.push(input);
    return {
      binding: { id: PROVIDER_BINDING.bindingId, originScopeKey: PROVIDER_BINDING.originScopeKey },
      operation: { id: '66666666-6666-4666-8666-666666666666', state: 'pending' },
    };
  },
  recordProviderJobSubmissionUnknownTx: async (_tx, input) => {
    unknownClaims.push(input);
    return { state: 'ambiguous' };
  },
  recordProviderJobDefinitiveRetryTx: async () => ({ state: 'definitive_retry' }),
} });
const heygenSpaceRepository = await import('../db/heygen-space-binding-repository.js');
mock.module('../db/heygen-space-binding-repository.js', { namedExports: {
  ...heygenSpaceRepository,
  withFreshHeygenSpaceBindingTransaction: async (_input, callback) => callback(currentDb),
  withHeygenSpaceBindingReceiptTransaction: async (_input, callback) => callback(currentDb),
  assertHeygenProviderReceiptTx: () => PROVIDER_BINDING,
} });
const repository = await import('../db/repositories.js');

function authority(overrides = {}) {
  return {
    lookBindings: LOOK_BINDINGS.map(binding => ({ ...binding })),
    eligibilityRevision: REVISION,
    ...overrides,
  };
}

function persistedJob(overrides = {}) {
  const quoteBinding = {
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: 'LUXIFY provider claim',
    prompt: 'A cinematic provider claim with generated audio.',
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  };
  const token = issueLuxifyQuote(quoteBinding, {
    secret: SECRET,
    env: process.env,
    nonce: 'luxify-provider-claim-nonce-123456789',
  }).token;
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, quoteBinding, { secret: SECRET, env: process.env }));
  const input = {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: quoteBinding.title,
    prompt: quoteBinding.prompt,
    lookIdentityIds: [LOOK_A, LOOK_B],
    aspectRatio: quoteBinding.aspectRatio,
    resolution: quoteBinding.resolution,
    durationSeconds: quoteBinding.durationSeconds,
    lookBindings: LOOK_BINDINGS.map(binding => ({ ...binding })),
    eligibleLookIds: LOOK_BINDINGS.map(binding => binding.providerLookId),
    eligibilityRevision: REVISION,
    quoteProof,
    renderAuthorization: {
      version: 1,
      accountId: ACCOUNT,
      tier: 'premium',
      entitlementKey: 'liveRendering',
      sourceType: 'admin_tester_grant',
      sourceId: null,
      jobId: 'job-luxify-provider-claim',
    },
  };
  return {
    id: 'job-luxify-provider-claim',
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    correlationId: 'corr-luxify-provider-claim',
    provider: 'heygen',
    providerJobId: null,
    status: 'workflow_started',
    title: quoteBinding.title,
    format: 'landscape',
    costCredits: 41,
    input,
    output: {},
    ...overrides,
  };
}

function databaseFixture({ grants = true, job = persistedJob(), activeCounts = [] } = {}) {
  const events = [];
  const credit = { accountId: ACCOUNT, reserved: job.costCredits };
  const rowsFor = table => {
    if (table === schema.videoJobs) return [job];
    if (table === schema.entitlements) return grants ? [{ accountId: ACCOUNT, entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant', sourceId: null }] : [];
    if (table === schema.users) return [{ id: ACCOUNT, email: 'owner@example.test' }];
    if (table === schema.creditAccounts) return [credit];
    return [];
  };
  const db = {
    transaction: async work => work(db),
    execute: async () => ({ rows: activeCounts }),
    select() {
      let table;
      const query = {
        from(value) { table = value; return this; },
        where() { return this; },
        for() { return this; },
        limit() { return this; },
        then(resolve, reject) { return Promise.resolve(rowsFor(table)).then(resolve, reject); },
      };
      return query;
    },
    update(table) {
      return { set(values) { return { where() {
        if (table === schema.videoJobs) Object.assign(job, values);
        if (table === schema.creditAccounts) Object.assign(credit, values);
        return { returning: async () => table === schema.videoJobs ? [job] : [] };
      } }; } };
    },
    insert(table) {
      return { values(values) {
        if (table === schema.jobEvents) events.push(values);
        return Promise.resolve(values);
      } };
    },
  };
  currentDb = db;
  lookReferenceClaims = [];
  operationClaims = [];
  unknownClaims = [];
  return { events, job, credit };
}

const trusted = resolver => ({ resolveLuxifyAuthority: resolver || (async () => authority()) });

function providerReferenceFixture({ scopeConflict = false } = {}) {
  const resources = LOOK_BINDINGS.map((binding, index) => ({
    id: `77777777-7777-4777-8777-77777777777${index}`,
    applicationAccountId: ACCOUNT,
    bindingId: scopeConflict && index === 1 ? '88888888-8888-4888-8888-888888888888' : PROVIDER_BINDING.bindingId,
    originScopeKey: PROVIDER_BINDING.originScopeKey,
    verifiedAccountScopeId: '99999999-9999-4999-8999-999999999999',
    kind: 'avatar_look',
    providerResourceId: binding.providerLookId,
    originOperationId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
    state: 'ready',
    tombstonedAt: null,
  }));
  const references = [];
  let resourceRead = 0;
  const tx = {
    select() {
      let table;
      const query = {
        from(value) { table = value; return this; }, where() { return this; }, for() { return this; }, limit() { return this; },
        then(resolve, reject) {
          let rows = [];
          if (table === schema.providerResources) rows = [resources[resourceRead++ % resources.length]];
          if (table === schema.videoJobs) rows = [{ id: 'job-provider-look-helper' }];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
    insert(table) {
      return { values(values) { return { onConflictDoNothing() { return { returning: async () => {
        if (table === schema.providerConsumerReferences) references.push(values);
        return [values];
      } }; } }; } };
    },
  };
  return { references, resources, tx };
}

test('provider ledger attaches one active job reference per ordered LUXIFY look and rejects mixed scopes', async () => {
  const fixture = providerReferenceFixture();
  const resources = await providerRepository.attachProviderJobLookReferencesTx(fixture.tx, {
    accountId: ACCOUNT,
    jobId: 'job-provider-look-helper',
    lookBindings: LOOK_BINDINGS,
  });
  assert.deepEqual(resources.map(resource => resource.providerResourceId), ['look_a', 'look_b']);
  assert.equal(fixture.references.length, 2);
  assert.deepEqual(fixture.references.map(reference => reference.consumerKind), ['job', 'job']);
  assert.equal(JSON.stringify(fixture.references).includes('voice'), false);

  const conflict = providerReferenceFixture({ scopeConflict: true });
  await assert.rejects(providerRepository.attachProviderJobLookReferencesTx(conflict.tx, {
    accountId: ACCOUNT,
    jobId: 'job-provider-look-helper',
    lookBindings: LOOK_BINDINGS,
  }), { failureCategory: 'PROVIDER_RESOURCE_SCOPE_CONFLICT' });
  assert.equal(conflict.references.length, 0);
});

test('real LUXIFY provider claim fails closed without cinematic consent persistence', async () => {
  const state = databaseFixture();
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id,
    stageTo: 'provider_submitting',
    eventType: 'provider.submit_started',
    providerBinding: PROVIDER_BINDING,
  }), { code: 'LUXIFY_CINEMATIC_CONSENT_PERSISTENCE_UNAVAILABLE', statusCode: 503, failureCategory: 'CONSENT' });
  assert.equal(state.job.status, 'workflow_started');
  assert.equal(operationClaims.length, 0);
  assert.equal(lookReferenceClaims.length, 0);
});

test('authoritative LUXIFY claim rechecks look-only resources and creates a mode-bound operation digest', async () => {
  const state = databaseFixture();
  const resolverCalls = [];
  const claimed = await repository.transitionJob({
    jobId: state.job.id,
    stageTo: 'provider_submitting',
    eventType: 'provider.submit_started',
    providerBinding: PROVIDER_BINDING,
  }, trusted(async value => { resolverCalls.push(value); return authority(); }));
  assert.equal(claimed.status, 'provider_submitting');
  assert.equal(claimed.providerClaimProof.operationState, 'pending');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].phase, 'claim');
  assert.deepEqual(lookReferenceClaims[0].lookBindings, LOOK_BINDINGS);
  assert.equal(JSON.stringify(lookReferenceClaims).includes('voice'), false);
  assert.equal(operationClaims.length, 1);
  assert.equal(operationClaims[0].kind, 'video_create');
  assert.equal(operationClaims[0].identityId, null);
  assert.equal(operationClaims[0].jobId, state.job.id);
  const expectedDigest = providerRepository.providerOperationRequestDigest({
    version: 'provider-video-request/luxify-v1',
    jobId: state.job.id,
    accountId: ACCOUNT,
    projectId: PROJECT,
    title: state.job.title,
    format: 'landscape',
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    prompt: state.job.input.prompt,
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  });
  assert.equal(operationClaims[0].requestDigest, expectedDigest);
  assert.equal(claimed.providerClaimProof.requestDigest, expectedDigest);
  assert.equal(state.events[0].details.renderMode, LUXIFY_RENDER_MODE);
  assert.equal(state.events[0].details.providerCapability, LUXIFY_PROVIDER_CAPABILITY);
});

test('authority drift, Premium revocation, and malformed mode fail before provider claim', async () => {
  let state = databaseFixture();
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted(async () => authority({
    lookBindings: [
      { identityId: LOOK_A, providerLookId: 'changed_look' },
      { identityId: LOOK_B, providerLookId: 'look_b' },
    ],
  }))), { code: 'LUXIFY_AUTHORITY_CHANGED', failureCategory: 'CONSENT' });
  assert.equal(operationClaims.length, 0);
  assert.equal(state.job.status, 'workflow_started');

  state = databaseFixture({ grants: false });
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), { failureCategory: 'ENTITLEMENT' });
  assert.equal(operationClaims.length, 0);

  const feature = process.env.VIDEO_OS_LUXIFY_ENABLED;
  state = databaseFixture();
  process.env.VIDEO_OS_LUXIFY_ENABLED = 'false';
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), { code: 'LUXIFY_DISABLED' });
  process.env.VIDEO_OS_LUXIFY_ENABLED = feature;
  assert.equal(operationClaims.length, 0);

  const pin = process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID;
  state = databaseFixture();
  process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = 'another-account';
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), { code: 'LUXIFY_ACCOUNT_NOT_PINNED' });
  process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = pin;
  assert.equal(operationClaims.length, 0);

  const price = process.env.VIDEO_OS_LUXIFY_720P_LUX_CREDITS;
  state = databaseFixture();
  process.env.VIDEO_OS_LUXIFY_720P_LUX_CREDITS = '42';
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), { code: 'LUXIFY_COST_MISMATCH' });
  process.env.VIDEO_OS_LUXIFY_720P_LUX_CREDITS = price;
  assert.equal(operationClaims.length, 0);

  const malformed = persistedJob();
  malformed.input.renderMode = 'luxify_cinematic_v0';
  state = databaseFixture({ job: malformed });
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), error => ['LUXIFY_JOB_BINDING_INVALID', 'LUXIFY_CONTRACT_INVALID'].includes(error.code));
  assert.equal(operationClaims.length, 0);
});

test('a claimed or uncertain LUXIFY submission is never re-claimed or released as unsubmitted', async () => {
  const state = databaseFixture();
  await repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted());
  assert.equal(operationClaims.length, 1);
  await assert.rejects(repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted()), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerSubmissionPossible: true });
  assert.equal(operationClaims.length, 1);

  await repository.transitionJob({
    jobId: state.job.id,
    stageTo: 'provider_submit_unknown',
    eventType: 'provider.submit_unknown',
    failureCategory: 'PROVIDER_SUBMIT_UNKNOWN',
    providerBinding: PROVIDER_BINDING,
  });
  assert.equal(state.job.status, 'provider_submit_unknown');
  assert.equal(unknownClaims.length, 1);
  assert.equal(unknownClaims[0].jobId, state.job.id);
});

test('unknown to submitted requires reconciled-found event, binding, and provider id', async () => {
  const state = databaseFixture({ job: persistedJob({ status: 'provider_submit_unknown' }) });
  for (const override of [
    { eventType: 'provider.submitted' },
    { providerBinding: null },
    { providerJobId: null },
  ]) {
    await assert.rejects(repository.transitionJob({
      jobId: state.job.id, stageTo: 'provider_submitted', eventType: 'provider.reconciled_found',
      providerBinding: PROVIDER_BINDING, providerJobId: 'provider-video-1', ...override,
    }), error => ['RECONCILIATION', 'MISSING_PROVIDER_ACCOUNT_BINDING'].includes(error.failureCategory));
    assert.equal(state.job.status, 'provider_submit_unknown');
  }
});

test('definitive 503 retries stop at the repository retry cap', async () => {
  const state = databaseFixture({ job: persistedJob({ status: 'provider_submitting', output: {
    heygenSubmission: { idempotencyKey: 'key-1', retryCount: 1, firstClaimedAt: '2026-10-13T12:00:00Z' },
  } }) });
  const exhausted = await repository.requeueHeygenSubmission(state.job.id, {
    retryDelayMs: 1000, providerBinding: PROVIDER_BINDING, maxRetries: 1,
  });
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.failureCategory, 'PROVIDER_RETRY_EXHAUSTED');
  assert.equal(state.credit.reserved, 0);
  assert.equal(exhausted.output.heygenSubmission.retryCount, 2);
  assert.equal(state.events.at(-1).eventType, 'provider.retry_exhausted');
});

test('configured retry exhaustion fails the job without an explicit retry override', async () => {
  const previous = process.env.VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS;
  process.env.VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS = '1';
  try {
    const state = databaseFixture({ job: persistedJob({ status: 'provider_submitting', output: {
      heygenSubmission: { idempotencyKey: 'key-1', retryCount: 1, firstClaimedAt: '2026-10-13T12:00:00Z' },
    } }) });
    const exhausted = await repository.requeueHeygenSubmission(state.job.id, {
      retryDelayMs: 1000, providerBinding: PROVIDER_BINDING,
    });
    assert.equal(exhausted.status, 'failed');
    assert.equal(exhausted.failureCategory, 'PROVIDER_RETRY_EXHAUSTED');
    assert.equal(state.events.at(-1).eventType, 'provider.retry_exhausted');
  } finally {
    if (previous === undefined) delete process.env.VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS;
    else process.env.VIDEO_OS_HEYGEN_MAX_RETRY_ATTEMPTS = previous;
  }
});

test('repository uses first claim cutoff even when a retry claim is recent', async () => {
  const state = databaseFixture({ job: persistedJob({ status: 'provider_submit_unknown', output: {
    heygenSubmission: { idempotencyKey: 'same-key', claimedAt: '2026-10-14T11:00:00Z', firstClaimedAt: '2026-10-13T11:00:00Z' },
  } }) });
  const released = await repository.releaseHeygenUnknownForRetry(state.job.id, {
    providerBinding: PROVIDER_BINDING, graceMs: 60_000, now: new Date('2026-10-14T12:00:00Z'),
  });
  assert.equal(released, null);
  assert.equal(state.job.status, 'provider_submit_unknown');
});

test('refused admission updates retry time but throttles deferral events', async () => {
  const state = databaseFixture({ activeCounts: [{ account_id: ACCOUNT, count: 8 }] });
  const claim = () => repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted());
  const first = await claim();
  assert.equal(first.admissionDeferred, true);
  assert.equal(state.events.filter(event => event.eventType === 'provider.admission_deferred').length, 1);
  state.job.output.heygenSubmission.nextAttemptAt = '2000-01-01T00:00:00.000Z';
  const second = await claim();
  assert.equal(second.admissionDeferred, true);
  assert.equal(state.events.filter(event => event.eventType === 'provider.admission_deferred').length, 1);
  assert.ok(state.job.output.heygenSubmission.lastDeferralEventAt);
});

test('a new provider claim preserves the first claim timestamp across retries', async () => {
  const firstClaimedAt = '2026-10-13T10:00:00.000Z';
  const state = databaseFixture({ job: persistedJob({ output: { heygenSubmission: {
    idempotencyKey: 'prior-key', claimedAt: firstClaimedAt, firstClaimedAt, retryCount: 1,
  } } }) });
  const claimed = await repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted());
  assert.equal(claimed.output.heygenSubmission.firstClaimedAt, firstClaimedAt);
  assert.notEqual(claimed.output.heygenSubmission.claimedAt, firstClaimedAt);
});

test('requeue then reclaim derives the saved provider key from the job ID and attempt', async () => {
  const state = databaseFixture();
  const claim = () => repository.transitionJob({
    jobId: state.job.id, stageTo: 'provider_submitting', eventType: 'provider.submit_started', providerBinding: PROVIDER_BINDING,
  }, trusted());
  const first = await claim();
  assert.equal(first.output.heygenSubmission.idempotencyKey, heygenSubmissionIdentity(state.job.id).idempotencyKey);
  await repository.requeueHeygenSubmission(state.job.id, { retryDelayMs: 0, providerBinding: PROVIDER_BINDING });
  state.job.output.heygenSubmission.nextAttemptAt = '2000-01-01T00:00:00.000Z';
  const second = await claim();
  assert.equal(second.output.heygenSubmission.idempotencyKey, heygenSubmissionIdentity(state.job.id).idempotencyKey);
  assert.equal(second.output.heygenSubmission.marker, first.output.heygenSubmission.marker);
});
} else {
  test('LUXIFY provider-claim and uncertainty scenarios', () => {
    const path = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', path, '--luxify-provider-claim-fixture',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
