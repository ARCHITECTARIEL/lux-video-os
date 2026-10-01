// Live integration test against a real (non-production) Postgres + Blob
// target, mirroring tests/standard-narration-repository.test.mjs. Proves
// worker/render-worker.mjs -- the VPS-hosted replacement for Vercel
// Workflow's dispatch -- actually drives a reserved job to completion
// through the same DB-visible state machine a poll loop would use, not
// just that its exported functions type-check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { addUploadMediaAsset, claimWorkflowStart, createIdentityDraft, ensureAccount, getJob, listInFlightJobs, transitionJob, saveStandardProject, recordIdentityConsent } from '../db/repositories.js';
import { entitlements, mediaAssets, users } from '../db/schema.js';
import { standardNarrationRepository } from '../db/standard-narration-repository.js';
import { accountHash } from '../lib/video-os-security.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../lib/video-os-identity-policy.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob, getPrivateBlob, deletePrivateBlob } from '../lib/video-os-private-blob.js';
import { STANDARD_CONTRACT_VERSION, STANDARD_NARRATION_CREDITS, STANDARD_NARRATION_POLICY_VERSION } from '../lib/standard-narration-contract.js';
import { driveJob, driveJobSafely } from '../lib/video-os-render-driver.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('no blob token');
} catch {
  dbAvailable = false;
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) throw new Error(`ffmpeg spawn failed (path=${ffmpegPath}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr?.toString().slice(-500)}`);
}

test(
  'render-worker: driveJob carries a reserved Standard job through to ready, against a real database and Blob store',
  { skip: !dbAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = 'true';

    const accountId = `test-render-worker-${crypto.randomUUID()}`;
    const workdir = mkdtempSync(join(tmpdir(), 'render-worker-test-'));
    t.after(async () => {
      rmSync(workdir, { recursive: true, force: true });
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    await ensureAccount({ accountId, email: null, name: 'Render Worker Test', initialCredits: 1000 });
    await database().insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });

    const portraitPath = join(workdir, 'portrait.jpg');
    const narrationPath = join(workdir, 'narration.wav');
    const identityVoicePath = join(workdir, 'identity-voice.wav');
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=green:s=512x512', '-frames:v', '1', portraitPath]);
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', narrationPath]);
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', identityVoicePath]);

    const portraitBytes = readFileSync(portraitPath);
    const narrationBytes = readFileSync(narrationPath);
    const identityVoiceBytes = readFileSync(identityVoicePath);
    const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
    const prefix = `video-os/uploads/${accountHash(accountId)}`;

    async function uploadAsset({ id, buffer, contentType, kind, extra = {} }) {
      const pathname = `${prefix}/${kind}-${id}${contentType === 'image/jpeg' ? '.jpg' : '.wav'}`;
      await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, { contentType, addRandomSuffix: false, allowOverwrite: true });
      return addUploadMediaAsset({ id, accountId, kind, privatePathname: pathname, contentType, bytes: buffer.length, sha256: hash(buffer), ...extra });
    }

    const portraitAssetId = crypto.randomUUID();
    const identityVoiceAssetId = crypto.randomUUID();
    const narrationAssetId = crypto.randomUUID();
    await uploadAsset({ id: portraitAssetId, buffer: portraitBytes, contentType: 'image/jpeg', kind: 'identity-photo-source', extra: { widthPx: 512, heightPx: 512 } });
    await uploadAsset({ id: identityVoiceAssetId, buffer: identityVoiceBytes, contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 6000 } });
    await uploadAsset({ id: narrationAssetId, buffer: narrationBytes, contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 3000 } });

    const identity = await createIdentityDraft({ accountId, displayName: 'Render Worker Test Presenter', sourcePhotoAssetId: portraitAssetId, sourceVoiceAssetId: identityVoiceAssetId });
    await recordIdentityConsent({
      accountId, identityId: identity.id, policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
      faceAuthorization: true, voiceAuthorization: true, providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    });

    const project = await saveStandardProject({ accountId, title: 'Render Worker Test Video', identityId: identity.id, narrationAudioAssetId: narrationAssetId });
    const consent = await standardNarrationRepository.grantConsent(accountId, accountId, {
      idempotencyKey: crypto.randomUUID(), projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId,
      policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true,
    });
    const quote = await standardNarrationRepository.createQuote(accountId, accountId, {
      projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId, narrationConsentId: consent.id, format: 'vertical',
    });

    const jobId = `job-render-worker-test-${crypto.randomUUID()}`;
    const reserveInput = {
      contractVersion: STANDARD_CONTRACT_VERSION, quoteId: quote.id, narrationConsentId: consent.id,
      projectId: project.id, identityId: identity.id, audioReference: { assetId: narrationAssetId }, initiatingUser: accountId,
    };
    const reserved = await standardNarrationRepository.reserveRender({ jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-render-worker-test', title: 'Render Worker Test Video', format: 'vertical', input: reserveInput });
    assert.equal(reserved.job.status, 'reserved');

    await t.test('a merely-reserved job (workflow not yet claimed) is not in-flight', async () => {
      const inFlight = await listInFlightJobs(200);
      assert.ok(!inFlight.some((job) => job.id === jobId));
    });

    await claimWorkflowStart(jobId);

    await t.test('once claimed, the job is visible to listInFlightJobs', async () => {
      const inFlight = await listInFlightJobs(200);
      assert.ok(inFlight.some((job) => job.id === jobId));
    });

    await t.test('driveJob resumes a simulated job after provider_submitted and completes it once', async () => {
      await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'test.progress' });
      await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'test.progress' });
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const job = await getJob(jobId);
      await driveJob(job);
      const ready = await getJob(jobId);
      assert.equal(ready.status, 'ready');
      assert.match(ready.output.sha256, /^[a-f0-9]{64}$/);
      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(before.balance - after.balance, STANDARD_NARRATION_CREDITS);
    });

    await t.test('a ready job drops out of listInFlightJobs', async () => {
      const inFlight = await listInFlightJobs(200);
      assert.ok(!inFlight.some((job) => job.id === jobId));
    });
  },
);

// Missing private source bytes are a deterministic local simulation failure.
// Keep the FK-protected metadata/consent intact; delete only this test's Blob.
// No external provider was contacted, so the reservation must be released.
test(
  'render-worker: missing private narration bytes fail a local simulation and release its reservation',
  { skip: !dbAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = 'true';

    const accountId = `test-render-worker-missing-asset-${crypto.randomUUID()}`;
    const workdir = mkdtempSync(join(tmpdir(), 'render-worker-missing-asset-test-'));
    t.after(async () => {
      rmSync(workdir, { recursive: true, force: true });
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    await ensureAccount({ accountId, email: null, name: 'Render Worker Missing Asset Test', initialCredits: 1000 });
    await database().insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });

    const portraitPath = join(workdir, 'portrait.jpg');
    const narrationPath = join(workdir, 'narration.wav');
    const identityVoicePath = join(workdir, 'identity-voice.wav');
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', portraitPath]);
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', narrationPath]);
    runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', identityVoicePath]);

    const portraitBytes = readFileSync(portraitPath);
    const narrationBytes = readFileSync(narrationPath);
    const identityVoiceBytes = readFileSync(identityVoicePath);
    const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
    const prefix = `video-os/uploads/${accountHash(accountId)}`;

    async function uploadAsset({ id, buffer, contentType, kind, extra = {} }) {
      const pathname = `${prefix}/${kind}-${id}${contentType === 'image/jpeg' ? '.jpg' : '.wav'}`;
      await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, { contentType, addRandomSuffix: false, allowOverwrite: true });
      return addUploadMediaAsset({ id, accountId, kind, privatePathname: pathname, contentType, bytes: buffer.length, sha256: hash(buffer), ...extra });
    }

    const portraitAssetId = crypto.randomUUID();
    const identityVoiceAssetId = crypto.randomUUID();
    const narrationAssetId = crypto.randomUUID();
    await uploadAsset({ id: portraitAssetId, buffer: portraitBytes, contentType: 'image/jpeg', kind: 'identity-photo-source', extra: { widthPx: 512, heightPx: 512 } });
    await uploadAsset({ id: identityVoiceAssetId, buffer: identityVoiceBytes, contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 6000 } });
    await uploadAsset({ id: narrationAssetId, buffer: narrationBytes, contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 3000 } });

    const identity = await createIdentityDraft({ accountId, displayName: 'Missing Asset Test Presenter', sourcePhotoAssetId: portraitAssetId, sourceVoiceAssetId: identityVoiceAssetId });
    await recordIdentityConsent({
      accountId, identityId: identity.id, policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
      faceAuthorization: true, voiceAuthorization: true, providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    });

    const project = await saveStandardProject({ accountId, title: 'Missing Asset Test Video', identityId: identity.id, narrationAudioAssetId: narrationAssetId });
    const consent = await standardNarrationRepository.grantConsent(accountId, accountId, {
      idempotencyKey: crypto.randomUUID(), projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId,
      policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true,
    });
    const quote = await standardNarrationRepository.createQuote(accountId, accountId, {
      projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId, narrationConsentId: consent.id, format: 'vertical',
    });

    const jobId = `job-render-worker-missing-asset-${crypto.randomUUID()}`;
    const reserveInput = {
      contractVersion: STANDARD_CONTRACT_VERSION, quoteId: quote.id, narrationConsentId: consent.id,
      projectId: project.id, identityId: identity.id, audioReference: { assetId: narrationAssetId }, initiatingUser: accountId,
    };
    const reserved = await standardNarrationRepository.reserveRender({ jobId, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-render-worker-missing-asset-test', title: 'Missing Asset Test Video', format: 'vertical', input: reserveInput });
    assert.equal(reserved.job.status, 'reserved');
    await claimWorkflowStart(jobId);

    const beforeDeletion = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(beforeDeletion.reserved, STANDARD_NARRATION_CREDITS, 'sanity check: credits are really reserved before the failure');

    const [source] = await database().select().from(mediaAssets).where(eq(mediaAssets.id, narrationAssetId));
    const stored = await getPrivateBlob(source.privatePathname);
    assert.ok(stored?.blob?.etag);
    await new Response(stored.stream).arrayBuffer();
    await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, source.privatePathname, { ifMatch: stored.blob.etag });

    const job = await getJob(jobId);
    await driveJobSafely(job);

    const after = await getJob(jobId);
    assert.equal(after.status, 'failed');
    assert.equal(after.failureCategory, 'PERSISTENCE');

    const afterCredits = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
    assert.equal(afterCredits.reserved, 0, 'deterministic local failure releases the reservation');
    assert.equal(afterCredits.balance, beforeDeletion.balance, 'balance must be unchanged -- neither charged further nor refunded');

    const stillInFlight = await listInFlightJobs(200);
    assert.ok(!stillInFlight.some((j) => j.id === jobId), 'a failed local job must not re-enter the ordinary poll loop');
  },
);
