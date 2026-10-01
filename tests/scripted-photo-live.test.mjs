import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';

import { currentPoolForTests, database } from '../db/client.js';
import { creditAccounts, entitlements, identityConsents, identityVideoEnrollments, mediaAssets, projects, userIdentities } from '../db/schema.js';
import { claimWorkflowStart, ensureAccount, getJob, getOwnedScriptedPhotoJobByIdempotency, getScriptedPhotoReservationContext, markJobFailedAndRelease, reserveRender, transitionJob } from '../db/repositories.js';
import { attachProviderConsumerReferenceTx, markProviderResourceReadyTx, providerOperationRequestDigest, recordProviderOperationResourcesTx, reserveProviderOperationTx } from '../db/provider-reconciliation-repository.js';
import { createHeygenSpaceBindingRepository, withFreshHeygenSpaceBindingTransaction } from '../db/heygen-space-binding-repository.js';
import { ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_CONTRACT_VERSION } from '../lib/enrollment-policy.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION } from '../lib/scripted-photo-contract.js';
import { SCRIPTED_PHOTO_QUOTE_TTL_MS, issueScriptedPhotoQuote } from '../lib/scripted-photo-quote.js';
import { failWorkflow } from '../workflows/video-render.js';

const fixtureDigest = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

test('isolated live DB: Standard entitlement reserves HeyGen with Standard binding and consent revocation wins the provider claim', {
  skip: process.env.VIDEO_OS_ISOLATED_LIVE !== '1' && 'Run only through the guarded isolated-live runner.',
  timeout: 120000,
}, async t => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/mvp_verification_\d{8}$/);
  process.env.VIDEO_OS_SCRIPTED_PHOTO_ENABLED = 'true';
  process.env.VIDEO_OS_STANDARD_SCRIPTED_CREDITS = '37';
  process.env.VIDEO_OS_SESSION_SECRET = 'scripted-photo-live-quote-secret';
  const db = database();
  const pool = currentPoolForTests();
  const accountId = `scripted-live-${randomUUID()}`;
  const projectId = randomUUID();
  const identityId = randomUUID();
  const enrollmentId = randomUUID();
  const photoId = randomUUID();
  const voiceId = randomUUID();
  const sourceVideoId = randomUUID();
  const title = 'Isolated scripted-photo proof';
  const script = 'This is a synthetic database-only contract proof. No provider is called.';
  t.after(async () => {
    await pool?.end();
  });

  await ensureAccount({ accountId, email: null, name: 'Scripted Photo Isolated Test', initialCredits: 500 });
  await db.insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });
  await db.insert(mediaAssets).values([
    { id: photoId, accountId, kind: 'identity-photo-source', privatePathname: `video-os/uploads/${accountId}/photo`, contentType: 'image/png', bytes: 10, sha256: 'a'.repeat(64) },
    { id: voiceId, accountId, kind: 'identity-voice-source', privatePathname: `video-os/enrollment-sources/fixture/${enrollmentId}/voice.wav`, contentType: 'audio/wav', bytes: 10, sha256: 'b'.repeat(64) },
    { id: sourceVideoId, accountId, kind: 'identity-phone-video-source', privatePathname: `video-os/enrollment-sources/fixture/${enrollmentId}/source.mp4`, contentType: 'video/mp4', bytes: 10, sha256: 'c'.repeat(64) },
  ]);
  await db.insert(userIdentities).values({
    id: identityId,
    accountId,
    displayName: 'Scripted Identity',
    provider: 'heygen',
    overallStatus: 'READY',
    avatarStatus: 'READY',
    voiceStatus: 'READY',
    sourcePhotoAssetId: photoId,
    sourceVoiceAssetId: voiceId,
    providerAvatarGroupId: `group-${identityId}`,
    providerRenderableAvatarId: `avatar-${identityId}`,
    providerVoiceId: `voice-${identityId}`,
  });
  await db.insert(identityConsents).values({
    accountId,
    identityId,
    idempotencyKey: randomUUID(),
    audioExtractionAuthorization: true,
    faceAuthorization: true,
    voiceAuthorization: true,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
    policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
    consentPurpose: 'identity-voice-enrollment',
    photoSha256: 'a'.repeat(64),
    sourceVideoSha256: 'c'.repeat(64),
    voiceSha256: 'b'.repeat(64),
  });
  await db.insert(identityVideoEnrollments).values({
    id: enrollmentId, accountId, idempotencyKey: randomUUID(), correlationId: `corr-${enrollmentId}`,
    contractVersion: ENROLLMENT_CONTRACT_VERSION, status: 'IDENTITY_READY', stateVersion: 7,
    displayName: 'Scripted Identity', photoAssetId: photoId, photoSha256: 'a'.repeat(64),
    declaredFilename: 'source.mp4', declaredContentType: 'video/mp4', declaredBytes: 10,
    uploadPathname: `video-os/enrollment-sources/fixture/${enrollmentId}/source.mp4`, uploadEtag: 'fixture-etag',
    uploadOperationKey: randomUUID(), uploadExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 86_400_000),
    sourceSha256: 'c'.repeat(64), sourceBytes: 10, sourceMetadata: { fullDecode: true, mimeType: 'video/mp4' },
    sourceVideoAssetId: sourceVideoId, derivedVoiceAssetId: voiceId, derivedAudioSha256: 'b'.repeat(64),
    derivedAudioBytes: 10, derivedAudioDurationMs: 5_000, derivationVersion: 'fixture-v1', identityId,
    consentPolicyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, consentPurpose: 'identity-voice-enrollment',
    consentedSourceSha256: 'c'.repeat(64), consentIdempotencyKey: randomUUID(),
    consentAuthorizations: {
      audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
      providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
      temporaryPublicProviderExposureAuthorization: true,
    },
    consentedAt: new Date(), cleanupStatus: 'NOT_REQUIRED', completedAt: new Date(),
  });
  const fixtureNow = new Date();
  const fixtureCredential = `scripted-live-fixture-${accountId}`;
  const fixtureCredentialFingerprint = createHash('sha256')
    .update(Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8'))
    .update(fixtureCredential, 'utf8').digest('hex');
  const credentialScopeFingerprint = fixtureDigest(`credential:${accountId}`);
  const databaseBindingSha256 = fixtureDigest(`database:${accountId}`);
  const fixtureProof = Object.freeze({
    version: 'heygen-space-qualification-proof/v1', provider: 'heygen', providerNativeScopeType: 'space', globalAccountIdVerified: false,
    credentialKeyFingerprint: fixtureCredentialFingerprint, credentialScopeFingerprint,
    keyIdDigest: fixtureDigest(`key-id:${accountId}`), keyCreatedAt: fixtureNow.toISOString(), usernameDigest: fixtureDigest(`username:${accountId}`),
    providerSpaceFingerprint: fixtureDigest(`provider-space:${accountId}`), canonicalScopeKey: fixtureDigest(`canonical-scope:${accountId}`),
    preflightEvidenceSha256: fixtureDigest(`credential-evidence:${accountId}`), spaceProofSha256: fixtureDigest(`space-evidence:${accountId}`),
    identityDigest: fixtureDigest(`promotion-evidence:${accountId}`), evidenceRefVersion: 'heygen-space-anchor-evidence/v1',
    probeResultSha256: fixtureDigest(`probe:${accountId}`), spaceObservedAt: new Date(fixtureNow.getTime() - 1_000).toISOString(),
    qualifiedAt: fixtureNow.toISOString(), expiresAt: new Date(fixtureNow.getTime() + 60_000).toISOString(),
    anchorExpiresAt: new Date(fixtureNow.getTime() + 3_600_000).toISOString(),
  });
  const proofBrand = new WeakSet([fixtureProof]);
  const fixtureEnv = {
    VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification', DATABASE_URL: process.env.DATABASE_URL,
    ...(process.env.DATABASE_URL_UNPOOLED ? { DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED } : {}),
    HEYGEN_API_KEY: fixtureCredential,
  };
  const bindingRepository = createHeygenSpaceBindingRepository({
    env: () => fixtureEnv, now: () => fixtureNow, executor: db,
    targetPreflight: async () => ({
      environment: 'verification', projectId: 'lux-video-os-isolated', databaseBindingSha256,
      databaseUrl: fixtureEnv.DATABASE_URL, unpooledUrl: fixtureEnv.DATABASE_URL_UNPOOLED || null,
    }),
    loadVerifiedHeygenSpaceAnchor: async () => ({ credentialKeyFingerprint: fixtureCredentialFingerprint }),
    loadPinnedHeygenSpaceAnchorProjection: async () => ({ credentialKeyFingerprint: fixtureCredentialFingerprint }),
    qualifyHeygenCredential: async () => ({}), validateFreshHeygenQualification: () => fixtureProof,
    assertFreshHeygenSpaceProof: proof => { assert.equal(proofBrand.has(proof), true); return proof; },
    assertFreshHeygenBootstrapProof: proof => { assert.equal(proofBrand.has(proof), true); return proof; },
  });
  const providerBinding = await bindingRepository.bootstrapVerifiedHeygenSpaceBinding({
    accountId, privateEvidenceDir: process.platform === 'win32' ? 'C:\\scripted-live-fixture' : '/scripted-live-fixture',
  });
  const providerGroupId = `group-${identityId}`;
  const providerLookId = `avatar-${identityId}`;
  const providerVoiceId = `voice-${identityId}`;
  await withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
    const avatarOperation = await reserveProviderOperationTx(tx, {
      accountId, providerBinding, kind: 'avatar_create', originOperationKey: randomUUID(),
      correlationId: `avatar-${identityId}`, enrollmentId, identityId,
      requestDigest: providerOperationRequestDigest({ version: 'fixture/v1', kind: 'avatar_create', identityId }),
      sourceSha256: 'a'.repeat(64), sourceBytes: 10,
    });
    const avatarReceipt = await recordProviderOperationResourcesTx(tx, {
      accountId, operationId: avatarOperation.operation.id, resources: [
        { kind: 'avatar_group', providerResourceId: providerGroupId, state: 'processing', sourceSha256: 'a'.repeat(64), sourceBytes: 10 },
        { kind: 'avatar_look', providerResourceId: providerLookId, parentProviderResourceId: providerGroupId, state: 'processing', sourceSha256: 'a'.repeat(64), sourceBytes: 10 },
      ],
    });
    assert.deepEqual(avatarReceipt.conflicts, []);
    for (const resource of avatarReceipt.resources) {
      await markProviderResourceReadyTx(tx, { accountId, resourceId: resource.id });
      await attachProviderConsumerReferenceTx(tx, { accountId, resourceId: resource.id, consumerKind: 'identity', consumerId: identityId, originOperationId: avatarOperation.operation.id });
    }
    const voiceOperation = await reserveProviderOperationTx(tx, {
      accountId, providerBinding, kind: 'voice_clone', originOperationKey: randomUUID(),
      correlationId: `voice-${identityId}`, enrollmentId, identityId,
      requestDigest: providerOperationRequestDigest({ version: 'fixture/v1', kind: 'voice_clone', identityId }),
      sourceSha256: 'b'.repeat(64), sourceBytes: 10,
    });
    const voiceReceipt = await recordProviderOperationResourcesTx(tx, {
      accountId, operationId: voiceOperation.operation.id,
      resources: [{ kind: 'voice', providerResourceId: providerVoiceId, voiceNamespace: 'instant', state: 'processing', sourceSha256: 'b'.repeat(64), sourceBytes: 10 }],
    });
    assert.deepEqual(voiceReceipt.conflicts, []);
    await markProviderResourceReadyTx(tx, { accountId, resourceId: voiceReceipt.resources[0].id });
    await attachProviderConsumerReferenceTx(tx, { accountId, resourceId: voiceReceipt.resources[0].id, consumerKind: 'identity', consumerId: identityId, originOperationId: voiceOperation.operation.id });
  });
  await db.insert(projects).values({ id: projectId, accountId, identityId, title, script, avatar: {}, voice: {}, settings: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', format: 'vertical' } });

  const context = await getScriptedPhotoReservationContext({ accountId, projectId, identityId, title, script, tier: 'STANDARD' });
  const request = {
    accountId,
    correlationId: randomUUID(),
    provider: 'heygen',
    title,
    format: 'vertical',
    input: context.input,
  };
  const quoteFor = (idempotencyKey, tier = 'STANDARD', credits = 37, now = Date.now()) => issueScriptedPhotoQuote({
    accountId, projectId, identityId, idempotencyKey, title, script, format: 'vertical', tier,
    sourceBinding: context.input.sourceBinding, credits,
  }, { now }).token;
  const reserveStandard = (jobId, idempotencyKey, quoteNow = Date.now()) => reserveRender({ ...request, jobId, idempotencyKey, tier: 'standard', costCredits: 37, quoteToken: quoteFor(idempotencyKey, 'STANDARD', 37, quoteNow) });
  const premiumKey = randomUUID();
  await assert.rejects(reserveRender({ ...request, jobId: randomUUID(), idempotencyKey: premiumKey, tier: 'premium', costCredits: 90, input: { ...context.input, tier: 'PREMIUM' }, quoteToken: quoteFor(premiumKey, 'PREMIUM', 90) }), { statusCode: 409 });

  const delayedLockKey = randomUUID();
  const delayedLockJobId = randomUUID();
  const beforeDelay = {
    credit: (await pool.query('select balance, reserved, spent from credit_accounts where account_id=$1', [accountId])).rows[0],
    jobs: Number((await pool.query('select count(*) as n from video_jobs where account_id=$1', [accountId])).rows[0].n),
    transactions: Number((await pool.query('select count(*) as n from credit_transactions where account_id=$1', [accountId])).rows[0].n),
  };
  const creditLocker = await pool.connect();
  try {
    await creditLocker.query('begin');
    await creditLocker.query('select account_id from credit_accounts where account_id=$1 for update', [accountId]);
    const expiresAt = Date.now() + 800;
    const delayed = reserveStandard(delayedLockJobId, delayedLockKey, expiresAt - SCRIPTED_PHOTO_QUOTE_TTL_MS)
      .then(value => ({ value }), error => ({ error }));
    let waitingOnCredit = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await pool.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%credit_accounts%'");
      if (observed.rows[0].n > 0) { waitingOnCredit = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 100)));
    await creditLocker.query('rollback');
    const outcome = await delayed;
    assert.equal(waitingOnCredit, true, 'scripted reservation must visibly wait behind the real credit row lock');
    assert.equal(outcome.error?.statusCode, 410);
    assert.equal(outcome.value, undefined);
  } finally {
    await creditLocker.query('rollback').catch(() => {});
    creditLocker.release();
  }
  const afterDelay = {
    credit: (await pool.query('select balance, reserved, spent from credit_accounts where account_id=$1', [accountId])).rows[0],
    jobs: Number((await pool.query('select count(*) as n from video_jobs where account_id=$1', [accountId])).rows[0].n),
    transactions: Number((await pool.query('select count(*) as n from credit_transactions where account_id=$1', [accountId])).rows[0].n),
  };
  assert.deepEqual(afterDelay, beforeDelay, 'quote expiring behind the credit lock must not reserve, debit, or create a job');

  const acceptedKey = randomUUID();
  const raced = await Promise.all([
    reserveStandard(randomUUID(), acceptedKey),
    reserveStandard(randomUUID(), acceptedKey),
  ]);
  assert.equal(raced.filter(result => result.replayed === false).length, 1);
  assert.equal(raced.filter(result => result.replayed === true).length, 1);
  assert.equal(raced[0].job.id, raced[1].job.id);
  const accepted = raced.find(result => result.replayed === false);
  const acceptedId = accepted.job.id;
  assert.equal(accepted.job.provider, 'heygen');
  assert.equal(accepted.job.input.renderAuthorization.tier, 'standard');
  assert.ok(accepted.job.input.quoteProof);
  assert.equal(Object.hasOwn(accepted.job.input.quoteProof, 'nonce'), false);
  assert.equal(Object.hasOwn(accepted.job.input, 'quoteToken'), false);
  const expiredReplay = await reserveStandard(randomUUID(), acceptedKey, Date.now() - 10 * 60 * 1000);
  assert.equal(expiredReplay.replayed, true);
  assert.equal(expiredReplay.job.id, acceptedId);
  assert.equal((await getOwnedScriptedPhotoJobByIdempotency({ accountId, idempotencyKey: acceptedKey, projectId, tier: 'STANDARD' })).id, acceptedId);
  await assert.rejects(getOwnedScriptedPhotoJobByIdempotency({ accountId, idempotencyKey: acceptedKey, projectId, tier: 'PREMIUM' }), { statusCode: 409 });
  await assert.rejects(reserveStandard(randomUUID(), randomUUID(), Date.now() - 10 * 60 * 1000), { statusCode: 410 });
  const [creditsAfterAtomicChecks] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  assert.equal(creditsAfterAtomicChecks.reserved, 37, 'race, replay and expired new quote reserve exactly once');
  await claimWorkflowStart(acceptedId);
  const claimed = await transitionJob({ jobId: acceptedId, stageTo: 'provider_submitting', eventType: 'test.scripted_claim', providerBinding });
  assert.equal(claimed.status, 'provider_submitting');
  await assert.rejects(transitionJob({ jobId: acceptedId, stageTo: 'provider_submitting', eventType: 'test.concurrent_claim_loser', providerBinding }), { failureCategory: 'PROVIDER_SUBMIT_UNKNOWN' });
  await markJobFailedAndRelease(acceptedId, 'RECONCILIATION', 'Concurrent loser must not release winner credits.', undefined, { expectedStatuses: ['workflow_started'] });
  assert.equal((await getJob(acceptedId)).status, 'provider_submitting');
  await failWorkflow(acceptedId, new Error('synthetic workflow infrastructure failure'));
  assert.equal((await getJob(acceptedId)).status, 'provider_submitting');

  const unknownId = randomUUID();
  await reserveStandard(unknownId, randomUUID());
  await claimWorkflowStart(unknownId);
  await transitionJob({ jobId: unknownId, stageTo: 'provider_submitting', eventType: 'test.unknown_started', providerBinding });
  await transitionJob({ jobId: unknownId, stageTo: 'provider_submit_unknown', eventType: 'test.unknown_held', failureCategory: 'PROVIDER_SUBMIT_UNKNOWN', providerBinding });
  await failWorkflow(unknownId, new Error('synthetic workflow infrastructure failure'));
  assert.equal((await getJob(unknownId)).status, 'provider_submit_unknown');

  const quarantinedId = randomUUID();
  await reserveStandard(quarantinedId, randomUUID());
  await claimWorkflowStart(quarantinedId);
  await db.update(mediaAssets).set({ quarantinedAt: new Date() }).where(eq(mediaAssets.id, photoId));
  await assert.rejects(transitionJob({ jobId: quarantinedId, stageTo: 'provider_submitting', eventType: 'test.quarantined_claim', providerBinding }), { failureCategory: 'CONSENT' });
  assert.equal((await getJob(quarantinedId)).status, 'workflow_started');
  await markJobFailedAndRelease(quarantinedId, 'CONSENT', 'Isolated quarantined source proof', undefined, { expectedStatuses: ['workflow_started'] });
  await db.update(mediaAssets).set({ quarantinedAt: null }).where(eq(mediaAssets.id, photoId));

  const revokedId = randomUUID();
  await reserveStandard(revokedId, randomUUID());
  await claimWorkflowStart(revokedId);
  const revoker = await pool.connect();
  try {
    await revoker.query('begin');
    await revoker.query('select id from user_identities where id=$1 for update', [identityId]);
    await revoker.query('update identity_consents set revoked_at=now() where identity_id=$1 and revoked_at is null', [identityId]);
    await revoker.query("update user_identities set overall_status='ARCHIVED', archived_at=now() where id=$1", [identityId]);
    const claim = transitionJob({ jobId: revokedId, stageTo: 'provider_submitting', eventType: 'test.revoked_claim', providerBinding }).then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await pool.query("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%user_identities%'");
      if (observed.rows[0].n > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await revoker.query('commit');
    const outcome = await claim;
    assert.equal(waiting, true, 'claim must wait behind the identity revocation lock');
    assert.equal(outcome.error?.failureCategory, 'CONSENT');
    assert.equal((await getJob(revokedId)).status, 'workflow_started');
    const [credits] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
    assert.equal(credits.reserved, 111);
  } finally {
    await revoker.query('rollback').catch(() => {});
    revoker.release();
  }
});
