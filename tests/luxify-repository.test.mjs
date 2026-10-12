import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLuxifyRepository,
  luxifyProjectDto,
} from '../db/luxify-repository.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import {
  issueLuxifyQuote,
  safeLuxifyQuoteProof,
  verifyLuxifyQuote,
} from '../lib/luxify-quote.js';

const ACCOUNT = 'owner-account';
const OTHER = 'other-account';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const LOOK_A = '22222222-2222-4222-8222-222222222222';
const LOOK_B = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-11T16:00:00.000Z');
const ELIGIBILITY_REVISION = 'luxify-look-eligibility-v1:canary:repository-r1';
const LOOK_BINDINGS = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'private-look-a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'private-look-b' }),
]);
const QUOTE_ENV = Object.freeze({
  VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41',
  VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97',
});
const QUOTE_SECRET = 'luxify-repository-secret-at-least-32-bytes';

const input = Object.freeze({
  accountId: ACCOUNT,
  contractVersion: LUXIFY_CONTRACT_VERSION,
  projectId: PROJECT,
  title: 'Owner cinematic shot',
  prompt: 'Move through a warm studio as generated ambience rises.',
  lookIdentityIds: [LOOK_A, LOOK_B],
  aspectRatio: '16:9',
  resolution: '720p',
  durationSeconds: 8,
});

function record(overrides = {}) {
  return {
    id: PROJECT,
    accountId: ACCOUNT,
    identityId: null,
    title: input.title,
    script: '',
    avatar: {},
    voice: {},
    settings: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      prompt: input.prompt,
      lookIdentityIds: [...input.lookIdentityIds],
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
    },
    createdAt: new Date('2026-10-11T15:00:00.000Z'),
    updatedAt: NOW,
    ...overrides,
  };
}

function job(overrides = {}) {
  const binding = {
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: input.title,
    prompt: input.prompt,
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: ELIGIBILITY_REVISION,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    durationSeconds: input.durationSeconds,
  };
  const quote = issueLuxifyQuote(binding, {
    secret: QUOTE_SECRET,
    now: NOW.getTime(),
    nonce: 'repository-test-nonce-123456789',
    env: QUOTE_ENV,
  });
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(quote.token, binding, {
    secret: QUOTE_SECRET,
    now: NOW.getTime(),
    env: QUOTE_ENV,
  }));
  return {
    id: 'job-luxify-existing',
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    provider: 'heygen',
    title: input.title,
    format: 'landscape',
    costCredits: 41,
    status: 'workflow_started',
    input: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      projectId: PROJECT,
      title: input.title,
      prompt: input.prompt,
      lookIdentityIds: [...input.lookIdentityIds],
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      durationSeconds: input.durationSeconds,
      eligibleLookIds: LOOK_BINDINGS.map(binding => binding.providerLookId),
      eligibilityRevision: ELIGIBILITY_REVISION,
      quoteProof,
    },
    createdAt: new Date('2026-10-11T15:30:00.000Z'),
    updatedAt: NOW,
    ...overrides,
  };
}

function fixture({ existing = null, identities = [LOOK_A, LOOK_B], existingJob = null } = {}) {
  const calls = { locks: [], inserts: [], updates: [], jobLookups: [] };
  let current = existing;
  const store = {
    transaction: work => work({ kind: 'mock-transaction' }),
    lockProject: async (_tx, accountId, projectId) => { calls.locks.push({ accountId, projectId }); },
    findProjectById: async () => current,
    findOwnedLookIdentities: async () => identities.map(id => ({ id, displayName: 'Owned look' })),
    insertProject: async (_tx, values) => {
      calls.inserts.push(values);
      current = { ...values, createdAt: NOW };
      return current;
    },
    updateProject: async (_tx, accountId, projectId, values) => {
      calls.updates.push({ accountId, projectId, values });
      current = { ...current, ...values };
      return current;
    },
    findOwnedJob: async (accountId, idempotencyKey) => {
      calls.jobLookups.push({ accountId, idempotencyKey });
      return existingJob;
    },
  };
  return {
    calls,
    repository: createLuxifyRepository({ store, now: () => new Date(NOW) }),
  };
}

test('saveProject creates one prompt-led project with server-owned mode fields', async () => {
  const { repository, calls } = fixture();
  const saved = await repository.saveProject(input);
  assert.deepEqual(calls.locks, [{ accountId: ACCOUNT, projectId: PROJECT }]);
  assert.equal(calls.inserts.length, 1);
  const inserted = calls.inserts[0];
  assert.equal(inserted.identityId, null);
  assert.equal(inserted.script, '');
  assert.deepEqual(inserted.avatar, {});
  assert.deepEqual(inserted.voice, {});
  assert.deepEqual(inserted.settings, {
    contractVersion: LUXIFY_CONTRACT_VERSION,
    renderMode: LUXIFY_RENDER_MODE,
    providerCapability: LUXIFY_PROVIDER_CAPABILITY,
    prompt: input.prompt,
    lookIdentityIds: [LOOK_A, LOOK_B],
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  });
  assert.deepEqual(saved, {
    id: PROJECT,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    title: input.title,
    prompt: input.prompt,
    lookIdentityIds: [LOOK_A, LOOK_B],
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  assert.equal(saved.renderMode, undefined);
  assert.equal(saved.providerCapability, undefined);
  assert.equal(saved.script, undefined);
});

test('saveProject updates only the same owned LUXIFY project', async () => {
  const existing = record();
  const { repository, calls } = fixture({ existing });
  const saved = await repository.saveProject({ ...input, prompt: 'A revised cinematic prompt.' });
  assert.equal(calls.inserts.length, 0);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].accountId, ACCOUNT);
  assert.equal(calls.updates[0].projectId, PROJECT);
  assert.equal(saved.prompt, 'A revised cinematic prompt.');

  await assert.rejects(
    fixture({ existing: record({ accountId: OTHER }) }).repository.saveProject(input),
    { code: 'LUXIFY_PROJECT_NOT_FOUND', statusCode: 404, failureCategory: 'OWNERSHIP' },
  );
  await assert.rejects(
    fixture({ existing: record({ settings: {} }) }).repository.saveProject(input),
    { code: 'LUXIFY_PROJECT_INVALID', statusCode: 400 },
  );
});

test('saveProject rejects missing ownership and unexpected client-controlled fields before persistence', async () => {
  const missing = fixture({ identities: [LOOK_A] });
  await assert.rejects(missing.repository.saveProject(input), {
    code: 'LUXIFY_LOOK_NOT_FOUND',
    statusCode: 404,
    failureCategory: 'OWNERSHIP',
  });
  assert.equal(missing.calls.inserts.length, 0);

  const strict = fixture();
  await assert.rejects(strict.repository.saveProject({ ...input, provider: 'heygen' }), {
    code: 'LUXIFY_PROJECT_INVALID',
    statusCode: 400,
  });
  assert.equal(strict.calls.inserts.length, 0);
});

test('getProject returns only an owned, exactly bound LUXIFY project', async () => {
  const { repository } = fixture({ existing: record() });
  assert.deepEqual(await repository.getProject(ACCOUNT, PROJECT), luxifyProjectDto(record()));
  await assert.rejects(
    fixture({ existing: record({ accountId: OTHER }) }).repository.getProject(ACCOUNT, PROJECT),
    { code: 'LUXIFY_PROJECT_NOT_FOUND', statusCode: 404 },
  );
});

test('recoverJob returns a provider-free DTO only for the exact LUXIFY idempotency binding', async () => {
  const existingJob = job();
  const { repository, calls } = fixture({ existingJob });
  const recovered = await repository.recoverJob({
    accountId: ACCOUNT,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
  });
  assert.deepEqual(calls.jobLookups, [{ accountId: ACCOUNT, idempotencyKey: IDEMPOTENCY }]);
  assert.deepEqual(recovered, {
    id: existingJob.id,
    mode: 'luxify',
    status: existingJob.status,
    title: existingJob.title,
    projectId: PROJECT,
    createdAt: existingJob.createdAt.toISOString(),
    updatedAt: existingJob.updatedAt.toISOString(),
  });
  for (const privateField of ['provider', 'providerJobId', 'input', 'costCredits', 'renderMode']) {
    assert.equal(recovered[privateField], undefined);
  }

  assert.equal(await fixture().repository.recoverJob({
    accountId: ACCOUNT,
    contractVersion: LUXIFY_CONTRACT_VERSION,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
  }), null);
});

test('recoverJob rejects Premium, cross-project, and malformed LUXIFY collisions', async () => {
  const cases = [
    job({ provider: 'sadtalker' }),
    job({ projectId: LOOK_A }),
    job({ format: 'vertical' }),
    job({ input: { ...job().input, contractVersion: 'scripted-photo-v1' } }),
    job({ input: { ...job().input, renderMode: 'premium_presenter_v1' } }),
    job({ input: { ...job().input, eligibilityRevision: 'changed-revision' } }),
    job({ costCredits: 42 }),
  ];
  for (const existingJob of cases) {
    await assert.rejects(
      fixture({ existingJob }).repository.recoverJob({
        accountId: ACCOUNT,
        contractVersion: LUXIFY_CONTRACT_VERSION,
        projectId: PROJECT,
        idempotencyKey: IDEMPOTENCY,
      }),
      { code: 'LUXIFY_RECOVERY_BINDING_MISMATCH', statusCode: 409 },
    );
  }
});
