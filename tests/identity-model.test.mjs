import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getTableColumns, getTableName } from 'drizzle-orm';

import { identityConsents, mediaAssets, projects, userIdentities } from '../db/schema.js';
import { assertIdentitySourceAssets, deriveIdentityStatus, redactIdentityFailure } from '../db/repositories.js';

test('identity schema uses stable internal ownership and separate provider resources', () => {
  assert.equal(getTableName(userIdentities), 'user_identities');
  assert.equal(getTableName(identityConsents), 'identity_consents');
  const identity = getTableColumns(userIdentities);
  assert.equal(identity.id.dataType, 'string');
  assert.equal(identity.accountId.notNull, true);
  assert.equal(identity.sourcePhotoAssetId.notNull, true);
  assert.equal(identity.sourceVoiceAssetId.notNull, true);
  assert.notEqual(identity.providerAvatarGroupId.name, identity.providerRenderableAvatarId.name);
  assert.equal(identity.providerVoiceId.name, 'provider_voice_id');
  assert.equal(identity.avatarOperationKey.name, 'avatar_operation_key');
  assert.equal(identity.voiceOperationKey.name, 'voice_operation_key');
});

test('consent schema stores the policy decision and frozen source fingerprints', () => {
  const consent = getTableColumns(identityConsents);
  for (const field of ['accountId', 'identityId', 'faceAuthorization', 'voiceAuthorization', 'providerProcessingAuthorization', 'archiveDeleteAcknowledgment', 'policyVersion', 'photoSha256', 'voiceSha256', 'acceptedAt']) {
    assert.equal(consent[field].notNull, true, `${field} must be durable consent evidence`);
  }
  assert.equal(consent.revokedAt.notNull, false);
});

test('media assets retain private validation metadata and provider upload identity', () => {
  const media = getTableColumns(mediaAssets);
  assert.equal(media.widthPx.name, 'width_px');
  assert.equal(media.heightPx.name, 'height_px');
  assert.equal(media.durationMs.name, 'duration_ms');
  assert.equal(media.providerAssetId.name, 'provider_asset_id');
  assert.equal(media.quarantinedAt.name, 'quarantined_at');
});

test('identity drafts accept only assets produced by the strict biometric upload path', () => {
  const photo = { kind: 'identity-photo-source', contentType: 'image/png' };
  const voice = { kind: 'identity-voice-source', contentType: 'audio/wav' };
  assert.equal(assertIdentitySourceAssets(photo, voice), true);
  assert.throws(() => assertIdentitySourceAssets({ ...photo, kind: 'avatar-photo-source' }, voice), /photo source is invalid/);
  assert.throws(() => assertIdentitySourceAssets(photo, { ...voice, kind: 'customer-audio' }), /voice source is invalid/);
  assert.throws(() => assertIdentitySourceAssets(null, voice), /not found/);
});

test('projects retain an optional internal identity reference', () => {
  const project = getTableColumns(projects);
  assert.equal(project.identityId.name, 'identity_id');
  assert.equal(project.identityId.notNull, false);
});

test('overall identity readiness is derived without resetting a ready sibling', () => {
  assert.equal(deriveIdentityStatus(), 'DRAFT');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'CREATING', voiceStatus: 'DRAFT' }), 'CREATING_AVATAR');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'READY', voiceStatus: 'CREATING' }), 'PROCESSING');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'READY', voiceStatus: 'FAILED' }), 'PARTIAL_FAILURE');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'FAILED', voiceStatus: 'FAILED' }), 'FAILED');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'READY', voiceStatus: 'READY' }), 'READY');
  assert.equal(deriveIdentityStatus({ avatarStatus: 'READY', voiceStatus: 'READY', archivedAt: new Date() }), 'ARCHIVED');
});

test('provider failures are bounded and redact URLs and credential-shaped values', () => {
  const failure = redactIdentityFailure('provider bad/code', 'POST https://signed.example/private?token=secret authorization=Bearer-secret\nretry');
  assert.equal(failure.code, 'PROVIDER_BAD_CODE');
  assert.doesNotMatch(failure.message, /signed\.example|Bearer-secret|token=secret/);
  assert.ok(failure.message.length <= 240);
});

test('identity migration is additive, constrained, and provider relationships remain unique', async () => {
  const migration = await readFile(new URL('../drizzle/0004_identity_studio_mvp.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE .user_identities./);
  assert.match(migration, /CREATE TABLE .identity_consents./);
  assert.match(migration, /ALTER TABLE .media_assets. ADD COLUMN .provider_asset_id./);
  assert.match(migration, /ALTER TABLE .projects. ADD COLUMN .identity_id./);
  assert.match(migration, /projects_identity_id_user_identities_id_fk/);
  assert.match(migration, /ON DELETE set null/);
  assert.match(migration, /ON DELETE restrict/);
  assert.match(migration, /identity_consents_active_policy_uq/);
  assert.match(migration, /user_identities_provider_avatar_uq/);
  assert.match(migration, /user_identities_provider_voice_uq/);
  assert.match(migration, /user_identities_overall_status_ck/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
});

test('identity repositories enforce account ownership and local operation reservations', async () => {
  const source = await readFile(new URL('../db/repositories.js', import.meta.url), 'utf8');
  for (const symbol of ['getOwnedIdentity', 'getReadyOwnedIdentity', 'reserveIdentityComponentCreation', 'recordIdentityProviderSubmission', 'markIdentityComponentReady', 'markIdentityComponentFailed', 'archiveOwnedIdentity']) {
    assert.match(source, new RegExp(`export async function ${symbol}`));
  }
  assert.match(source, /eq\(userIdentities\.accountId, accountId\).+eq\(userIdentities\.id, identityId\)/s);
  assert.match(source, /identity\[fields\.operation\] === operationKey.+replayed: true/s);
  assert.match(source, /Identity component creation is already in progress/);
  assert.match(source, /component === 'avatar'.+providerAvatarRequestId: null.+providerVoiceId: null/s);
  assert.match(source, /const linkedEnrollment = await activeLinkedEnrollment\(tx, accountId, identityId\)/);
  assert.match(source, /assertActiveIdentityConsent\(tx, identity, linkedEnrollment\?\.consentPolicyVersion \|\| IDENTITY_CONSENT_POLICY_VERSION\)/);
  assert.match(source, /photo\.sha256 !== consent\.photoSha256 \|\| voice\.sha256 !== consent\.voiceSha256/);
  assert.match(source, /identity\[fields\.status\] === 'READY'.+cannot be failed/s);
  assert.match(source, /eq\(userIdentities\.accountId, accountId\).+eq\(userIdentities\.id, identityId\).+isNull\(userIdentities\.archivedAt\)/s);
  assert.match(source, /Identity not found.+failureCategory: 'OWNERSHIP'/s);
});

test('identity migration dry run proves populated-schema preservation and rollback', async () => {
  const source = await readFile(new URL('../tools/dry-run-identity-migration.mjs', import.meta.url), 'utf8');
  assert.match(source, /savepoint before_identity_migration/);
  assert.match(source, /rollback to savepoint before_identity_migration/);
  assert.match(source, /preserved_projects/);
  assert.match(source, /media_extension_removed/);
  assert.match(source, /await client\.query\('rollback'\)/);
});
