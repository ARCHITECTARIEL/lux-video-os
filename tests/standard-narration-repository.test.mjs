// Live integration test against a real (non-production) Postgres + Blob
// target. Skips cleanly when DATABASE_URL/BLOB_READ_WRITE_TOKEN are not
// configured, so it never blocks `npm test` for a developer or CI job
// without that access -- but when it runs, it proves the actual pipeline
// end to end rather than asserting against mocks.
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
import { addUploadMediaAsset, claimWorkflowStart, createIdentityDraft, ensureAccount, getJob, recordIdentityConsent, saveStandardProject, transitionJob, finalizeReadyJob } from '../db/repositories.js';
import { entitlements, users } from '../db/schema.js';
import { standardNarrationRepository } from '../db/standard-narration-repository.js';
import { renderStandardSimulation } from '../services/sadtalker-simulator.js';
import { accountHash } from '../lib/video-os-security.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../lib/video-os-identity-policy.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { STANDARD_CONTRACT_VERSION, STANDARD_NARRATION_CREDITS, STANDARD_NARRATION_POLICY_VERSION } from '../lib/standard-narration-contract.js';

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
  'Standard narration pipeline: upload -> identity -> consent -> quote -> reserve -> simulated render -> settlement, against a real database and Blob store',
  { skip: !dbAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = 'true';
    process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = 'true';

    const accountId = `test-standard-${crypto.randomUUID()}`;
    const workdir = mkdtempSync(join(tmpdir(), 'standard-narration-test-'));
    t.after(async () => {
      rmSync(workdir, { recursive: true, force: true });
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    await ensureAccount({ accountId, email: null, name: 'Standard Narration Test', initialCredits: 1000 });
    await database().insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });

    // Real bytes, not synthetic metadata: ffmpeg-generate a portrait JPEG and a
    // narration WAV so the eventual sadtalker-simulator ffmpeg composite step
    // has genuine media to work with, not just a database row that claims to.
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

    const identity = await createIdentityDraft({ accountId, displayName: 'Standard Test Presenter', sourcePhotoAssetId: portraitAssetId, sourceVoiceAssetId: identityVoiceAssetId });
    await recordIdentityConsent({
      accountId, identityId: identity.id, policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
      faceAuthorization: true, voiceAuthorization: true, providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
    });

    const project = await saveStandardProject({ accountId, title: 'Standard Narration Test Video', identityId: identity.id, narrationAudioAssetId: narrationAssetId });

    await t.test('readiness reports consent-required before narration consent exists', async () => {
      const readiness = await standardNarrationRepository.readiness(accountId, accountId, { projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId });
      assert.equal(readiness.ready, false);
      assert.equal(readiness.reasonCode, 'standard_narration_consent_required');
    });

    const grantIdempotencyKey = crypto.randomUUID();
    const consent = await standardNarrationRepository.grantConsent(accountId, accountId, {
      idempotencyKey: grantIdempotencyKey, projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId,
      policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true,
    });

    await t.test('granting consent twice with the same idempotency key replays instead of duplicating', async () => {
      const replay = await standardNarrationRepository.grantConsent(accountId, accountId, {
        idempotencyKey: grantIdempotencyKey, projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId,
        policyVersion: STANDARD_NARRATION_POLICY_VERSION, consent: true,
      });
      assert.equal(replay.id, consent.id);
    });

    await t.test('readiness reports ready once consent is granted', async () => {
      const readiness = await standardNarrationRepository.readiness(accountId, accountId, {
        projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId, narrationConsentId: consent.id,
      });
      assert.equal(readiness.ready, true);
      assert.equal(readiness.credits, STANDARD_NARRATION_CREDITS);
    });

    const quote = await standardNarrationRepository.createQuote(accountId, accountId, {
      projectId: project.id, identityId: identity.id, audioAssetId: narrationAssetId, narrationConsentId: consent.id, format: 'vertical',
    });
    assert.equal(quote.credits, STANDARD_NARRATION_CREDITS);
    assert.ok(new Date(quote.expiresAt).getTime() > Date.now());

    const jobId = `job-standard-test-${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();
    const reserveInput = {
      contractVersion: STANDARD_CONTRACT_VERSION, quoteId: quote.id, narrationConsentId: consent.id,
      projectId: project.id, identityId: identity.id, audioReference: { assetId: narrationAssetId }, initiatingUser: accountId,
    };

    await t.test('reserveRender consumes the quote exactly once and reserves credits', async () => {
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const reserved = await standardNarrationRepository.reserveRender({ jobId, accountId, idempotencyKey, correlationId: 'corr-test', title: 'Standard Narration Test Video', format: 'vertical', input: reserveInput });
      assert.equal(reserved.replayed, false);
      assert.equal(reserved.job.status, 'reserved');
      assert.equal(reserved.job.provider, 'sadtalker');
      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(after.reserved - before.reserved, STANDARD_NARRATION_CREDITS);
    });

    await t.test('replaying the same idempotency key returns the same job without a second reservation', async () => {
      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const replay = await standardNarrationRepository.reserveRender({ jobId, accountId, idempotencyKey, correlationId: 'corr-test', title: 'Standard Narration Test Video', format: 'vertical', input: reserveInput });
      assert.equal(replay.replayed, true);
      assert.equal(replay.job.id, jobId);
      const after = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(after.reserved, before.reserved);
    });

    await t.test('a second quote for the same inputs cannot reserve against the already-consumed first quote', async () => {
      await assert.rejects(
        standardNarrationRepository.reserveRender({ jobId: `job-standard-test-${crypto.randomUUID()}`, accountId, idempotencyKey: crypto.randomUUID(), correlationId: 'corr-test-2', title: 'Duplicate attempt', format: 'vertical', input: { ...reserveInput, quoteId: quote.id } }),
        (error) => error.code === 'standard_narration_quote_consumed',
      );
    });

    await t.test('resolveSources round-trips the exact canonical binding recorded at reservation', async () => {
      const job = await getJob(jobId);
      const resolved = await database().transaction((tx) => standardNarrationRepository.resolveSources(tx, accountId, { ...job.input, jobId, format: job.format, correlationId: job.correlationId }));
      assert.equal(resolved.assets.portrait.id, portraitAssetId);
      assert.equal(resolved.assets.drivenAudio.id, narrationAssetId);
      assert.equal(resolved.quote.id, quote.id);
    });

    await t.test('the simulated render produces a real playable MP4 and settlement completes exactly once', async () => {
      await claimWorkflowStart(jobId);
      const job = await getJob(jobId);
      assert.equal(job.status, 'workflow_started');
      await transitionJob({ jobId, stageTo: 'provider_submitting', eventType: 'provider.submit_started' });
      const resolved = await database().transaction((tx) => standardNarrationRepository.resolveSources(tx, accountId, { ...job.input, jobId, format: job.format, correlationId: job.correlationId }));
      await transitionJob({ jobId, stageTo: 'provider_submitted', eventType: 'provider.submitted' });
      await transitionJob({ jobId, stageTo: 'provider_rendering', eventType: 'provider.polled' });
      const artifact = await renderStandardSimulation(resolved.input, resolved.assets, { format: job.format, title: job.title });
      assert.equal(artifact.simulation, true);
      assert.ok(artifact.bytes > 1000, 'rendered MP4 should have real bytes');
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      await transitionJob({ jobId, stageTo: 'provider_ready', eventType: 'provider.ready' });
      await transitionJob({ jobId, stageTo: 'finishing', eventType: 'finish.started' });

      const before = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      const ready = await finalizeReadyJob(jobId, artifact);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.output.sha256, artifact.sha256);
      const afterFirst = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(before.balance - afterFirst.balance, STANDARD_NARRATION_CREDITS);
      assert.equal(afterFirst.reserved, before.reserved - STANDARD_NARRATION_CREDITS);

      // finalizeReadyJob must be safely re-callable (workflow retry) without a second debit.
      const readyAgain = await finalizeReadyJob(jobId, artifact);
      assert.equal(readyAgain.status, 'ready');
      const afterSecond = await database().query.creditAccounts.findFirst({ where: (table, { eq: equals }) => equals(table.accountId, accountId) });
      assert.equal(afterSecond.balance, afterFirst.balance);
    });
  },
);
