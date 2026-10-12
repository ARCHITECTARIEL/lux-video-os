import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { getP0JobAttestation, P0JobAttestationError } from '../db/p0-job-attestation.js';
import * as schema from '../db/schema.js';
import { accountHash } from '../lib/video-os-security.js';
import { acceptedJobOutput } from '../lib/video-os-output-acceptance.js';
import { acceptedJob } from './helpers/output-acceptance-fixture.mjs';
import {
  PREMIUM_SCRIPTED_PHOTO_CREDITS,
  SCRIPTED_PHOTO_CONTRACT_VERSION,
} from '../lib/scripted-photo-contract.js';
import {
  issueScriptedPhotoQuote,
  safeScriptedPhotoQuoteProof,
  verifyScriptedPhotoQuote,
} from '../lib/scripted-photo-quote.js';
import { providerVideoOperationRequestDigest } from '../db/repositories.js';
import {
  LUXIFY_CONTRACT_VERSION,
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
} from '../lib/luxify-contract.js';
import { issueLuxifyQuote, safeLuxifyQuoteProof, verifyLuxifyQuote } from '../lib/luxify-quote.js';

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

function fixture(renderMode = 'premium_presenter_v1') {
  const accountId = 'private-owner-account-id';
  const projectId = '11111111-1111-4111-8111-111111111111';
  const idempotencyKey = '22222222-2222-4222-8222-222222222222';
  const lookIdentityId = '33333333-3333-4333-8333-333333333333';
  const lookBindings = [{ identityId: lookIdentityId, providerLookId: 'look_private_1' }];
  const presenterIdentityId = '44444444-4444-4444-8444-444444444444';
  const presenterSourceBinding = {
    policyVersion: '2026-09-identity-v1',
    consentId: '55555555-5555-4555-8555-555555555555',
    sourcePhotoAssetId: '66666666-6666-4666-8666-666666666666',
    sourceVoiceAssetId: '77777777-7777-4777-8777-777777777777',
    photoSha256: 'a'.repeat(64),
    voiceSha256: 'b'.repeat(64),
    photoKind: 'identity-photo-source',
    voiceKind: 'identity-voice-source',
    photoContentType: 'image/png',
    voiceContentType: 'audio/wav',
    photoPrivatePathname: 'video-os/uploads/private/photo.png',
    voicePrivatePathname: 'video-os/uploads/private/voice.wav',
    provider: 'heygen',
    providerRenderableAvatarId: 'presenter_avatar_1',
    providerVoiceId: 'presenter_voice_1',
  };
  const presenterScript = 'private presenter script';
  const presenterQuoteBinding = {
    accountId,
    projectId,
    identityId: presenterIdentityId,
    idempotencyKey,
    title: 'Accepted contract sample',
    script: presenterScript,
    format: 'vertical',
    tier: 'PREMIUM',
    sourceBinding: presenterSourceBinding,
    credits: PREMIUM_SCRIPTED_PHOTO_CREDITS,
  };
  const presenterQuoteOptions = {
    secret: 'p0-attestation-presenter-secret-at-least-32-bytes',
    now: Date.parse('2026-10-11T15:00:00.000Z'),
  };
  const presenterToken = issueScriptedPhotoQuote(presenterQuoteBinding, {
    ...presenterQuoteOptions,
    nonce: 'p0-attestation-presenter-nonce-123456',
  }).token;
  let input = {
    contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
    tier: 'PREMIUM',
    renderMode: 'premium_presenter_v1',
    projectId,
    identityId: presenterIdentityId,
    script: presenterScript,
    avatar: { avatarId: presenterSourceBinding.providerRenderableAvatarId },
    voice: { voiceId: presenterSourceBinding.providerVoiceId },
    sourceBinding: presenterSourceBinding,
    quoteProof: safeScriptedPhotoQuoteProof(verifyScriptedPhotoQuote(
      presenterToken,
      presenterQuoteBinding,
      presenterQuoteOptions,
    )),
    renderAuthorization: {
      version: 1,
      accountId,
      tier: 'premium',
      entitlementKey: 'liveRendering',
      sourceType: 'admin_tester_grant',
      sourceId: null,
      jobId: 'job-p0-attestation',
    },
  };
  let title = 'Accepted contract sample';
  let format = 'vertical';
  let costCredits = 90;
  if (renderMode === LUXIFY_RENDER_MODE) {
    title = 'Private LUXIFY proof';
    format = 'landscape';
    costCredits = 41;
    const quoteBinding = {
      accountId,
      projectId,
      idempotencyKey,
      title,
      prompt: 'private cinematic prompt',
      lookBindings,
      eligibilityRevision: 'luxify-look-eligibility-v1:p0-test',
      aspectRatio: '16:9',
      resolution: '720p',
      durationSeconds: 8,
    };
    const quoteOptions = {
      secret: 'p0-attestation-luxify-secret-at-least-32-bytes',
      env: { VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' },
      now: Date.parse('2026-10-11T15:00:00.000Z'),
    };
    const token = issueLuxifyQuote(quoteBinding, { ...quoteOptions, nonce: 'p0-attestation-luxify-nonce-123456' }).token;
    const quoteProof = safeLuxifyQuoteProof(verifyLuxifyQuote(token, quoteBinding, quoteOptions));
    input = {
      contractVersion: LUXIFY_CONTRACT_VERSION,
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      projectId,
      idempotencyKey,
      title,
      prompt: quoteBinding.prompt,
      lookIdentityIds: [lookIdentityId],
      aspectRatio: quoteBinding.aspectRatio,
      resolution: quoteBinding.resolution,
      durationSeconds: quoteBinding.durationSeconds,
      lookBindings,
      eligibleLookIds: lookBindings.map(value => value.providerLookId),
      eligibilityRevision: quoteBinding.eligibilityRevision,
      quoteProof,
      renderAuthorization: {
        version: 1,
        accountId,
        tier: 'premium',
        entitlementKey: 'liveRendering',
        sourceType: 'admin_tester_grant',
        sourceId: null,
        jobId: 'job-p0-attestation',
      },
    };
  }
  const job = acceptedJob('heygen', {
    id: 'job-p0-attestation',
    accountId,
    projectId,
    idempotencyKey,
    title,
    format,
    costCredits,
    correlationId: 'corr-11111111-1111-4111-8111-111111111111',
    providerJobId: 'provider-video-123',
    input,
  });
  if (renderMode === LUXIFY_RENDER_MODE) {
    Object.assign(job.output.acceptance, {
      renderMode: LUXIFY_RENDER_MODE,
      providerCapability: LUXIFY_PROVIDER_CAPABILITY,
      resolution: '720p',
      aspectRatio: '16:9',
    });
    Object.assign(job.output.acceptance.media, {
      width: 1280,
      height: 720,
      durationMs: 8_000,
      expectedDurationMs: 8_000,
    });
  }
  const proofId = randomUUID();
  const operationId = randomUUID();
  const resourceId = randomUUID();
  const referenceId = randomUUID();
  const bindingId = randomUUID();
  const scopeKey = '6'.repeat(64);
  const events = [
    { id: proofId, jobId: job.id, correlationId: job.correlationId, eventType: 'render.reserved', details: {} },
    { id: randomUUID(), jobId: job.id, correlationId: job.correlationId, eventType: 'provider.submit_started', details: {} },
    { id: randomUUID(), jobId: job.id, correlationId: job.correlationId, eventType: 'provider.submitted', details: {} },
    { id: randomUUID(), jobId: job.id, correlationId: job.correlationId, eventType: 'finish.completed', details: { sha256: job.output.sha256, bytes: job.output.bytes } },
  ];
  const operation = {
    id: operationId, applicationAccountId: accountId, bindingId, originScopeKey: scopeKey,
    kind: 'video_create', state: 'succeeded', attempt: 1, correlationId: job.correlationId,
    originOperationKey: job.id, enrollmentId: null,
    identityId: renderMode === 'premium_presenter_v1' ? job.input.identityId : null,
    jobId: job.id, requestDigest: providerVideoOperationRequestDigest(job),
    submittedAt: new Date(), completedAt: new Date(),
  };
  const resource = {
    id: resourceId, applicationAccountId: accountId, bindingId, originScopeKey: scopeKey,
    verifiedAccountScopeId: randomUUID(), kind: 'video', providerResourceId: job.providerJobId,
    originOperationId: operationId, state: 'ready',
  };
  const reference = {
    id: referenceId, applicationAccountId: accountId, originScopeKey: scopeKey,
    resourceId, consumerKind: 'job', consumerId: job.id, originOperationId: operationId,
    state: 'released',
  };
  const providerEvents = [
    { eventType: 'provider.operation_reserved' },
    { eventType: 'provider.operation_claimed' },
    { eventType: 'provider.resource_observed', resourceId, observedResourceKind: 'video', observedProviderResourceId: job.providerJobId },
    { eventType: 'provider.resource_ready', resourceId, observedResourceKind: 'video', observedProviderResourceId: job.providerJobId, details: { sourceUrlDigest: '8'.repeat(64) } },
    { eventType: 'provider.consumer_released_after_private_acceptance', resourceId, referenceId, details: { consumerKind: 'job', consumerId: job.id } },
  ].map(value => ({
    id: randomUUID(), applicationAccountId: accountId, originScopeKey: scopeKey,
    operationId, correlationId: job.correlationId, ...value,
  }));
  const deploymentId = 'deployment-p0-test';
  const sourceCommit = 'source-p0-test';
  const env = {
    VERCEL_ENV: 'production',
    VERCEL_DEPLOYMENT_ID: deploymentId,
    VERCEL_GIT_COMMIT_SHA: sourceCommit,
  };
  const binding = {
    proofId,
    jobId: job.id,
    correlationId: job.correlationId,
    accountHash: accountHash(accountId),
    deploymentIdHash: sha256(deploymentId),
    sourceCommitHash: sha256(sourceCommit),
    deploymentMode: 'production',
    renderMode,
  };
  return {
    binding,
    env,
    rows: new Map([
      [schema.videoJobs, [job]],
      [schema.jobEvents, events],
      [schema.creditTransactions, [{
        id: randomUUID(), accountId, sourceType: 'render', sourceId: 'render:' + job.id,
        amount: -job.costCredits, balanceAfter: 410, metadata: { jobId: job.id },
      }]],
      [schema.mediaAssets, [{
        id: randomUUID(), accountId, jobId: job.id, kind: 'final',
        privatePathname: job.output.privatePathname, sha256: job.output.sha256, bytes: job.output.bytes,
        contentType: 'video/mp4', quarantinedAt: null,
        widthPx: job.output.acceptance.media.width, heightPx: job.output.acceptance.media.height,
        durationMs: Math.round(job.output.acceptance.media.durationMs),
      }]],
      [schema.providerLifecycleOperations, [operation]],
      [schema.providerResources, [resource]],
      [schema.providerConsumerReferences, [reference]],
      [schema.providerLifecycleEvents, providerEvents],
    ]),
    privateValues: [
      accountId,
      job.title,
      job.output.privatePathname,
      job.input.script,
      job.input.prompt,
      deploymentId,
      sourceCommit,
    ].filter(Boolean),
  };
}

function fakeDatabase(rows) {
  let transactionOptions;
  const tx = {
    select() {
      let table;
      return {
        from(value) { table = value; return this; },
        where() { return this; },
        limit() { return this; },
        then(resolve, reject) { return Promise.resolve(rows.get(table) || []).then(resolve, reject); },
      };
    },
    async execute() {
      return { rows: [{ observed_at: '2026-10-11T16:00:00.000Z' }] };
    },
  };
  return {
    factory: () => ({
      async transaction(callback, options) {
        transactionOptions = options;
        return callback(tx);
      },
    }),
    options: () => transactionOptions,
  };
}

async function attest(state) {
  const db = fakeDatabase(state.rows);
  const result = await getP0JobAttestation(state.binding, { databaseFactory: db.factory, env: state.env });
  return { result, options: db.options() };
}

test('job attestation reconciles one read-only snapshot for Presenter and LUXIFY', async () => {
  for (const [mode, capability] of [
    ['premium_presenter_v1', 'avatar'],
    ['luxify_cinematic_v1', 'cinematic_avatar'],
  ]) {
    const state = fixture(mode);
    const job = state.rows.get(schema.videoJobs)[0];
    assert.equal(job.id, state.binding.jobId);
    assert.equal(job.correlationId, state.binding.correlationId);
    assert.equal(accountHash(job.accountId), state.binding.accountHash);
    assert.equal(job.input.renderMode, state.binding.renderMode);
    assert.equal(acceptedJobOutput(job), true, JSON.stringify(job));
    const { result, options } = await attest(state);
    assert.deepEqual(options, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    assert.equal(result.ok, true);
    assert.equal(result.applicationSnapshotComplete, true);
    assert.equal(result.providerNativeVerified, false);
    assert.equal(result.sourceByteAttested, false);
    assert.equal(result.artifactBytesAttested, false);
    assert.deepEqual(result.readerDeployment, {
      deploymentIdHash: state.binding.deploymentIdHash,
      deploymentMode: state.binding.deploymentMode,
    });
    assert.deepEqual(result.readerEnvironmentGitCommit, {
      commitHash: state.binding.sourceCommitHash,
    });
    assert.equal(Object.hasOwn(result, 'source'), false);
    assert.equal(Object.hasOwn(result.binding, 'deploymentIdHash'), false);
    assert.equal(Object.hasOwn(result.binding, 'deploymentMode'), false);
    assert.equal(result.binding.renderMode, mode);
    assert.equal(result.binding.providerCapability, capability);
    assert.equal(result.counts.providerSubmissionEvents, 1);
    assert.equal(result.counts.creditDebits, 1);
    assert.equal(result.counts.finalAssets, 1);
    assert.equal(result.counts.recoveryEvents, 0);
    assert.equal(result.credit.amount, -result.credit.costCredits);
    assert.equal(result.finalMediaRecord.sha256, state.rows.get(schema.videoJobs)[0].output.sha256);
    assert.equal(result.finalMediaRecord.bytesReadbackAttested, false);
    const serialized = JSON.stringify(result);
    for (const value of state.privateValues) assert.equal(serialized.includes(value), false);
    assert.doesNotMatch(serialized, /https?:\/\/|access[_-]?token|authorization|cookie/i);
  }
});

test('job attestation fails closed on binding, mode, and deployment drift', async () => {
  for (const mutate of [
    state => { state.binding.accountHash = 'b'.repeat(24); },
    state => { state.binding.deploymentIdHash = 'c'.repeat(64); },
    state => { state.binding.correlationId = 'corr-different'; },
    state => { state.rows.get(schema.videoJobs)[0].input.renderMode = undefined; },
    state => { state.binding.renderMode = 'legacy_unknown'; },
  ]) {
    const state = fixture();
    mutate(state);
    await assert.rejects(attest(state), error => {
      assert.ok(error instanceof P0JobAttestationError);
      return true;
    });
  }
});

test('job attestation rejects duplicate or missing accounting and provider rows', async () => {
  for (const table of [
    schema.jobEvents,
    schema.creditTransactions,
    schema.mediaAssets,
    schema.providerLifecycleOperations,
    schema.providerResources,
    schema.providerConsumerReferences,
    schema.providerLifecycleEvents,
  ]) {
    const state = fixture();
    const rows = state.rows.get(table);
    if (table === schema.jobEvents || table === schema.providerLifecycleEvents) rows.push({ ...rows[0], id: randomUUID() });
    else rows.push({ ...rows[0], id: randomUUID() });
    await assert.rejects(attest(state), error => {
      assert.ok(error instanceof P0JobAttestationError);
      return true;
    });
  }

  const recovery = fixture();
  recovery.rows.get(schema.jobEvents).push({
    id: randomUUID(), jobId: recovery.binding.jobId, correlationId: recovery.binding.correlationId,
    eventType: 'workflow.recovery_reserved', details: {},
  });
  await assert.rejects(attest(recovery), { code: 'job_event_conflict' });
});

test('job attestation rejects malformed Presenter persistence and arbitrary provider digests', async () => {
  for (const mutate of [
    state => { delete state.rows.get(schema.videoJobs)[0].input.quoteProof; },
    state => { delete state.rows.get(schema.videoJobs)[0].input.renderAuthorization; },
    state => { state.rows.get(schema.videoJobs)[0].input.tier = 'STANDARD'; },
    state => { state.rows.get(schema.videoJobs)[0].input.avatar.avatarId = 'wrong-avatar'; },
  ]) {
    const state = fixture('premium_presenter_v1');
    mutate(state);
    await assert.rejects(attest(state), { code: 'job_binding_mismatch' });
  }

  for (const mutate of [
    operation => { operation.requestDigest = 'f'.repeat(64); },
    operation => { operation.originOperationKey = 'another-job'; },
    operation => { operation.identityId = null; },
  ]) {
    const state = fixture('premium_presenter_v1');
    mutate(state.rows.get(schema.providerLifecycleOperations)[0]);
    await assert.rejects(attest(state), { code: 'provider_operation_mismatch' });
  }

  const luxifyIdentity = fixture('luxify_cinematic_v1');
  luxifyIdentity.rows.get(schema.providerLifecycleOperations)[0].identityId = randomUUID();
  await assert.rejects(attest(luxifyIdentity), { code: 'provider_operation_mismatch' });
});

test('job attestation rejects non-MP4, quarantined, or metadata-drifted final rows', async () => {
  for (const mutate of [
    final => { final.contentType = 'video/webm'; },
    final => { final.quarantinedAt = new Date(); },
    final => { final.widthPx += 1; },
    final => { final.heightPx += 1; },
    final => { final.durationMs += 1; },
  ]) {
    const state = fixture();
    mutate(state.rows.get(schema.mediaAssets)[0]);
    await assert.rejects(attest(state), { code: 'final_asset_mismatch' });
  }
});
