import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';

const ACCOUNT = 'luxify-workflow-owner';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY = '22222222-2222-4222-8222-222222222222';
const LOOK_A = '33333333-3333-4333-8333-333333333333';
const LOOK_B = '44444444-4444-4444-8444-444444444444';
const REVISION = 'luxify-look-eligibility-v1:canary:workflow';
const SECRET = 'luxify-workflow-test-secret-at-least-32-bytes';
const ENV = { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
const LOOK_BINDINGS = Object.freeze([
  Object.freeze({ identityId: LOOK_A, providerLookId: 'server_look_a' }),
  Object.freeze({ identityId: LOOK_B, providerLookId: 'server_look_b' }),
]);
const PROVIDER_BINDING = Object.freeze({
  applicationAccountId: ACCOUNT,
  bindingId: '55555555-5555-4555-8555-555555555555',
  originScopeKey: 'a'.repeat(64),
});
const SOURCE_URL = 'https://media.example.test/luxify.mp4';

function luxifyJob(overrides = {}) {
  const id = overrides.id || 'job-luxify-workflow';
  const binding = {
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    title: 'LUXIFY workflow dispatch',
    prompt: 'A cinematic orbit with provider generated ambient sound.',
    lookBindings: LOOK_BINDINGS,
    eligibilityRevision: REVISION,
    aspectRatio: '16:9',
    resolution: '720p',
    durationSeconds: 8,
  };
  const token = issueLuxifyQuote(binding, {
    secret: SECRET,
    env: ENV,
    now: Date.parse('2026-10-11T20:00:00.000Z'),
    nonce: 'luxify-workflow-nonce-123456789',
  }).token;
  const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, binding, {
    secret: SECRET,
    env: ENV,
    now: Date.parse('2026-10-11T20:00:00.000Z'),
  }));
  return {
    id,
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: IDEMPOTENCY,
    correlationId: 'corr-luxify-workflow',
    provider: 'heygen',
    providerJobId: null,
    status: 'workflow_started',
    title: binding.title,
    format: 'landscape',
    costCredits: 41,
    input: {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      projectId: PROJECT,
      idempotencyKey: IDEMPOTENCY,
      title: binding.title,
      prompt: binding.prompt,
      lookIdentityIds: [LOOK_A, LOOK_B],
      aspectRatio: binding.aspectRatio,
      resolution: binding.resolution,
      durationSeconds: binding.durationSeconds,
      lookBindings: LOOK_BINDINGS.map(value => ({ ...value })),
      eligibleLookIds: LOOK_BINDINGS.map(value => value.providerLookId),
      eligibilityRevision: REVISION,
      quoteProof,
      renderAuthorization: {
        version: 1,
        accountId: ACCOUNT,
        tier: 'premium',
        entitlementKey: 'liveRendering',
        sourceType: 'admin_tester_grant',
        sourceId: null,
        jobId: id,
      },
    },
    output: {},
    ...overrides,
  };
}

function presenterJob(overrides = {}) {
  const id = overrides.id || 'job-presenter-workflow';
  return {
    id,
    accountId: ACCOUNT,
    projectId: PROJECT,
    idempotencyKey: '66666666-6666-4666-8666-666666666666',
    correlationId: 'corr-presenter-workflow',
    provider: 'heygen',
    providerJobId: null,
    status: 'workflow_started',
    title: 'Presenter workflow dispatch',
    format: 'landscape',
    costCredits: 90,
    input: {
      renderMode: 'premium_presenter_v1',
      identityId: '77777777-7777-4777-8777-777777777777',
      script: 'The existing Presenter adapter remains exact.',
      avatar: { avatarId: 'presenter_look' },
      voice: { voiceId: 'presenter_voice' },
      renderAuthorization: {
        version: 1,
        accountId: ACCOUNT,
        tier: 'premium',
        entitlementKey: 'liveRendering',
        sourceType: 'admin_tester_grant',
        sourceId: null,
        jobId: id,
      },
    },
    output: {},
    ...overrides,
  };
}

const runFixture = process.argv.includes('--luxify-workflow-fixture');

if (runFixture) {
  process.env.HEYGEN_API_KEY = 'local-test-key';
  process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED = 'true';
  process.env.VIDEO_OS_COMPOSITION_ENGINE = 'ffmpeg';

  let currentJob = luxifyJob();
  let failLuxifySubmit = false;
  const calls = {
    authorizations: [],
    transitions: [],
    luxifySubmissions: [],
    presenterSubmissions: [],
    luxifyPolls: [],
    presenterPolls: [],
    luxifyFinishes: [],
    presenterFinishes: [],
    finalizations: [],
  };

  function frozenJob(job, extra = {}) {
    return Object.freeze({ ...job, ...extra });
  }

  function claimProof(job) {
    return Object.freeze({
      version: 'heygen-render-provider-claim/v1',
      operationId: 'provider_operation_1',
      operationState: 'pending',
      requestDigest: 'b'.repeat(64),
      bindingId: PROVIDER_BINDING.bindingId,
      originScopeKey: PROVIDER_BINDING.originScopeKey,
      accountId: job.accountId,
      jobId: job.id,
    });
  }

  function providerReadClaim(job, ready = false) {
    return Object.freeze({
      version: 'heygen-video-read-claim/v1',
      job: frozenJob(job),
      providerJobId: job.providerJobId,
      operationId: 'provider_operation_1',
      resourceId: 'provider_resource_1',
      sourceUrlDigest: ready ? createHash('sha256').update(SOURCE_URL, 'utf8').digest('hex') : null,
    });
  }

  mock.module('../db/repositories.js', { namedExports: {
    finalizeReadyJob: async (jobId, artifact) => {
      calls.finalizations.push({ jobId, artifact });
      currentJob = { ...currentJob, status: 'ready', output: artifact };
      return { ...currentJob, justCompleted: true };
    },
    getJob: async jobId => currentJob.id === jobId ? currentJob : null,
    prepareProviderVideoFinish: async ({ jobId }) => {
      assert.equal(jobId, currentJob.id);
      return providerReadClaim(currentJob, true);
    },
    prepareProviderVideoRead: async ({ jobId, providerJobId }) => {
      assert.equal(jobId, currentJob.id);
      assert.equal(providerJobId, currentJob.providerJobId);
      return providerReadClaim(currentJob, ['provider_ready', 'finishing'].includes(currentJob.status));
    },
    requireJobRenderAuthorization: async (job, tier) => {
      calls.authorizations.push({ jobId: job.id, tier });
      return { tier };
    },
    markJobFailedAndRelease: async () => null,
    transitionJob: async input => {
      calls.transitions.push(input);
      if (input.stageTo === 'provider_submitting') {
        currentJob = frozenJob({ ...currentJob, status: input.stageTo }, { providerClaimProof: claimProof(currentJob) });
        return currentJob;
      }
      currentJob = {
        ...currentJob,
        status: input.stageTo,
        ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
      };
      return currentJob;
    },
  } });
  mock.module('../db/heygen-space-binding-repository.js', { namedExports: {
    assertFreshHeygenSpaceBinding: () => true,
    resolveFreshHeygenSpaceBinding: async () => PROVIDER_BINDING,
  } });
  mock.module('../db/provider-reconciliation-repository.js', { namedExports: {
    providerCreationActivationStatus: () => ({ enabled: true }),
  } });
  mock.module('../services/heygen.js', { namedExports: {
    assertHeygenConfigured: () => true,
    submitHeygenLuxify: async input => {
      calls.luxifySubmissions.push(input);
      if (failLuxifySubmit) {
        throw Object.assign(new Error('submission outcome unknown'), {
          failureCategory: 'PROVIDER_SUBMIT_UNKNOWN',
          providerSubmissionPossible: true,
        });
      }
      return { providerJobId: 'luxify_provider_video' };
    },
    submitHeygen: async job => {
      calls.presenterSubmissions.push(job);
      return { providerJobId: 'presenter_provider_video' };
    },
    pollHeygenLuxify: async providerJobId => {
      calls.luxifyPolls.push(providerJobId);
      return { ready: true, status: 'completed', sourceUrl: SOURCE_URL };
    },
    pollHeygen: async providerJobId => {
      calls.presenterPolls.push(providerJobId);
      return { ready: true, status: 'completed', sourceUrl: SOURCE_URL };
    },
  } });
  mock.module('../services/luxify-finisher.js', { namedExports: {
    finishLuxifyMedia: async (job, sourceUrl) => {
      calls.luxifyFinishes.push({ job, sourceUrl });
      return { privatePathname: 'luxify-final.mp4', bytes: 100, sha256: 'c'.repeat(64) };
    },
  } });
  mock.module('../services/media-finisher.js', { namedExports: {
    downloadProviderMedia: async () => 0,
    hashFile: async () => '0'.repeat(64),
    finishMedia: async (job, sourceUrl) => {
      calls.presenterFinishes.push({ job, sourceUrl });
      return { privatePathname: 'presenter-final.mp4', bytes: 100, sha256: 'd'.repeat(64) };
    },
  } });
  mock.module('../lib/video-os-render-notify.js', { namedExports: {
    notifyRenderReady: async () => true,
  } });

  const workflow = await import('../workflows/video-render.js');

  test('persisted LUXIFY mode selects only the cinematic submit, poll, and finishing adapters', async () => {
    currentJob = luxifyJob();
    const submitted = await workflow.submitProvider(currentJob.id);
    assert.equal(submitted.providerJobId, 'luxify_provider_video');
    assert.equal(calls.luxifySubmissions.length, 1);
    assert.equal(calls.presenterSubmissions.length, 0);
    assert.deepEqual(calls.luxifySubmissions[0], {
      idempotencyKey: currentJob.id,
      prompt: currentJob.input.prompt,
      eligibleLookIds: ['server_look_a', 'server_look_b'],
      duration: 8,
      resolution: '720p',
      aspectRatio: '16:9',
      title: currentJob.title,
    });
    assert.equal(JSON.stringify(calls.luxifySubmissions[0]).includes('voice'), false);
    assert.equal(JSON.stringify(calls.luxifySubmissions[0]).includes('script'), false);
    assert.deepEqual(calls.authorizations.at(-1), { jobId: currentJob.id, tier: 'premium' });

    const status = await workflow.pollProvider(currentJob.id, submitted.providerJobId);
    assert.equal(status.ready, true);
    assert.deepEqual(calls.luxifyPolls, ['luxify_provider_video']);
    assert.equal(calls.presenterPolls.length, 0);
    const artifact = await workflow.finishProviderMedia(currentJob.id, status.sourceUrl);
    assert.equal(artifact.privatePathname, 'luxify-final.mp4');
    assert.equal(calls.luxifyFinishes.length, 1);
    assert.equal(calls.presenterFinishes.length, 0);
    assert.equal(calls.finalizations.length, 1);
  });

  test('Premium Presenter keeps the existing submit, poll, and finishing adapters', async () => {
    currentJob = presenterJob();
    const submitted = await workflow.submitProvider(currentJob.id);
    assert.equal(submitted.providerJobId, 'presenter_provider_video');
    assert.equal(calls.presenterSubmissions.length, 1);
    const status = await workflow.pollProvider(currentJob.id, submitted.providerJobId);
    assert.equal(status.ready, true);
    assert.deepEqual(calls.presenterPolls, ['presenter_provider_video']);
    const artifact = await workflow.finishProviderMedia(currentJob.id, status.sourceUrl);
    assert.equal(artifact.privatePathname, 'presenter-final.mp4');
    assert.equal(calls.presenterFinishes.length, 1);
  });

  test('LUXIFY hosted-finishing drift blocks provider claim and spend', async () => {
    currentJob = luxifyJob({ id: 'job-luxify-finishing-disabled' });
    const transitionsBefore = calls.transitions.length;
    const submissionsBefore = calls.luxifySubmissions.length;
    const authorizationsBefore = calls.authorizations.length;
    process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED = 'false';
    try {
      await assert.rejects(
        workflow.submitProvider(currentJob.id),
        /VIDEO_OS_HEYGEN_PRECLAIM_V1:CONFIG_MISSING/,
      );
    } finally {
      process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED = 'true';
    }
    assert.equal(currentJob.status, 'workflow_started');
    assert.equal(calls.transitions.length, transitionsBefore);
    assert.equal(calls.luxifySubmissions.length, submissionsBefore);
    assert.equal(calls.authorizations.length, authorizationsBefore);
  });

  test('an uncertain LUXIFY POST is held after one attempt and cannot be replayed', async () => {
    currentJob = luxifyJob({ id: 'job-luxify-unknown' });
    currentJob.input.renderAuthorization.jobId = currentJob.id;
    failLuxifySubmit = true;
    const before = calls.luxifySubmissions.length;
    await assert.rejects(workflow.submitProvider(currentJob.id), /VIDEO_OS_PROVIDER_SUBMISSION_POSSIBLE_V1/);
    assert.equal(currentJob.status, 'provider_submit_unknown');
    assert.equal(calls.luxifySubmissions.length, before + 1);
    await assert.rejects(workflow.submitProvider(currentJob.id), /VIDEO_OS_PROVIDER_SUBMISSION_POSSIBLE_V1/);
    assert.equal(calls.luxifySubmissions.length, before + 1);
    assert.equal(calls.transitions.filter(value => value.stageTo === 'provider_submit_unknown').length, 1);
  });
} else {
  const workflow = await import('../workflows/video-render.js');

  test('pure persisted-mode dispatch rejects malformed LUXIFY markers and keeps Presenter separate', () => {
    const job = luxifyJob();
    assert.equal(workflow.providerWorkflowMode(job), 'luxify');
    assert.deepEqual(workflow.luxifyProviderSubmission(job), {
      idempotencyKey: job.id,
      prompt: job.input.prompt,
      eligibleLookIds: ['server_look_a', 'server_look_b'],
      duration: 8,
      resolution: '720p',
      aspectRatio: '16:9',
      title: job.title,
    });
    assert.equal(workflow.providerWorkflowMode(presenterJob()), 'presenter');
    for (const input of [
      { providerCapability: 'cinematic_avatar_v2' },
      { contractVersion: ' LUXIFY-CINEMATIC-V2 ' },
      { renderMode: ' LUXIFY_CINEMATIC_V2 ' },
    ]) {
      assert.throws(
        () => workflow.providerWorkflowMode({ ...presenterJob(), input }),
        { code: 'LUXIFY_JOB_BINDING_INVALID', failureCategory: 'RECONCILIATION' },
      );
    }
  });

  test('workflow integration dispatches both modes and contains unknown LUXIFY submission', () => {
    const path = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      path,
      '--luxify-workflow-fixture',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  });
}
