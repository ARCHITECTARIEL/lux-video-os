// Shared setup for tests that need a real, fully-authorized Standard-tier
// account (identity + identity consent + narration audio upload + project)
// against a real database and Blob store. Not a mock -- every asset is a
// genuine ffmpeg-generated file uploaded to the real (non-production) Blob
// store, matching what tests/standard-narration-repository.test.mjs already
// proves works end to end.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { addUploadMediaAsset, createIdentityDraft, ensureAccount, recordIdentityConsent, saveStandardProject } from '../../db/repositories.js';
import { database } from '../../db/client.js';
import { entitlements, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { accountHash } from '../../lib/video-os-security.js';
import { IDENTITY_CONSENT_POLICY_VERSION } from '../../lib/video-os-identity-policy.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../../lib/video-os-private-blob.js';

function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) throw new Error(`ffmpeg spawn failed (path=${ffmpegPath}): ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr?.toString().slice(-500)}`);
}

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export function activateStandardNarrationEnv() {
  process.env.VIDEO_OS_STANDARD_NARRATION_SCHEMA_READY = 'true';
  process.env.VIDEO_OS_STANDARD_NARRATION_POLICY_APPROVED = 'true';
  process.env.VIDEO_OS_STANDARD_NARRATION_PRICING_APPROVED = 'true';
  process.env.VIDEO_OS_STANDARD_RENDER_ENABLED = 'true';
}

// Returns { accountId, identity, project, narrationAssetId, cleanup() }.
// Caller is responsible for calling cleanup() (e.g. from t.after).
export async function createStandardAccountFixture({ initialCredits = 1000 } = {}) {
  const accountId = `test-standard-${crypto.randomUUID()}`;
  const workdir = mkdtempSync(join(tmpdir(), 'standard-fixture-'));

  await ensureAccount({ accountId, email: null, name: 'Standard Fixture Account', initialCredits });
  await database().insert(entitlements).values({ accountId, entitlementKey: 'standardRendering', enabled: true, sourceType: 'test_fixture' });

  const portraitPath = join(workdir, 'portrait.jpg');
  const narrationPath = join(workdir, 'narration.wav');
  const identityVoicePath = join(workdir, 'identity-voice.wav');
  runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', portraitPath]);
  runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', narrationPath]);
  runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', identityVoicePath]);

  const prefix = `video-os/uploads/${accountHash(accountId)}`;
  async function uploadAsset({ id, buffer, contentType, kind, extra = {} }) {
    const pathname = `${prefix}/${kind}-${id}${contentType === 'image/jpeg' ? '.jpg' : '.wav'}`;
    await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname, buffer, { contentType, addRandomSuffix: false, allowOverwrite: true });
    return addUploadMediaAsset({ id, accountId, kind, privatePathname: pathname, contentType, bytes: buffer.length, sha256: hash(buffer), ...extra });
  }

  const portraitAssetId = crypto.randomUUID();
  const identityVoiceAssetId = crypto.randomUUID();
  const narrationAssetId = crypto.randomUUID();
  await uploadAsset({ id: portraitAssetId, buffer: readFileSync(portraitPath), contentType: 'image/jpeg', kind: 'identity-photo-source', extra: { widthPx: 512, heightPx: 512 } });
  await uploadAsset({ id: identityVoiceAssetId, buffer: readFileSync(identityVoicePath), contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 6000 } });
  await uploadAsset({ id: narrationAssetId, buffer: readFileSync(narrationPath), contentType: 'audio/wav', kind: 'identity-voice-source', extra: { durationMs: 3000 } });

  const identity = await createIdentityDraft({ accountId, displayName: 'Standard Fixture Presenter', sourcePhotoAssetId: portraitAssetId, sourceVoiceAssetId: identityVoiceAssetId });
  await recordIdentityConsent({
    accountId, identityId: identity.id, policyVersion: IDENTITY_CONSENT_POLICY_VERSION,
    faceAuthorization: true, voiceAuthorization: true, providerProcessingAuthorization: true, archiveDeleteAcknowledgment: true,
  });
  const project = await saveStandardProject({ accountId, title: 'Standard Fixture Video', identityId: identity.id, narrationAudioAssetId: narrationAssetId });

  return {
    accountId, identity, project, narrationAssetId,
    async cleanup() {
      rmSync(workdir, { recursive: true, force: true });
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    },
  };
}
