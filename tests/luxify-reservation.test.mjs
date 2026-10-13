import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mock, test } from 'node:test';

import * as schema from '../db/schema.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote } from '../lib/luxify-quote.js';

const ACCOUNT = 'luxify-owner-account';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const LOOK_A = '22222222-2222-4222-8222-222222222222';
const LOOK_B = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY = '44444444-4444-4444-8444-444444444444';
const SECRET = 'luxify-reservation-test-secret-at-least-32-bytes';
const REVISION = 'luxify-look-eligibility-v1:canary:reservation-r1';
const LOOK_BINDINGS = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'look_a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'look_b' }),
]);

const runFixture = process.argv.includes('--luxify-reservation-fixture');

if (runFixture) {
process.env.VIDEO_OS_SESSION_SECRET = SECRET;
process.env.VIDEO_OS_LUXIFY_ENABLED = 'true';
process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = ACCOUNT;
process.env.VIDEO_OS_LUXIFY_720P_LUX_CREDITS = '41';
process.env.VIDEO_OS_LUXIFY_1080P_LUX_CREDITS = '97';
let currentDb;
mock.module('../db/client.js', { namedExports: { database: () => currentDb } });
const providerRepository = await import('../db/provider-reconciliation-repository.js');
let attachedLookBindings = [];
mock.module('../db/provider-reconciliation-repository.js', { namedExports: {
  ...providerRepository,
  attachProviderJobLookReferencesTx: async (_tx, input) => {
    attachedLookBindings.push(input);
    return input.lookBindings.map((binding, index) => ({
      id: `resource-${index}`,
      kind: 'avatar_look',
      providerResourceId: binding.providerLookId,
      state: 'ready',
    }));
  },
} });
const repository = await import('../db/repositories.js');

function input(overrides = {}) {
  return {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: 'LUXIFY reservation proof',
    prompt: 'A cinematic owner scene with generated ambient audio.',
    lookIdentityIds: [LOOK_A, LOOK_B],
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    lookBindings: LOOK_BINDINGS.map(binding => ({ ...binding })),
    eligibilityRevision: REVISION,
    ...overrides,
  };
}

function request(overrides = {}) {
  const renderInput = overrides.input || input();
  const quote = issueLuxifyQuote({
    accountId: ACCOUNT,
    projectId: renderInput.projectId,
    idempotencyKey: renderInput.idempotencyKey,
    title: renderInput.title,
    prompt: renderInput.prompt,
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: renderInput.aspectRatio,
    resolution: renderInput.resolution,
    durationSeconds: renderInput.durationSeconds,
  }, { secret: SECRET, env: process.env, nonce: 'luxify-reservation-nonce-123456789' });
  return {
    jobId: overrides.jobId || 'job-luxify-reservation',
    accountId: ACCOUNT,
    idempotencyKey: renderInput.idempotencyKey,
    correlationId: 'corr-luxify-reservation',
    provider: 'heygen',
    tier: 'premium',
    title: renderInput.title,
    format: 'landscape',
    costCredits: 41,
    input: renderInput,
    quoteToken: quote.token,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['input', 'jobId'].includes(key))),
  };
}

function databaseFixture({ grants = true, existingJob = null, blockProjectLock = false } = {}) {
  const credit = { accountId: ACCOUNT, balance: 500, reserved: 0, spent: 0 };
  const jobs = existingJob ? [existingJob] : [];
  const events = [];
  const renderInput = input();
  const project = {
    id: PROJECT,
    accountId: ACCOUNT,
    identityId: null,
    title: renderInput.title,
    script: '',
    settings: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      prompt: renderInput.prompt,
      lookIdentityIds: [...renderInput.lookIdentityIds],
      aspectRatio: renderInput.aspectRatio,
      resolution: renderInput.resolution,
      durationSeconds: renderInput.durationSeconds,
    },
  };
  const operations = [];
  let executeCount = 0;
  let enterProjectLock;
  let releaseProjectLock;
  const projectLockEntered = new Promise(resolve => { enterProjectLock = resolve; });
  const projectLockGate = new Promise(resolve => { releaseProjectLock = resolve; });
  const rowsFor = table => {
    if (table === schema.entitlements) return grants ? [{ accountId: ACCOUNT, entitlementKey: 'liveRendering', enabled: true, sourceType: 'admin_tester_grant', sourceId: null }] : [];
    if (table === schema.users) return [{ id: ACCOUNT, email: 'owner@example.test' }];
    if (table === schema.creditAccounts) return [credit];
    if (table === schema.videoJobs) return jobs;
    if (table === schema.jobEvents) return events;
    if (table === schema.projects) return [project];
    return [];
  };
  const db = {
    transaction: async work => work(db),
    execute: async () => {
      executeCount += 1;
      operations.push('advisory:' + executeCount);
      if (blockProjectLock && executeCount === 3) {
        enterProjectLock();
        await projectLockGate;
      }
      return { rows: [] };
    },
    select() {
      let table;
      const query = {
        from(value) { table = value; return this; },
        where() { return this; },
        for(mode) {
          const name = table === schema.videoJobs ? 'videoJobs'
            : table === schema.projects ? 'projects'
            : table === schema.entitlements ? 'entitlements'
            : table === schema.creditAccounts ? 'creditAccounts'
            : 'other';
          operations.push('row:' + name + ':' + mode);
          return this;
        },
        limit() { return this; },
        then(resolve, reject) { return Promise.resolve(rowsFor(table)).then(resolve, reject); },
      };
      return query;
    },
    update(table) {
      return { set(values) { return { where() {
        if (table === schema.creditAccounts) Object.assign(credit, values);
        return { returning: async () => [] , then(resolve, reject) { return Promise.resolve(undefined).then(resolve, reject); } };
      } }; } };
    },
    insert(table) {
      return { values(values) {
        if (table === schema.videoJobs) {
          jobs.push(values);
          return { returning: async () => [values] };
        }
        if (table === schema.jobEvents) events.push(values);
        return Promise.resolve(values);
      } };
    },
  };
  currentDb = db;
  attachedLookBindings = [];
  return {
    credit,
    events,
    jobs,
    operations,
    project,
    projectLockEntered,
    releaseProjectLock,
  };
}

const trusted = resolver => ({ resolveLuxifyAuthority: resolver || (async () => authority()) });

test('real LUXIFY reservation fails closed without cinematic consent persistence', async () => {
  const state = databaseFixture();
  await assert.rejects(repository.reserveRender(request()), {
    code: 'LUXIFY_CINEMATIC_CONSENT_PERSISTENCE_UNAVAILABLE',
    statusCode: 503,
    failureCategory: 'CONSENT',
  });
  assert.equal(state.jobs.length, 0);
  assert.equal(state.credit.reserved, 0);
  assert.equal(attachedLookBindings.length, 0);
});

test('test-authoritative reservation persists exact mode, quote, ordered looks, and zero voice resources', async () => {
  const state = databaseFixture();
  const resolverCalls = [];
  const reserved = await repository.reserveRender(request(), trusted(async value => {
    resolverCalls.push(value);
    state.operations.push('authority:reservation');
    return authority();
  }));
  assert.equal(reserved.replayed, false);
  assert.match(reserved.proofId, /^[0-9a-f-]{36}$/i);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.credit.reserved, 41);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].phase, 'reservation');
  assert.deepEqual(reserved.job.input.lookBindings, LOOK_BINDINGS);
  assert.deepEqual(reserved.job.input.eligibleLookIds, ['look_a', 'look_b']);
  assert.equal(reserved.job.input.eligibilityRevision, REVISION);
  assert.equal(reserved.job.input.renderMode, LUXIFY_RENDER_MODE);
  assert.equal(reserved.job.input.providerCapability, LUXIFY_PROVIDER_CAPABILITY);
  assert.equal(reserved.job.input.script, undefined);
  assert.equal(reserved.job.input.voice, undefined);
  assert.equal(reserved.job.input.renderAuthorization.tier, 'premium');
  assert.equal(reserved.job.input.quoteProof.luxCredits, 41);
  assert.equal(attachedLookBindings.length, 1);
  assert.deepEqual(attachedLookBindings[0].lookBindings, LOOK_BINDINGS);
  assert.equal(JSON.stringify(attachedLookBindings).includes('voice'), false);
  const projectLock = state.operations.indexOf('advisory:3');
  const projectRead = state.operations.indexOf('row:projects:share');
  const authorityRead = state.operations.indexOf('authority:reservation');
  const entitlementLock = state.operations.indexOf('row:entitlements:share');
  const creditLock = state.operations.indexOf('row:creditAccounts:update');
  assert.ok(projectLock >= 0 && projectLock < projectRead);
  assert.ok(projectRead < authorityRead);
  assert.ok(authorityRead < entitlementLock);
  assert.ok(entitlementLock < creditLock);
});

test('concurrent saved-draft commit wins before the shared project lock and old quoted intent cannot reserve credit', async () => {
  const state = databaseFixture({ blockProjectLock: true });
  let resolverCalls = 0;
  const pending = repository.reserveRender(request(), trusted(async () => {
    resolverCalls += 1;
    return authority();
  }));

  await state.projectLockEntered;
  state.project.settings.prompt = 'Draft B committed while the old route read was waiting.';
  state.releaseProjectLock();

  await assert.rejects(pending, {
    code: 'LUXIFY_PROJECT_BINDING_CHANGED',
    statusCode: 409,
    failureCategory: 'RECONCILIATION',
  });
  assert.equal(resolverCalls, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.credit.reserved, 0);
  assert.equal(attachedLookBindings.length, 0);
  assert.equal(state.operations.includes('row:creditAccounts:update'), false);
  assert.deepEqual(state.operations.slice(0, 4), [
    'advisory:1',
    'advisory:2',
    'row:videoJobs:update',
    'advisory:3',
  ]);
  assert.equal(state.operations[4], 'row:projects:share');
});

test('LUXIFY idempotent replay binds every intent field without re-resolving authority or reserving twice', async () => {
  const state = databaseFixture();
  let resolverCalls = 0;
  const dependencies = trusted(async () => { resolverCalls += 1; return authority(); });
  const first = await repository.reserveRender(request(), dependencies);
  const replay = await repository.reserveRender(request({ jobId: 'ignored-replay-job' }), dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.proofId, first.proofId);
  assert.equal(resolverCalls, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.credit.reserved, 41);

  for (const changed of [
    { prompt: 'A changed prompt.' },
    { lookIdentityIds: [LOOK_B, LOOK_A] },
    { durationSeconds: 9 },
    { renderMode: 'luxify_cinematic_v0' },
  ]) {
    const changedInput = input(changed);
    await assert.rejects(
      repository.reserveRender(request({ input: changedInput, jobId: randomUUID() }), dependencies),
      error => ['LUXIFY_IDEMPOTENCY_CONFLICT', 'LUXIFY_RESERVATION_INVALID'].includes(error.code),
    );
  }
  assert.equal(state.jobs.length, 1);
  assert.equal(state.credit.reserved, 41);
});

test('feature, exact account, current cost, and Premium authority gate reservation', async () => {
  databaseFixture();
  const feature = process.env.VIDEO_OS_LUXIFY_ENABLED;
  process.env.VIDEO_OS_LUXIFY_ENABLED = 'false';
  await assert.rejects(repository.reserveRender(request(), trusted()), { code: 'LUXIFY_DISABLED' });
  process.env.VIDEO_OS_LUXIFY_ENABLED = feature;

  const pin = process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID;
  process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = 'another-account';
  await assert.rejects(repository.reserveRender(request(), trusted()), { code: 'LUXIFY_ACCOUNT_NOT_PINNED' });
  process.env.VIDEO_OS_LUXIFY_ACCOUNT_ID = pin;

  await assert.rejects(repository.reserveRender({ ...request(), costCredits: 42 }, trusted()), { code: 'LUXIFY_COST_MISMATCH' });

  const denied = databaseFixture({ grants: false });
  await assert.rejects(repository.reserveRender(request(), trusted()), { failureCategory: 'ENTITLEMENT' });
  assert.equal(denied.jobs.length, 0);
  assert.equal(denied.credit.reserved, 0);
});
} else {
  test('LUXIFY reservation and replay scenarios', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)),
      '--luxify-reservation-fixture',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
