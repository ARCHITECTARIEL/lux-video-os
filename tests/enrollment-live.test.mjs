import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateClientTokenFromReadWriteToken, put as clientPut } from '@vercel/blob/client';
import { and, eq, isNull } from 'drizzle-orm';
import ffmpeg from 'ffmpeg-static';

import { currentPoolForTests, database } from '../db/client.js';
import {
  acceptEnrollmentUpload,
  assertEnrollmentProviderAllowed,
  authorizeEnrollmentUpload,
  claimEnrollmentProviderOperation,
  createEnrollment,
  expireEnrollment,
  getOwnedEnrollment,
  grantEnrollmentConsent,
  grantProviderBridgeReconsent,
  recordEnrollmentCleanup,
  revokeEnrollment,
} from '../db/enrollment-repository.js';
import { createIdentityDraft, ensureAccount, getOwnedIdentity, getOwnedMediaAsset, getRenderAuthorizedIdentity, getScriptedPhotoReservationContext, reserveIdentityComponentCreation } from '../db/repositories.js';
import { entitlements, identityConsents, identityVideoEnrollments, mediaAssets, projects, userIdentities, users } from '../db/schema.js';
import { ENROLLMENT_CONSENT_POLICY_VERSION, ENROLLMENT_CONTRACT_VERSION, ENROLLMENT_MEDIA_LIMITS, ENROLLMENT_STATUSES, LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION, assertEnrollmentPrivateReadback } from '../lib/enrollment-policy.js';
import { assertEnrollmentPrivateStoreReady } from '../lib/enrollment-private-store.js';
import { SCRIPTED_PHOTO_CONTRACT_VERSION } from '../lib/scripted-photo-contract.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../lib/video-os-private-blob.js';
import { cleanupEnrollmentStorage, extractEnrollmentIdentity, hashEnrollmentSource } from '../workflows/identity-enrollment.js';

test('isolated live DB/Blob: private multipart phone-video enrollment extracts real audio and revocation blocks reuse', {
  skip: process.env.VIDEO_OS_ISOLATED_LIVE !== '1' && 'Run only through the guarded isolated-live runner.',
  timeout: 180000,
}, async t => {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/mvp_verification_\d{8}$/);
  const token = String(process.env.BLOB_READ_WRITE_TOKEN || '');
  const storeId = /^vercel_blob_rw_([^_]+)_/i.exec(token)?.[1];
  assert.ok(storeId, 'Guarded runner must provide an exact private Blob token.');
  process.env.VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED = 'true';
  process.env.VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED = 'true';
  process.env.VIDEO_OS_ENROLLMENT_BLOB_STORE_ID = storeId;
  process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://isolated-enrollment.example';
  process.env.VIDEO_OS_SESSION_SECRET = 'isolated-enrollment-session-secret';
  process.env.STORAGE_DRIVER = 'blob';
  process.env.WORKFLOW_DISPATCH_MODE = 'vercel';
  await assertEnrollmentPrivateStoreReady();

  const db = database();
  const accountId = `enrollment-live-${randomUUID()}`;
  const photoAssetId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'enrollment-live-'));
  const sourceFile = join(directory, 'phone.mp4');
  const blobPaths = new Set();
  t.after(async () => {
    for (const pathname of blobPaths) {
      try {
        const stored = await getPrivateBlob(pathname);
        if (typeof stored?.stream?.destroy === 'function') stored.stream.destroy();
        else if (typeof stored?.stream?.cancel === 'function') await stored.stream.cancel().catch(() => {});
        if (stored?.blob?.etag) await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.IDENTITY_ENROLLMENT_SOURCE, pathname, { ifMatch: stored.blob.etag });
      } catch {}
    }
    await db.delete(users).where(eq(users.id, accountId));
    await rm(directory, { recursive: true, force: true });
    await currentPoolForTests()?.end();
  });

  const encoded = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5:duration=5.2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5.2',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', sourceFile,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  assert.equal(encoded.status, 0, encoded.stderr);
  const sourceBytes = await readFile(sourceFile);
  assert.ok(sourceBytes.length < ENROLLMENT_MEDIA_LIMITS.maxSourceBytes);

  await ensureAccount({ accountId, email: null, name: 'Enrollment Live Test', initialCredits: 500 });
  await db.insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });
  await db.insert(mediaAssets).values({
    id: photoAssetId, accountId, kind: 'identity-photo-source', privatePathname: `video-os/uploads/${accountId}/photo.png`,
    contentType: 'image/png', bytes: 100, sha256: 'a'.repeat(64), widthPx: 720, heightPx: 1280,
  });
  const created = await createEnrollment({ accountId, correlationId: randomUUID(), input: {
    action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey: randomUUID(), displayName: 'Live Identity',
    photoAssetId, filename: 'phone.mp4', contentType: 'video/mp4', bytes: sourceBytes.length,
  } });
  assert.equal(created.enrollment.photoSha256, 'a'.repeat(64));
  await authorizeEnrollmentUpload({ accountId, enrollmentId: created.enrollment.id, operationKey: created.enrollment.uploadOperationKey, pathname: created.enrollment.uploadPathname });
  const clientToken = await generateClientTokenFromReadWriteToken({
    token, pathname: created.enrollment.uploadPathname, allowedContentTypes: ['video/mp4'], maximumSizeInBytes: sourceBytes.length,
    validUntil: new Date(created.enrollment.uploadExpiresAt).getTime(), addRandomSuffix: false, allowOverwrite: false,
  });
  const uploadedBlob = await clientPut(created.enrollment.uploadPathname, sourceBytes, {
    access: 'private', token: clientToken, contentType: 'video/mp4', multipart: true,
  });
  blobPaths.add(created.enrollment.uploadPathname);
  assert.equal(uploadedBlob.pathname, created.enrollment.uploadPathname);
  const anonymous = await fetch(uploadedBlob.url, { redirect: 'manual' });
  assert.ok([401, 403, 404].includes(anonymous.status));
  await anonymous.body?.cancel().catch(() => {});
  const privateReadback = await getPrivateBlob(created.enrollment.uploadPathname);
  assertEnrollmentPrivateReadback(privateReadback, { ...created.enrollment, uploadEtag: uploadedBlob.etag }, storeId);

  const uploaded = await acceptEnrollmentUpload({
    enrollmentId: created.enrollment.id, operationKey: created.enrollment.uploadOperationKey,
    pathname: created.enrollment.uploadPathname, etag: uploadedBlob.etag, contentType: uploadedBlob.contentType,
  });
  const hashed = await hashEnrollmentSource(created.enrollment.id, uploaded.enrollment.workflowOperationKey);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  assert.equal(hashed.sourceSha256, sourceSha256);
  assert.equal(hashed.sourceBytes, sourceBytes.length);

  const consent = await grantEnrollmentConsent({ accountId, input: {
    action: 'consent', contractVersion: ENROLLMENT_CONTRACT_VERSION, enrollmentId: created.enrollment.id,
    expectedStateVersion: hashed.stateVersion, idempotencyKey: randomUUID(), policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION,
    purpose: 'identity-voice-enrollment', sourceVideoSha256: sourceSha256,
    audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
    providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  } });
  const finalized = await extractEnrollmentIdentity(created.enrollment.id, consent.enrollment.workflowOperationKey);
  assert.equal(finalized.enrollment.status, 'IDENTITY_READY');
  assert.equal(finalized.enrollment.sourceSha256, sourceSha256);
  assert.match(finalized.enrollment.derivedAudioSha256, /^[a-f0-9]{64}$/);
  const derived = await getOwnedMediaAsset(accountId, finalized.enrollment.derivedVoiceAssetId);
  blobPaths.add(derived.privatePathname);
  const derivedStored = await getPrivateBlob(derived.privatePathname);
  assert.ok(derivedStored?.stream);
  if (typeof derivedStored.stream.destroy === 'function') derivedStored.stream.destroy();
  else if (typeof derivedStored.stream.cancel === 'function') await derivedStored.stream.cancel().catch(() => {});
  assert.equal((await getOwnedIdentity(accountId, finalized.identity.id)).sourceVoiceAssetId, derived.id);
  await assert.rejects(createIdentityDraft({ accountId, displayName: 'Forbidden Rebind', sourcePhotoAssetId: photoAssetId, sourceVoiceAssetId: derived.id }), { failureCategory: 'CONSENT' });

  // Database-only migration fixture: prove a legacy ready identity can add the
  // bridge-v2 exposure consent against its original bytes without re-recording.
  await db.update(identityVideoEnrollments).set({
    consentPolicyVersion: LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION,
    consentAuthorizations: {
      audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
      providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    },
  }).where(eq(identityVideoEnrollments.id, finalized.enrollment.id));
  await db.update(identityConsents).set({
    policyVersion: LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION,
    audioExtractionAuthorization: false,
    temporaryPublicProviderExposureAuthorization: false,
    sourceVideoSha256: null,
  }).where(eq(identityConsents.identityId, finalized.identity.id));
  await assert.rejects(getRenderAuthorizedIdentity(accountId, finalized.identity.id), { failureCategory: 'CONSENT' });
  const reconsentInput = {
    action: 'provider-reconsent', contractVersion: ENROLLMENT_CONTRACT_VERSION,
    enrollmentId: finalized.enrollment.id, identityId: finalized.identity.id,
    expectedStateVersion: finalized.enrollment.stateVersion, idempotencyKey: randomUUID(),
    policyVersion: ENROLLMENT_CONSENT_POLICY_VERSION, purpose: 'identity-voice-enrollment',
    sourcePhotoSha256: 'a'.repeat(64), sourceVideoSha256: sourceSha256, derivedVoiceSha256: finalized.enrollment.derivedAudioSha256,
    audioExtractionAuthorization: true, faceAuthorization: true, voiceAuthorization: true,
    providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: true,
  };
  const reconsented = await grantProviderBridgeReconsent({ accountId, input: reconsentInput });
  assert.equal(reconsented.replayed, false);
  assert.equal(reconsented.enrollment.consentPolicyVersion, ENROLLMENT_CONSENT_POLICY_VERSION);
  const consentHistory = await db.select().from(identityConsents).where(eq(identityConsents.identityId, finalized.identity.id));
  assert.equal(consentHistory.length, 2);
  assert.ok(consentHistory.some(row => row.policyVersion === LEGACY_ENROLLMENT_CONSENT_POLICY_VERSION && row.temporaryPublicProviderExposureAuthorization === false));
  assert.ok(consentHistory.some(row => row.policyVersion === ENROLLMENT_CONSENT_POLICY_VERSION && row.temporaryPublicProviderExposureAuthorization === true));
  assert.equal((await grantProviderBridgeReconsent({ accountId, input: reconsentInput })).replayed, true);
  await assert.rejects(grantProviderBridgeReconsent({ accountId, input: {
    ...reconsentInput, idempotencyKey: randomUUID(), expectedStateVersion: reconsented.enrollment.stateVersion,
    sourceVideoSha256: 'f'.repeat(64),
  } }), { failureCategory: 'CONSENT' });
  await assertEnrollmentProviderAllowed(accountId, finalized.identity.id);
  await getRenderAuthorizedIdentity(accountId, finalized.identity.id);

  const providerOperationKey = randomUUID();
  await assert.rejects(reserveIdentityComponentCreation({
    accountId, identityId: finalized.identity.id, component: 'voice', operationKey: providerOperationKey,
  }), { code: 'MISSING_PROVIDER_ACCOUNT_BINDING' });
  // Test-only state fixture for the subsequent missing-binding claim hold. A
  // real component reservation now requires process-branded binding authority.
  await db.update(userIdentities).set({
    voiceStatus: 'CREATING', voiceOperationKey: providerOperationKey, overallStatus: 'CLONING_VOICE',
  }).where(eq(userIdentities.id, finalized.identity.id));

  // Database-only fixture: provider readiness is synthetic, and no HeyGen call is made.
  const projectId = randomUUID();
  const projectTitle = 'Enrolled identity scripted render proof';
  const projectScript = 'This isolated database fixture proves the enrolled identity contract.';
  await db.update(userIdentities).set({
    overallStatus: 'READY', avatarStatus: 'READY', voiceStatus: 'READY',
    providerAvatarGroupId: `synthetic-group-${finalized.identity.id}`,
    providerRenderableAvatarId: `synthetic-avatar-${finalized.identity.id}`,
    providerVoiceId: `synthetic-voice-${finalized.identity.id}`,
  }).where(eq(userIdentities.id, finalized.identity.id));
  await db.insert(projects).values({
    id: projectId, accountId, identityId: finalized.identity.id, title: projectTitle, script: projectScript,
    avatar: {}, voice: {}, settings: { contractVersion: SCRIPTED_PHOTO_CONTRACT_VERSION, tier: 'STANDARD', format: 'vertical' },
  });
  const scriptedContext = await getScriptedPhotoReservationContext({
    accountId, projectId, identityId: finalized.identity.id, title: projectTitle, script: projectScript, tier: 'STANDARD',
  });
  assert.equal(scriptedContext.input.sourceBinding.policyVersion, ENROLLMENT_CONSENT_POLICY_VERSION);
  assert.equal(scriptedContext.input.sourceBinding.sourceVoiceAssetId, derived.id);
  await assert.rejects(
    claimEnrollmentProviderOperation({ accountId, identityId: finalized.identity.id, component: 'voice', stage: 'create', operationKey: providerOperationKey }),
    { code: 'MISSING_PROVIDER_ACCOUNT_BINDING' },
  );

  const revoked = await revokeEnrollment({ accountId, input: {
    enrollmentId: created.enrollment.id, expectedStateVersion: reconsented.enrollment.stateVersion, idempotencyKey: randomUUID(),
  } });
  assert.equal(revoked.enrollment.status, 'REVOKED');
  const orphanedEnrollment = await getOwnedEnrollment(accountId, created.enrollment.id);
  assert.equal(orphanedEnrollment.providerReconciliationStatus, 'NONE');
  assert.equal(orphanedEnrollment.providerReceipts['voice:create'], undefined);
  assert.ok((await getOwnedIdentity(accountId, finalized.identity.id)).archivedAt);
  const activeConsent = await db.select().from(identityConsents).where(and(eq(identityConsents.identityId, finalized.identity.id), isNull(identityConsents.revokedAt)));
  assert.equal(activeConsent.length, 0);
  await assert.rejects(assertEnrollmentProviderAllowed(accountId, finalized.identity.id), { failureCategory: 'CONSENT' });
  await assert.rejects(getRenderAuthorizedIdentity(accountId, finalized.identity.id), { failureCategory: 'CONSENT' });
  await assert.rejects(getScriptedPhotoReservationContext({
    accountId, projectId, identityId: finalized.identity.id, title: projectTitle, script: projectScript, tier: 'STANDARD',
  }), { failureCategory: 'CONSENT' });
  assert.equal((await getOwnedEnrollment(accountId, created.enrollment.id)).photoSha256, 'a'.repeat(64));

  const late = await createEnrollment({ accountId, correlationId: randomUUID(), input: {
    action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey: randomUUID(), displayName: 'Late Upload Revocation',
    photoAssetId, filename: 'late-phone.mp4', contentType: 'video/mp4', bytes: sourceBytes.length,
  } });
  const lateClientToken = await generateClientTokenFromReadWriteToken({
    token, pathname: late.enrollment.uploadPathname, allowedContentTypes: ['video/mp4'], maximumSizeInBytes: sourceBytes.length,
    validUntil: new Date(late.enrollment.uploadExpiresAt).getTime(), addRandomSuffix: false, allowOverwrite: false,
  });
  const lateRevoked = await revokeEnrollment({ accountId, input: {
    enrollmentId: late.enrollment.id, expectedStateVersion: late.enrollment.stateVersion, idempotencyKey: randomUUID(),
  } });
  assert.equal(lateRevoked.enrollment.status, 'REVOKED');
  await recordEnrollmentCleanup({ enrollmentId: late.enrollment.id, deleted: true });
  const lateBlob = await clientPut(late.enrollment.uploadPathname, sourceBytes, {
    access: 'private', token: lateClientToken, contentType: 'video/mp4', multipart: true,
  });
  blobPaths.add(late.enrollment.uploadPathname);
  assert.equal(lateBlob.pathname, late.enrollment.uploadPathname);
  await db.update(identityVideoEnrollments).set({ uploadExpiresAt: new Date(Date.now() - 1_000) }).where(eq(identityVideoEnrollments.id, late.enrollment.id));
  const lateCleanup = await cleanupEnrollmentStorage(late.enrollment.id, true);
  assert.equal(lateCleanup.cleaned, true, 'post-token-expiry cleanup rechecks a path previously marked deleted');

  // Database-only TTL fixture: an abandoned retryable failure keeps its source
  // while retry is available, then becomes terminal once the overall TTL ends.
  const abandoned = await createEnrollment({ accountId, correlationId: randomUUID(), input: {
    action: 'create', contractVersion: ENROLLMENT_CONTRACT_VERSION, idempotencyKey: randomUUID(), displayName: 'Abandoned Retryable Failure',
    photoAssetId, filename: 'abandoned-phone.mp4', contentType: 'video/mp4', bytes: sourceBytes.length,
  } });
  const past = new Date(Date.now() - 1_000);
  await db.update(identityVideoEnrollments).set({
    status: ENROLLMENT_STATUSES.FAILED, failureCode: 'PERSISTENCE', failureMessage: 'Synthetic retryable failure.',
    attemptCount: 1, cleanupStatus: 'NOT_REQUIRED', uploadExpiresAt: past, expiresAt: past,
  }).where(eq(identityVideoEnrollments.id, abandoned.enrollment.id));
  const expiredAbandoned = await expireEnrollment({ accountId, enrollmentId: abandoned.enrollment.id, now: new Date() });
  assert.equal(expiredAbandoned.status, ENROLLMENT_STATUSES.EXPIRED);
  assert.equal(expiredAbandoned.cleanupStatus, 'PENDING');
  assert.equal((await cleanupEnrollmentStorage(abandoned.enrollment.id, true)).cleaned, true);
});
