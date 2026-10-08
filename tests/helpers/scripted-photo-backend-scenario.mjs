import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { FatalError } from 'workflow';

import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION, parseDurableRenderFailure } from '../../lib/scripted-photo-contract.js';
import { SCRIPTED_PHOTO_QUOTE_TTL_MS, issueScriptedPhotoQuote, safeScriptedPhotoQuoteProof, verifyScriptedPhotoQuote } from '../../lib/scripted-photo-quote.js';
import { assertFreshProviderAvatarConsentObservation, observeProviderAvatarConsent } from '../../lib/provider-avatar-consent.js';

const scenario = process.argv[2];
const accountId = 'scripted-standard-owner';
const projectId = '11111111-1111-4111-8111-111111111111';
const identityId = '22222222-2222-4222-8222-222222222222';
const photoId = '33333333-3333-4333-8333-333333333333';
const voiceId = '44444444-4444-4444-8444-444444444444';
const consentId = '55555555-5555-4555-8555-555555555555';
const title = 'Bound Standard script';
const script = 'This exact saved script is rendered through HeyGen.';

function authority(tier, jobId) {
  return {
    version: 1,
    accountId,
    tier,
    entitlementKey: tier === 'standard' ? 'standardRendering' : 'liveRendering',
    sourceType: 'test_fixture',
    sourceId: null,
    jobId,
  };
}

if (scenario === 'repository') {
  const schema = await import('../../db/schema.js');
  let grants = [{ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture', sourceId: null }];
  const credit = { accountId, balance: 500, reserved: 0, spent: 0 };
  const project = { id: projectId, accountId, identityId, title, script, settings: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', format: 'vertical' } };
  const identity = {
    id: identityId, accountId, provider: 'heygen', overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY', archivedAt: null,
    sourcePhotoAssetId: photoId, sourceVoiceAssetId: voiceId, providerAvatarGroupId: 'heygen-avatar-group', providerRenderableAvatarId: 'heygen-avatar', providerVoiceId: 'heygen-voice',
  };
  const consent = { id: consentId, accountId, identityId, policyVersion: IDENTITY_CONSENT_POLICY_VERSION, photoSha256: 'a'.repeat(64), voiceSha256: 'b'.repeat(64), revokedAt: null };
  const photo = { id: photoId, accountId, kind: 'identity-photo-source', contentType: 'image/png', privatePathname: `video-os/uploads/${accountId}/photo.png`, sha256: consent.photoSha256, quarantinedAt: null };
  const voice = { id: voiceId, accountId, kind: 'identity-voice-source', contentType: 'audio/wav', privatePathname: `video-os/uploads/${accountId}/voice.wav`, sha256: consent.voiceSha256, quarantinedAt: null };
  const jobs = [];
  const lockOrder = [];
  let mediaReads = 0;
  let creditLockDelayMs = 0;

  const rowsFor = (table) => {
    if (table === schema.entitlements) return grants;
    if (table === schema.users) return [{ id: accountId, email: null }];
    if (table === schema.creditAccounts) return [credit];
    if (table === schema.videoJobs) return jobs;
    if (table === schema.projects) return [project];
    if (table === schema.userIdentities) return [identity];
    if (table === schema.identityConsents) return consent.revokedAt ? [] : [consent];
    if (table === schema.mediaAssets) return [mediaReads++ % 2 === 0 ? photo : voice];
    return [];
  };
  const nameFor = (table) => table === schema.creditAccounts ? 'credit' : table === schema.userIdentities ? 'identity' : table === schema.identityConsents ? 'consent' : table === schema.mediaAssets ? 'asset' : table === schema.entitlements ? 'entitlement' : 'other';
  const db = {
    transaction: async fn => fn(db),
    execute: async () => ({ rows: [] }),
    select() {
      let table;
      const query = {
        from(value) { table = value; return this; }, where() { return this; }, orderBy() { return this; }, limit() { return this; },
        for(mode) { lockOrder.push(`${nameFor(table)}:${mode}`); return this; },
        then(resolve, reject) {
          const delay = table === schema.creditAccounts ? creditLockDelayMs : 0;
          return new Promise(done => setTimeout(done, delay)).then(() => rowsFor(table)).then(resolve, reject);
        },
      };
      return query;
    },
    update(table) {
      return { set(values) {
        return { where() {
          if (table === schema.creditAccounts) Object.assign(credit, values);
          if (table === schema.videoJobs && jobs[0]) Object.assign(jobs[0], values);
          const result = table === schema.videoJobs && jobs[0] ? [jobs[0]] : [];
          return { returning: async () => result, then(resolve, reject) { return Promise.resolve(undefined).then(resolve, reject); } };
        } };
      } };
    },
    insert(table) {
      return { values(values) {
        if (table === schema.videoJobs) {
          jobs.push(values);
          return { returning: async () => [values] };
        }
        return Promise.resolve(values);
      } };
    },
  };
  mock.module('../../db/client.js', { namedExports: { database: () => db } });
  // This scenario proves quotes, authorization and financial ordering. The
  // provider ledger has its own repository/live suite; supply explicit scoped
  // resources here and still require both job references to be attached.
  const providerBinding = { fixture: 'scripted-financial-verified-binding', applicationAccountId: accountId, bindingId: 'fixture-binding', originScopeKey: '6'.repeat(64), verifiedAccountScopeId: 'fixture-verified-account' };
  const { acquireProviderLifecycleLock } = await import('../../db/provider-lifecycle-lock.js');
  let activeBindingTransaction = null;
  mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
    withFreshHeygenSpaceBindingTransaction: async (input, callback) => {
      assert.equal(input.accountId, accountId); assert.equal(input.providerBinding, providerBinding);
      return db.transaction(async tx => {
        await acquireProviderLifecycleLock(tx, accountId);
        activeBindingTransaction = tx;
        try { return await callback(tx); } finally { activeBindingTransaction = null; }
      });
    },
    withHeygenSpaceBindingReceiptTransaction: async (input, callback) => db.transaction(callback),
    assertFreshHeygenProviderClaimTx: (tx, input) => {
      assert.equal(tx, activeBindingTransaction); assert.equal(input.providerBinding, providerBinding); return providerBinding;
    },
    assertHeygenProviderReceiptTx: () => providerBinding,
  } });
  const providerLedger = await import('../../db/provider-reconciliation-repository.js');
  const providerResources = [
    { id: 'fixture-group-resource', applicationAccountId: accountId, bindingId: 'fixture-binding', originScopeKey: '6'.repeat(64), kind: 'avatar_group', providerResourceId: 'heygen-avatar-group', originOperationId: 'fixture-avatar-operation', verifiedAccountScopeId: 'fixture-verified-account' },
    { id: 'fixture-look-resource', applicationAccountId: accountId, bindingId: 'fixture-binding', originScopeKey: '6'.repeat(64), kind: 'avatar_look', providerResourceId: 'heygen-avatar', originOperationId: 'fixture-avatar-operation', verifiedAccountScopeId: 'fixture-verified-account' },
    { id: 'fixture-voice-resource', applicationAccountId: accountId, bindingId: 'fixture-binding', originScopeKey: '6'.repeat(64), kind: 'voice', providerResourceId: 'heygen-voice', originOperationId: 'fixture-voice-operation', verifiedAccountScopeId: 'fixture-verified-account' },
  ];
  const attachedReferences = [];
  mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
    ...providerLedger,
    assertProviderJobReferencesActiveTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId); assert.equal(input.jobId, jobs[0].id);
      assert.equal(input.providerBinding, providerBinding);
      assert.deepEqual(input.expectedResources, providerResources.map(({ kind, providerResourceId }) => ({ kind, providerResourceId })));
      assert.equal(attachedReferences.length, 3);
      return true;
    },
    reserveProviderOperationTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId);
      assert.equal(input.providerBinding, providerBinding); assert.equal(input.kind, 'video_create');
      assert.equal(input.identityId, identityId); assert.equal(input.jobId, jobs[0].id);
      return { binding: { id: 'fixture-binding', originScopeKey: '6'.repeat(64) }, operation: { id: 'fixture-video-operation', state: 'pending' } };
    },
    recordProviderVideoResourceTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId); assert.equal(input.jobId, jobs[0].id);
      assert.ok(input.providerJobId);
      return { resources: [{ id: 'fixture-video-resource', kind: 'video', providerResourceId: input.providerJobId }], conflicts: [] };
    },
    markProviderVideoReadyTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId); assert.equal(input.jobId, jobs[0].id);
      return { id: 'fixture-video-resource', state: 'ready' };
    },
    getExactProviderResourceTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId); assert.equal(input.lock, true);
      const found = providerResources.find(resource => resource.kind === input.kind && resource.providerResourceId === input.providerResourceId);
      assert.ok(found, 'Only the exact owned avatar group, presenter, and voice resources are fixtures.');
      return found;
    },
    attachProviderConsumerReferenceTx: async (tx, input) => {
      assert.equal(tx, db); assert.equal(input.accountId, accountId); assert.equal(input.consumerKind, 'job');
      const found = providerResources.find(resource => resource.id === input.resourceId);
      assert.ok(found); assert.equal(input.originOperationId, found.originOperationId);
      attachedReferences.push(input);
      return { ...input, state: 'active' };
    },
  } });
  const repo = await import('../../db/repositories.js');
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';

  const savedSettings = project.settings;
  project.settings = {};
  await assert.rejects(repo.getScriptedPhotoReservationContext({ accountId, projectId, identityId, title, script, tier: 'STANDARD' }), { statusCode: 409 });
  project.settings = { ...savedSettings, tier: 'PREMIUM' };
  await assert.rejects(repo.getScriptedPhotoReservationContext({ accountId, projectId, identityId, title, script, tier: 'STANDARD' }), { statusCode: 409 });
  project.settings = savedSettings;
  const context = await repo.getScriptedPhotoReservationContext({ accountId, projectId, identityId, title, script, tier: 'STANDARD' });
  const providerConsentObservation = async observedAt => observeProviderAvatarConsent({ accountId, identityId, sourceBinding: context.input.sourceBinding }, {
    resolveProviderBinding: async () => providerBinding,
    prepareProviderRead: async () => ({ accountId, identityId, component: 'avatar', providerAvatarGroupId: 'heygen-avatar-group', providerRenderableAvatarId: 'heygen-avatar' }),
    readProviderAvatarStatus: async () => ({
      ready: true,
      avatarGroup: { providerGroupId: 'heygen-avatar-group', status: 'completed', consentStatus: null, ready: true },
      avatarLook: { providerLookId: 'heygen-avatar', providerGroupId: 'heygen-avatar-group', avatarType: 'photo_avatar', status: 'completed', ready: true },
    }),
    now: () => observedAt ?? Date.now(),
  });
  const freshProviderConsentObservation = await providerConsentObservation();
  process.env.VIDEO_OS_SESSION_SECRET = 'scripted-photo-backend-quote-secret';
  const scriptedIdempotencyKey = randomUUID();
  const repositoryQuote = (idempotencyKey, { credits = 37, now = Date.now(), sourceBinding = context.input.sourceBinding } = {}) => issueScriptedPhotoQuote({
    accountId, projectId, identityId, idempotencyKey, title, script, format: 'vertical', tier: 'STANDARD', sourceBinding, credits,
  }, { now }).token;
  const quoteToken = repositoryQuote(scriptedIdempotencyKey);
  const standardRequest = {
    jobId: 'scripted-job', accountId, idempotencyKey: scriptedIdempotencyKey, correlationId: 'scripted-correlation', provider: 'heygen', tier: 'standard',
    title, format: 'vertical', costCredits: 37, input: context.input, quoteToken, providerAvatarConsentObservation: freshProviderConsentObservation,
  };
  delete process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED;
  await assert.rejects(repo.reserveRender(standardRequest), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  delete process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS;
  await assert.rejects(repo.reserveRender(standardRequest), { statusCode: 503, failureCategory: 'CONFIG_MISSING' });
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  await assert.rejects(repo.reserveRender({ ...standardRequest, jobId: 'premium-attempt', idempotencyKey: randomUUID(), tier: 'premium', costCredits: 90, input: { ...context.input, tier: 'PREMIUM' } }), { statusCode: 409 });
  const expiredKey = randomUUID();
  await assert.rejects(repo.reserveRender({ ...standardRequest, jobId: 'expired-attempt', idempotencyKey: expiredKey, quoteToken: repositoryQuote(expiredKey, { now: Date.now() - 10 * 60 * 1000 }) }), { statusCode: 410 });
  const sourceDriftKey = randomUUID();
  const sourceDriftToken = repositoryQuote(sourceDriftKey);
  photo.sha256 = 'c'.repeat(64);
  await assert.rejects(repo.reserveRender({ ...standardRequest, jobId: 'source-drift-attempt', idempotencyKey: sourceDriftKey, quoteToken: sourceDriftToken }), { failureCategory: 'CONSENT' });
  photo.sha256 = consent.photoSha256;
  const costDriftKey = randomUUID();
  const costDriftToken = repositoryQuote(costDriftKey);
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '38';
  await assert.rejects(repo.reserveRender({ ...standardRequest, jobId: 'cost-drift-attempt', idempotencyKey: costDriftKey, costCredits: 38, quoteToken: costDriftToken }), { statusCode: 409 });
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  const lockExpiryKey = randomUUID();
  const lockExpiryBinding = {
    accountId, projectId, identityId, idempotencyKey: lockExpiryKey, title, script, format: 'vertical', tier: 'STANDARD',
    sourceBinding: context.input.sourceBinding, credits: 37,
  };
  const lockExpiryToken = repositoryQuote(lockExpiryKey, { now: Date.now() - SCRIPTED_PHOTO_QUOTE_TTL_MS + 500 });
  assert.doesNotThrow(() => verifyScriptedPhotoQuote(lockExpiryToken, lockExpiryBinding));
  creditLockDelayMs = 700;
  await assert.rejects(repo.reserveRender({ ...standardRequest, jobId: 'lock-expiry-attempt', idempotencyKey: lockExpiryKey, quoteToken: lockExpiryToken }), { statusCode: 410 });
  creditLockDelayMs = 0;
  assert.equal(credit.reserved, 0, 'expired, changed-source and changed-cost quotes must fail before reservation');
  assert.equal(jobs.length, 0);
  const missingObservationKey = randomUUID();
  await assert.rejects(repo.reserveRender({
    ...standardRequest,
    jobId: 'missing-observation-attempt',
    idempotencyKey: missingObservationKey,
    quoteToken: repositoryQuote(missingObservationKey),
    providerAvatarConsentObservation: undefined,
  }), { statusCode: 409, failureCategory: 'CONSENT' });
  const staleObservationKey = randomUUID();
  await assert.rejects(repo.reserveRender({
    ...standardRequest,
    jobId: 'stale-observation-attempt',
    idempotencyKey: staleObservationKey,
    quoteToken: repositoryQuote(staleObservationKey),
    providerAvatarConsentObservation: await providerConsentObservation(Date.now() - 60_001),
  }), { statusCode: 409, failureCategory: 'CONSENT' });
  assert.equal(credit.reserved, 0, 'stale provider consent must fail before credit reservation');
  const reserved = await repo.reserveRender(standardRequest);
  assert.equal(reserved.job.provider, 'heygen');
  assert.equal(reserved.job.input.tier, 'STANDARD');
  assert.equal(reserved.job.input.renderAuthorization.tier, 'standard');
  assert.deepEqual(attachedReferences.map(ref => [ref.resourceId, ref.consumerId]), providerResources.map(resource => [resource.id, reserved.job.id]));
  assert.ok(lockOrder.indexOf('credit:update') < lockOrder.indexOf('identity:share'), 'scripted reservation must lock credit before identity/source rows');
  await repo.claimWorkflowStart(reserved.job.id);
  await repo.transitionJob({ jobId: reserved.job.id, stageTo: 'provider_submitting', eventType: 'test.claim', providerBinding });
  assert.equal(jobs[0].status, 'provider_submitting');
  assert.ok(lockOrder.indexOf('identity:share') < lockOrder.indexOf('consent:share'));
  await assert.rejects(repo.transitionJob({ jobId: reserved.job.id, stageTo: 'provider_submitting', eventType: 'test.concurrent_loser', providerBinding }), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await repo.markJobFailedAndRelease(reserved.job.id, 'RECONCILIATION', 'stale loser must not release', undefined, { expectedStatuses: ['workflow_started'] });
  assert.equal(jobs[0].status, 'provider_submitting');

  jobs[0].status = 'workflow_started';
  photo.sha256 = 'c'.repeat(64);
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.changed_source', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  photo.sha256 = consent.photoSha256;
  photo.quarantinedAt = new Date();
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.quarantined_source', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  photo.quarantinedAt = null;
  photo.kind = 'customer-upload';
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.invalid_source_kind', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  photo.kind = 'identity-photo-source';
  identity.providerVoiceId = 'changed-provider-voice';
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.changed_resource', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  identity.providerVoiceId = 'heygen-voice';
  identity.providerAvatarGroupId = 'changed-provider-avatar-group';
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.changed_avatar_group', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  identity.providerAvatarGroupId = 'heygen-avatar-group';

  for (const input of [
    { ...context.input, script: 'changed' },
    { ...context.input, identityId: randomUUID() },
    { ...context.input, projectId: randomUUID() },
    { ...context.input, tier: 'PREMIUM' },
  ]) {
    await assert.rejects(repo.reserveRender({ ...standardRequest, input, tier: input.tier === 'PREMIUM' ? 'premium' : 'standard' }), { statusCode: 409 });
  }

  consent.revokedAt = new Date();
  const updatesBefore = jobs[0].updatedAt;
  await assert.rejects(repo.transitionJob({ jobId: jobs[0].id, stageTo: 'provider_submitting', eventType: 'test.revoked', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal(jobs[0].status, 'workflow_started');
  assert.equal(jobs[0].updatedAt, updatesBefore);
  grants = [];
} else if (scenario === 'workflow') {
  const providerBindings = new WeakSet();
  let bindingFailure;
  let bindingAssertFailure;
  let malformedClaimProof = false;
  let canonicalClaimInput;
  let bindingResolutions = 0;
  let activationEnabled = true;
  let readyUrlDigest = null;
  let pollResult = { ready: false, status: 'processing' };
  let pollFailure;
  let pollCalls = 0;
  mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
    resolveFreshHeygenSpaceBinding: async () => {
      if (bindingFailure) throw bindingFailure;
      bindingResolutions++;
      const binding = Object.freeze({
        fixture: 'scripted-workflow-space-binding',
        applicationAccountId: accountId,
        bindingId: 'fixture-binding-id',
        originScopeKey: 'a'.repeat(64),
      });
      providerBindings.add(binding);
      return binding;
    },
    assertFreshHeygenSpaceBinding: binding => {
      assert.equal(providerBindings.has(binding), true);
      if (bindingAssertFailure) throw bindingAssertFailure;
      return binding;
    },
    assertFreshHeygenProviderClaimTx: (_tx, { providerBinding }) => {
      assert.equal(providerBindings.has(providerBinding), true);
      return providerBinding;
    },
    assertHeygenProviderReceiptTx: (_tx, { providerBinding }) => {
      assert.equal(providerBindings.has(providerBinding), true);
      return providerBinding;
    },
    withFreshHeygenSpaceBindingTransaction: async (_input, callback) => callback({}),
    withHeygenSpaceBindingReceiptTransaction: async (_input, callback) => callback({}),
  } });
  const providerLedger = await import('../../db/provider-reconciliation-repository.js');
  mock.module('../../db/provider-reconciliation-repository.js', { namedExports: {
    ...providerLedger,
    providerCreationActivationStatus: () => Object.freeze({ enabled: activationEnabled, reason: activationEnabled ? 'test_fixture_only' : 'verified_binding_not_activated' }),
  } });
  const repo = await import('../../db/repositories.js');
  const jobId = 'scripted-workflow-job';
  let job = {
    id: jobId, accountId, provider: 'heygen', status: 'workflow_started', costCredits: 37, title, format: 'vertical',
    input: {
      contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION,
      tier: 'STANDARD',
      identityId,
      script,
      avatar: { avatarId: 'heygen-avatar' },
      voice: { voiceId: 'heygen-voice' },
      sourceBinding: { provider: 'heygen', providerAvatarGroupId: 'heygen-avatar-group', providerRenderableAvatarId: 'heygen-avatar', providerVoiceId: 'heygen-voice' },
      renderAuthorization: authority('standard', jobId),
    },
  };
  let providerCalls = 0;
  let unknownTransitions = 0;
  let claimFailure;
  let providerFailure;
  let unknownPersistenceFailure = false;
  let loadFailure;
  let releases = 0;
  let avatarConsentStatus = 'accepted';
  const releasedMessages = [];
  mock.module('../../db/repositories.js', { namedExports: {
    ...repo,
    getJob: async () => { if (loadFailure) throw loadFailure; return job; },
    prepareIdentityProviderRead: async ({ accountId: requestedAccountId, identityId: requestedIdentityId, component, providerBinding }) => {
      assert.equal(requestedAccountId, accountId); assert.equal(requestedIdentityId, identityId); assert.equal(component, 'avatar');
      assert.equal(providerBindings.has(providerBinding), true);
      return Object.freeze({
        version: 'heygen-identity-read-claim/v1', accountId, identityId, component,
        providerAvatarGroupId: 'heygen-avatar-group', providerRenderableAvatarId: 'heygen-avatar', providerVoiceId: null,
        resourceIds: Object.freeze(['fixture-group-resource', 'fixture-look-resource']),
      });
    },
    prepareProviderVideoRead: async ({ jobId: requestedJobId, providerJobId, providerBinding }) => {
      assert.equal(requestedJobId, jobId);
      assert.equal(providerBindings.has(providerBinding), true);
      if (providerJobId && providerJobId !== job.providerJobId) throw Object.assign(new Error('provider job mismatch'), { failureCategory: 'PROVIDER_OPERATION_CONFLICT' });
      return Object.freeze({
        version: 'heygen-video-read-claim/v1',
        job: Object.freeze({ ...job }),
        providerJobId: job.providerJobId,
        operationId: 'fixture-video-operation',
        resourceId: 'fixture-video-resource',
        sourceUrlDigest: ['provider_ready', 'finishing'].includes(job.status) ? readyUrlDigest : null,
      });
    },
    prepareProviderVideoFinish: async ({ jobId: requestedJobId, providerBinding }) => {
      assert.equal(requestedJobId, jobId);
      assert.equal(providerBindings.has(providerBinding), true);
      if (!['provider_ready', 'finishing'].includes(job.status) || !readyUrlDigest) throw Object.assign(new Error('not ready'), { failureCategory: 'PROVIDER_RESOURCE_CONFLICT' });
      return Object.freeze({
        version: 'heygen-video-read-claim/v1',
        job: Object.freeze({ ...job }),
        providerJobId: job.providerJobId,
        operationId: 'fixture-video-operation',
        resourceId: 'fixture-video-resource',
        sourceUrlDigest: readyUrlDigest,
      });
    },
    requireJobRenderAuthorization: async (_job, tier) => { assert.equal(tier, 'standard'); },
    transitionJob: async ({ stageTo, providerJobId, providerBinding, providerSourceUrlDigest }) => {
      if (['provider_submitting', 'provider_submitted', 'provider_submit_unknown', 'provider_rendering', 'provider_ready', 'finishing', 'finish_contained'].includes(stageTo)) {
        assert.equal(providerBindings.has(providerBinding), true, `${stageTo} must retain the resolved provider binding`);
      }
      if (stageTo === 'provider_ready') {
        assert.match(providerSourceUrlDigest, /^[a-f0-9]{64}$/);
        readyUrlDigest = providerSourceUrlDigest;
      }
      if (stageTo === 'provider_submit_unknown') unknownTransitions++;
      if (stageTo === 'provider_submitting' && claimFailure) {
        if (claimFailure.providerSubmissionPossible) job = { ...job, status: 'provider_submitting' };
        throw claimFailure;
      }
      if (stageTo === 'provider_submit_unknown' && unknownPersistenceFailure) throw new Error('unknown-state persistence failed');
      job = { ...job, status: stageTo, ...(providerJobId ? { providerJobId } : {}) };
      if (stageTo === 'provider_submitting') {
        if (malformedClaimProof) return Object.freeze({ ...job });
        return Object.freeze({
          ...job,
          input: canonicalClaimInput || job.input,
          providerClaimProof: Object.freeze({
            version: 'heygen-render-provider-claim/v1',
            operationId: 'fixture-video-operation',
            operationState: 'pending',
            requestDigest: 'b'.repeat(64),
            bindingId: providerBinding.bindingId,
            originScopeKey: providerBinding.originScopeKey,
            accountId,
            jobId,
          }),
        });
      }
      return job;
    },
    markJobFailedAndRelease: async (_jobId, category, message, _artifact, options) => {
      if (options?.protectedStatuses?.includes(job.status)) return job;
      if (options?.expectedStatuses && !options.expectedStatuses.includes(job.status)) return job;
      releases++;
      releasedMessages.push(message);
      assert.doesNotMatch(message, /VIDEO_OS_.*PRECLAIM/);
      job = { ...job, status: 'failed', failureCategory: category };
      return job;
    },
  } });
  const heygen = await import('../../services/heygen.js');
  const submittedJobs = [];
  mock.module('../../services/heygen.js', { namedExports: {
    ...heygen,
    getHeygenPhotoAvatarStatus: async ({ groupId, lookId }) => {
      assert.equal(groupId, 'heygen-avatar-group'); assert.equal(lookId, 'heygen-avatar');
      return {
        ready: avatarConsentStatus === 'accepted', failed: false,
        avatarGroup: { providerGroupId: groupId, status: 'completed', consentStatus: avatarConsentStatus, ready: true },
        avatarLook: { providerLookId: lookId, providerGroupId: groupId, avatarType: 'photo_avatar', status: 'completed', ready: true },
      };
    },
    submitHeygen: async candidate => { submittedJobs.push(candidate); providerCalls++; if (providerFailure) throw providerFailure; return { providerJobId: 'heygen-scripted-job' }; },
    pollHeygen: async () => { pollCalls++; if (pollFailure) throw pollFailure; return pollResult; },
  } });
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  process.env.HEYGEN_API_KEY = 'unit-test-provider-key';
  delete process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED;
  const { failWorkflow, finishProviderMedia, pollProvider, submitProvider } = await import('../../workflows/video-render.js');
  canonicalClaimInput = { ...job.input, script: 'Canonical locked script from the provider claim.' };
  await submitProvider(jobId);
  assert.equal(providerCalls, 1);
  assert.strictEqual(submittedJobs[0].input, canonicalClaimInput, 'provider must receive the canonical job returned by the locked claim');
  canonicalClaimInput = undefined;

  const submittedJob = job;
  avatarConsentStatus = 'pending';
  job = { ...job, status: 'workflow_started', providerJobId: null };
  const pendingConsentDenial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(pendingConsentDenial), { kind: 'heygen-preclaim', failureCategory: 'CONSENT' });
  assert.equal(providerCalls, 1, 'pending provider consent must fail before submission');
  avatarConsentStatus = 'accepted';
  job = submittedJob;

  let pollDenial = await pollProvider(jobId, 'wrong-provider-job').then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(pollDenial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  assert.equal(pollCalls, 0, 'serialized provider ID mismatch must fail before HeyGen GET');
  for (const failure of [
    new TypeError('network disconnected'),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('rate limited'), { failureCategory: 'PROVIDER_POLL', providerHttpStatus: 429 }),
    Object.assign(new Error('provider unavailable'), { failureCategory: 'PROVIDER_POLL', providerHttpStatus: 503 }),
    Object.assign(new Error('invalid response body'), { failureCategory: 'PROVIDER_POLL' }),
  ]) {
    pollFailure = failure;
    const releasesBeforePollFailure = releases;
    const submitsBeforePollFailure = providerCalls;
    pollDenial = await pollProvider(jobId, 'heygen-scripted-job').then(() => null, error => error);
    assert.deepEqual(parseDurableRenderFailure(pollDenial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
    await failWorkflow(jobId, new FatalError(pollDenial.message));
    assert.equal(releases, releasesBeforePollFailure, 'uncertain provider poll cannot release credits');
    assert.equal(providerCalls, submitsBeforePollFailure, 'uncertain provider poll cannot resubmit');
  }
  pollFailure = undefined;
  const sourceUrl = 'https://files.heygen.com/private-fixture-video.mp4';
  pollResult = { ready: true, status: 'completed', sourceUrl };
  const pollCallsBeforeReady = pollCalls;
  await pollProvider(jobId, 'heygen-scripted-job');
  assert.equal(pollCalls, pollCallsBeforeReady + 1);
  assert.equal(readyUrlDigest, createHash('sha256').update(sourceUrl).digest('hex'));
  const releasesBeforeWrongFinishUrl = releases;
  let finishDenial = await finishProviderMedia(jobId, 'https://files.heygen.com/different-video.mp4').then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(finishDenial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await failWorkflow(jobId, new FatalError(finishDenial.message));
  assert.equal(releases, releasesBeforeWrongFinishUrl, 'serialized finish URL mismatch cannot release credits');
  process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED = 'true';
  bindingAssertFailure = Object.assign(new Error('binding stale before download'), { code: 'HEYGEN_SPACE_BINDING_STALE' });
  const releasesBeforeStaleFinish = releases;
  finishDenial = await finishProviderMedia(jobId, sourceUrl).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(finishDenial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await failWorkflow(jobId, new FatalError(finishDenial.message));
  assert.equal(releases, releasesBeforeStaleFinish, 'stale pre-download binding cannot release credits');
  bindingAssertFailure = undefined;
  delete process.env.VIDEO_OS_HOSTED_FINISHING_ENABLED;
  await finishProviderMedia(jobId, sourceUrl);
  assert.equal(job.status, 'finish_contained');
  job = { ...job, status: 'workflow_started', providerJobId: null };
  readyUrlDigest = null;

  const resolutionsBeforeActivationHold = bindingResolutions;
  job = { ...job, status: 'workflow_started', providerJobId: null };
  activationEnabled = false;
  let denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'CONFIG_MISSING' });
  assert.equal(providerCalls, 1);
  assert.equal(bindingResolutions, resolutionsBeforeActivationHold, 'verified binding does not imply provider activation');
  activationEnabled = true;

  const registeredInput = job.input;
  const resolutionsBeforeLegacyHold = bindingResolutions;
  job = { ...job, status: 'workflow_started', providerJobId: null, input: { ...job.input, identityId: undefined } };
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'RECONCILIATION' });
  assert.equal(providerCalls, 1);
  assert.equal(bindingResolutions, resolutionsBeforeLegacyHold, 'unregistered provider resources fail before binding resolution');
  job = { ...job, input: registeredInput };

  job = { ...job, status: 'workflow_started', providerJobId: null };
  bindingFailure = Object.assign(new Error('space binding unavailable'), { failureCategory: 'RECONCILIATION' });
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'RECONCILIATION' });
  assert.equal(job.status, 'workflow_started');
  assert.equal(providerCalls, 1);
  assert.equal(unknownTransitions, 0);
  bindingFailure = undefined;

  for (const message of ['revoked consent', 'source fingerprint mismatch']) {
    job = { ...job, status: 'workflow_started', providerJobId: null };
    claimFailure = Object.assign(new Error(message), { statusCode: 409, failureCategory: 'CONSENT' });
    const denial = await submitProvider(jobId).then(() => null, error => error);
    assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'CONSENT' });
    await failWorkflow(jobId, new FatalError(denial.message));
    assert.equal(providerCalls, 1);
    assert.equal(unknownTransitions, 0);
    assert.equal(releases > 0, true);
  }
  claimFailure = undefined;
  job = { ...job, status: 'workflow_started', providerJobId: null };
  delete process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED;
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'CONFIG_MISSING' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(providerCalls, 1);
  assert.equal(unknownTransitions, 0);
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  job = { ...job, status: 'workflow_started' };
  delete process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS;
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'CONFIG_MISSING' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(providerCalls, 1);
  assert.equal(unknownTransitions, 0);
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';

  job = { ...job, status: 'workflow_started' };
  delete process.env.HEYGEN_API_KEY;
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'CONFIG_MISSING' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(providerCalls, 1);
  process.env.HEYGEN_API_KEY = 'unit-test-provider-key';

  job = { ...job, status: 'workflow_started', input: { ...job.input, avatar: undefined } };
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'VALIDATION' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(providerCalls, 1);
  job = { ...job, status: 'workflow_started', input: { ...job.input, avatar: { avatarId: 'heygen-avatar' } } };

  const releasesBeforeConcurrentLoser = releases;
  claimFailure = Object.assign(new Error('another runner claimed submission'), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerSubmissionPossible: true });
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(job.status, 'provider_submitting');
  assert.equal(releases, releasesBeforeConcurrentLoser);
  assert.equal(providerCalls, 1);

  claimFailure = undefined;
  job = { ...job, status: 'workflow_started', providerJobId: null };
  providerFailure = new Error('connection reset after possible provider acceptance');
  unknownPersistenceFailure = true;
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(releases, releasesBeforeConcurrentLoser);
  assert.equal(providerCalls, 2);
  assert.equal(unknownTransitions, 1);

  const releasesBeforeLoadFailure = releases;
  const providerCallsBeforeLoadFailure = providerCalls;
  loadFailure = new Error('database read failed while another runner held the provider claim');
  job = { ...job, status: 'provider_submitting', providerJobId: null };
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'heygen-preclaim', failureCategory: 'RECONCILIATION' });
  await failWorkflow(jobId, new FatalError(denial.message));
  assert.equal(releases, releasesBeforeLoadFailure);
  assert.equal(providerCalls, providerCallsBeforeLoadFailure);

  loadFailure = undefined;
  for (const protectedStatus of ['provider_submitting', 'provider_submit_unknown']) {
    job = { ...job, status: protectedStatus };
    const releasesBeforeInfrastructureFailure = releases;
    await failWorkflow(jobId, new Error('workflow runtime failed without a typed application error'));
    assert.equal(job.status, protectedStatus);
    assert.equal(releases, releasesBeforeInfrastructureFailure);
  }
  job = { ...job, status: 'workflow_started' };

  const unknownBeforeMalformedClaim = unknownTransitions;
  const callsBeforeMalformedClaim = providerCalls;
  malformedClaimProof = true;
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  assert.equal(providerCalls, callsBeforeMalformedClaim, 'malformed canonical claim cannot reach provider HTTP');
  assert.equal(unknownTransitions, unknownBeforeMalformedClaim + 1);
  malformedClaimProof = false;
  job = { ...job, status: 'workflow_started', providerJobId: null };

  const unknownBeforeStaleBinding = unknownTransitions;
  const callsBeforeStaleBinding = providerCalls;
  bindingAssertFailure = Object.assign(new Error('space binding expired after claim'), { code: 'HEYGEN_SPACE_BINDING_STALE' });
  denial = await submitProvider(jobId).then(() => null, error => error);
  assert.deepEqual(parseDurableRenderFailure(denial), { kind: 'provider-submission-possible', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  assert.equal(providerCalls, callsBeforeStaleBinding, 'freshness failure before HTTP cannot submit');
  assert.equal(unknownTransitions, unknownBeforeStaleBinding + 1, 'claimed freshness failure is durably held as unknown');
  bindingAssertFailure = undefined;
  job = { ...job, status: 'workflow_started', providerJobId: null };
  const releasesBeforeUnclaimedFailure = releases;
  await failWorkflow(jobId, new Error('workflow runtime failed before provider claim'));
  assert.equal(releases, releasesBeforeUnclaimedFailure + 1);
} else if (scenario === 'route') {
  const routeProviderBinding = { applicationAccountId: accountId, bindingId: 'route-binding', originScopeKey: '7'.repeat(64), verifiedAccountScopeId: 'route-verified-account' };
  let routeConsentStatus = 'accepted';
  let routeReadGroupId = 'heygen-avatar-group';
  let routeReadFailure;
  let forceStaleObservation = false;
  const bindingRepository = await import('../../db/heygen-space-binding-repository.js');
  mock.module('../../db/heygen-space-binding-repository.js', { namedExports: {
    ...bindingRepository,
    resolveFreshHeygenSpaceBinding: async ({ accountId: requestedAccountId }) => {
      assert.equal(requestedAccountId, accountId);
      return routeProviderBinding;
    },
  } });
  const heygen = await import('../../services/heygen.js');
  mock.module('../../services/heygen.js', { namedExports: {
    ...heygen,
    getHeygenPhotoAvatarStatus: async ({ groupId, lookId }) => {
      if (routeReadFailure) throw routeReadFailure;
      return {
        ready: routeConsentStatus === 'accepted',
        avatarGroup: { providerGroupId: groupId, status: 'completed', consentStatus: routeConsentStatus, ready: true },
        avatarLook: { providerLookId: lookId, providerGroupId: groupId, avatarType: 'photo_avatar', status: 'completed', ready: true },
      };
    },
  } });
  const repo = await import('../../db/repositories.js');
  const input = {
    contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', projectId, identityId, script,
    avatar: { avatarId: 'heygen-avatar' }, voice: { voiceId: 'heygen-voice' },
    sourceBinding: { consentId, provider: 'heygen', providerAvatarGroupId: 'heygen-avatar-group', providerRenderableAvatarId: 'heygen-avatar', providerVoiceId: 'heygen-voice' },
  };
  const resolvedProject = { id: projectId, accountId, identityId, title, script, settings: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', format: 'vertical' } };
  let captured;
  let authorizedTier;
  let routeClaimFailure = false;
  let persistedRouteStatus = 'reserved';
  let routeReleases = 0;
  let reserveCalls = 0;
  let recoveredRouteJob = null;
  let lastReservedJob = null;
  mock.module('../../db/repositories.js', { namedExports: {
    ...repo,
    consumeRateLimit: async () => true,
    getOwnedScriptedPhotoJobByIdempotency: async request => {
      if (!recoveredRouteJob) return null;
      if (request.identityId !== identityId || request.title !== title || request.script !== script || request.format !== 'vertical') {
        throw Object.assign(new Error('Idempotency key belongs to a different render request.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      return recoveredRouteJob;
    },
    requirePersistedRenderAuthorization: async (_accountId, tier) => { authorizedTier = tier; if (tier !== 'standard') throw Object.assign(new Error('Tier denied'), { statusCode: 403, failureCategory: 'ENTITLEMENT' }); return authority(tier, 'pending'); },
    getScriptedPhotoReservationContext: async () => ({ input, project: resolvedProject }),
    prepareIdentityProviderRead: async ({ accountId: requestedAccountId, identityId: requestedIdentityId, component, providerBinding }) => {
      assert.equal(requestedAccountId, accountId); assert.equal(requestedIdentityId, identityId); assert.equal(component, 'avatar'); assert.equal(providerBinding, routeProviderBinding);
      return { accountId, identityId, component, providerAvatarGroupId: routeReadGroupId, providerRenderableAvatarId: 'heygen-avatar' };
    },
    ensureAccount: async () => ({ user: { id: accountId, name: 'Owner', role: 'customer' }, credits: { balance: 500, reserved: 37 }, entitlements: { standardRendering: true } }),
    reserveRender: async request => {
      if (request.input?.projectId !== projectId || request.input?.identityId !== identityId || request.input?.script !== script
        || request.input?.tier !== 'STANDARD' || resolvedProject.settings.format !== request.format) {
        throw Object.assign(new Error('Atomic scripted-photo intent changed.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
      }
      assertFreshProviderAvatarConsentObservation(request.providerAvatarConsentObservation, {
        accountId,
        identityId,
        sourceBinding: input.sourceBinding,
        ...(forceStaleObservation ? { now: request.providerAvatarConsentObservation.observedAt + 60_001 } : {}),
      });
      const claims = verifyScriptedPhotoQuote(request.quoteToken, {
        accountId,
        projectId,
        identityId,
        idempotencyKey: request.idempotencyKey,
        title: request.title,
        script: request.input.script,
        format: request.format,
        tier: request.input.tier,
        sourceBinding: input.sourceBinding,
        credits: request.costCredits,
      });
      const persistedInput = { ...input, quoteProof: safeScriptedPhotoQuoteProof(claims) };
      reserveCalls++;
      captured = { ...request, input: persistedInput };
      persistedRouteStatus = 'reserved';
      const job = { id: request.jobId, accountId, projectId, provider: 'heygen', status: 'reserved', costCredits: request.costCredits, title: request.title, format: request.format, correlationId: request.correlationId, input: { ...persistedInput, renderAuthorization: authority('standard', request.jobId) } };
      lastReservedJob = job;
      return { job, replayed: false };
    },
    claimWorkflowStart: async id => {
      persistedRouteStatus = 'workflow_started';
      if (routeClaimFailure) throw new Error('claim response was lost after another request advanced the job');
      return { id, accountId, projectId, provider: 'heygen', status: 'workflow_started', costCredits: 37, title, format: 'vertical', correlationId: 'route-correlation', input: { ...input, renderAuthorization: authority('standard', id) } };
    },
    markJobFailedAndRelease: async (_id, _category, _message, _artifact, options) => {
      if (!options?.expectedStatuses || options.expectedStatuses.includes(persistedRouteStatus)) routeReleases++;
    },
  } });
  const account = await import('../../lib/video-os-account.js');
  process.env.VIDEO_OS_SESSION_SECRET = 'scripted-route-test-session-secret-32';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://video.example';
  process.env.VIDEO_OS_DURABLE_WORKFLOW_ENABLED = 'true';
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  process.env.WORKFLOW_DISPATCH_MODE = 'poll';
  const { issueScriptedPhotoQuote } = await import('../../lib/scripted-photo-quote.js');
  const { default: handler } = await import('../../api/video-os-lite/render-v2.js');
  const cookie = `vos_session=${account.makeSession(accountId, 'owner@example.test')}`;
  const baseIdempotencyKey = randomUUID();
  const quoteBinding = { accountId, projectId, identityId, idempotencyKey: baseIdempotencyKey, title, script, format: 'vertical', tier: 'STANDARD', sourceBinding: input.sourceBinding, credits: 37 };
  const quoteToken = issueScriptedPhotoQuote(quoteBinding).token;
  const base = { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', projectId, identityId, idempotencyKey: baseIdempotencyKey, quoteToken, title, script, format: 'vertical' };
  async function call(body, headers = {}) {
    const req = { method: 'POST', headers: { cookie, origin: 'https://video.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
    const res = { setHeader() {}, end(raw) { this.body = JSON.parse(raw); } };
    await handler(req, res);
    return res;
  }
  routeConsentStatus = 'pending';
  assert.equal((await call(base)).statusCode, 409);
  assert.equal(reserveCalls, 0);
  routeConsentStatus = 'accepted';
  routeReadGroupId = 'different-avatar-group';
  assert.equal((await call(base)).statusCode, 409);
  assert.equal(reserveCalls, 0);
  routeReadGroupId = 'heygen-avatar-group';
  routeReadFailure = new TypeError('provider readback unavailable');
  assert.equal((await call(base)).statusCode, 503);
  assert.equal(reserveCalls, 0);
  routeReadFailure = undefined;
  forceStaleObservation = true;
  assert.equal((await call(base)).statusCode, 409);
  assert.equal(reserveCalls, 0);
  forceStaleObservation = false;
  const accepted = await call(base);
  assert.equal(accepted.statusCode, 202, JSON.stringify(accepted.body));
  assert.equal(authorizedTier, 'standard');
  assert.equal(captured.provider, 'heygen');
  assert.equal(captured.tier, 'standard');
  assert.equal(captured.costCredits, 37);
  assert.equal(captured.input.productionKit, undefined);
  const reserveCallsBeforeInvalidQuotes = reserveCalls;
  const missingQuote = await call({ ...base, quoteToken: undefined });
  assert.equal(missingQuote.statusCode, 400);
  assert.equal(missingQuote.body.code, 'invalid_request');
  const tamperedQuote = `${quoteToken.slice(0, -1)}${quoteToken.endsWith('a') ? 'b' : 'a'}`;
  assert.equal((await call({ ...base, quoteToken: tamperedQuote })).statusCode, 400);
  const expiredQuote = issueScriptedPhotoQuote(quoteBinding, { now: Date.now() - 10 * 60 * 1000 }).token;
  assert.equal((await call({ ...base, quoteToken: expiredQuote })).statusCode, 410);
  assert.equal((await call({ ...base, title: `${title} changed` })).statusCode, 409);
  assert.equal((await call({ ...base, idempotencyKey: randomUUID() })).statusCode, 409);
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '38';
  assert.equal((await call(base)).statusCode, 409);
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  const originalConsentId = input.sourceBinding.consentId;
  input.sourceBinding.consentId = randomUUID();
  assert.equal((await call(base)).statusCode, 409);
  input.sourceBinding.consentId = originalConsentId;
  resolvedProject.settings.format = 'landscape';
  assert.equal((await call(base)).statusCode, 409);
  resolvedProject.settings.format = 'vertical';
  assert.equal(reserveCalls, reserveCallsBeforeInvalidQuotes, 'invalid or expired quotes must fail before reservation');
  recoveredRouteJob = lastReservedJob;
  delete process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED;
  const changedRecovery = await call({ ...base, title: `${title} changed`, quoteToken: expiredQuote });
  assert.equal(changedRecovery.statusCode, 409);
  const recoveredExpired = await call({ ...base, quoteToken: expiredQuote });
  assert.equal(recoveredExpired.statusCode, 202);
  assert.equal(recoveredExpired.body.status, 'workflow_started');
  assert.equal(reserveCalls, reserveCallsBeforeInvalidQuotes, 'same-key recovery must not reserve again');
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  recoveredRouteJob = null;
  routeClaimFailure = true;
  assert.equal((await call(base)).statusCode, 400);
  assert.equal(persistedRouteStatus, 'workflow_started');
  assert.equal(routeReleases, 0, 'a stale HTTP loser must not release a reservation already claimed by another request');
  routeClaimFailure = false;
  assert.equal((await call({ ...base, provider: 'heygen' })).statusCode, 400);
  assert.equal((await call({ ...base, contractVersion: 'scripted-photo-v2' })).statusCode, 400);
  assert.equal((await call({ ...base, contractVersion: undefined, sourceBinding: { consentId } })).statusCode, 400);
  assert.equal((await call(base, { origin: 'https://other.example' })).statusCode, 403);
  delete process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS;
  assert.equal((await call(base)).statusCode, 503);
  delete process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED;
  assert.equal((await call(base)).statusCode, 503);
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}
