import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq } from 'drizzle-orm';
import ws from 'ws';

import * as schema from '../db/schema.js';
import {
  attachProviderConsumerReferenceTx,
  getProviderReconciliationSnapshot,
  markProviderResourceReadyTx,
  providerOperationRequestDigest,
  recordProviderOperationResourcesTx,
  reserveProviderOperationTx,
  withProviderLifecycleLock,
} from '../db/provider-reconciliation-repository.js';
import { createHeygenSpaceBindingRepository, withFreshHeygenSpaceBindingTransaction } from '../db/heygen-space-binding-repository.js';
import { createReconciliationPlan } from '../lib/heygen-reconciliation-contract.js';
import { validateTarget } from '../tools/check-migrations.mjs';

const LIVE = process.env.VIDEO_OS_ISOLATED_LIVE === '1' && process.env.VIDEO_OS_PROVIDER_LEDGER_ISOLATED_LIVE === '1';
const digest = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

test('isolated live DB: real provider repository preserves source, replay, conflict, and tombstone evidence', {
  skip: !LIVE && 'Run only through the guarded isolated-live runner.',
  timeout: 120000,
}, async () => {
  const target = JSON.parse(await readFile(new URL('../config/database-target.verification.json', import.meta.url), 'utf8'));
  const validated = validateTarget(process.env.DATABASE_URL, target, 'verification');
  if (process.env.DATABASE_URL_UNPOOLED) validateTarget(process.env.DATABASE_URL_UNPOOLED, target, 'verification');
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(validated.database, 'mvp_verification_20260930');
  assert.equal(target.projectId, 'dawn-scene-51988854');
  assert.equal(target.branchId, 'br-wandering-violet-ai1egt3g');
  assert.equal(url.pathname, '/mvp_verification_20260930');
  assert.ok(target.hosts.includes(url.hostname));

  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });
  const db = drizzle({ client: pool, schema });

  const accountId = `provider-repo-live-${randomUUID()}`;
  const photoAssetId = randomUUID();
  const voiceAssetId = randomUUID();
  const identityId = randomUUID();
  const enrollmentId = randomUUID();
  const photoSha256 = digest(`photo:${accountId}`);
  const voiceSha256 = digest(`voice:${accountId}`);
  const videoSha256 = digest(`video:${accountId}`);
  const candidateSourceSha256 = digest(`source-tree:${accountId}`);
  const adapterSha256 = digest('heygen-reconciliation-adapter:v1');
  const databaseBindingSha256 = digest(`database:${accountId}`);
  const credentialScopeFingerprint = digest(`credential:${accountId}`);
  const providerResourceId = `asset-${randomUUID()}`;
  const conflictingProviderResourceId = `asset-${randomUUID()}`;
  const terminalConflictProviderResourceId = `asset-${randomUUID()}`;
  const evidenceExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const binding = {
    environment: 'verification',
    projectId: 'prj_repository-live-test',
    databaseBindingSha256,
    credentialScopeFingerprint,
    credentialEvidenceDigest: digest(`synthetic-binding-evidence:${accountId}`),
    credentialEvidenceRef: `provider-ledger/${accountId}/synthetic-binding.json`,
  };
  let providerBinding;

  try {
    // Fixture prerequisites only. Ledger lifecycle behavior below uses the
    // actual repository API and its canonical account advisory lock.
    await pool.query(
      `insert into users (id, name) values ($1, 'Provider Repository Live Fixture')`,
      [accountId],
    );
    await pool.query(`
      insert into media_assets (id, account_id, kind, private_pathname, content_type, bytes, sha256)
      values
        ($1, $3, 'identity-photo-source', $4, 'image/png', 128, $5),
        ($2, $3, 'identity-voice-source', $6, 'audio/wav', 256, $7)
    `, [
      photoAssetId,
      voiceAssetId,
      accountId,
      `video-os/provider-repository/${accountId}/photo.png`,
      photoSha256,
      `video-os/provider-repository/${accountId}/voice.wav`,
      voiceSha256,
    ]);
    await pool.query(`
      insert into user_identities (
        id, account_id, display_name, overall_status, avatar_status, voice_status,
        source_photo_asset_id, source_voice_asset_id
      ) values ($1, $2, 'Synthetic repository fixture', 'READY', 'READY', 'READY', $3, $4)
    `, [identityId, accountId, photoAssetId, voiceAssetId]);
    await pool.query(`
      insert into identity_video_enrollments (
        id, account_id, idempotency_key, correlation_id, contract_version, status,
        display_name, photo_asset_id, photo_sha256, declared_filename,
        declared_content_type, declared_bytes, upload_pathname, upload_operation_key,
        upload_expires_at, expires_at, source_sha256, source_bytes,
        derived_voice_asset_id, derived_audio_sha256, derived_audio_bytes, identity_id
      ) values (
        $1, $2, $3, $4, 'identity-video-enrollment/v1', 'IDENTITY_READY',
        'Synthetic repository fixture', $5, $6, 'phone.mp4', 'video/mp4', 1024,
        $7, $8, now() + interval '1 hour', now() + interval '1 day', $9, 1024,
        $10, $11, 256, $12
      )
    `, [
      enrollmentId,
      accountId,
      randomUUID(),
      randomUUID(),
      photoAssetId,
      photoSha256,
      `video-os/provider-repository/${accountId}/phone.mp4`,
      randomUUID(),
      videoSha256,
      voiceAssetId,
      voiceSha256,
      identityId,
    ]);

    const fixtureNow = new Date();
    const fixtureCredential = `provider-ledger-fixture-${accountId}`;
    const fixtureCredentialFingerprint = createHash('sha256')
      .update(Buffer.from('LUX_VIDEO_OS\0HEYGEN_CREDENTIAL_KEY\0V1\0', 'utf8'))
      .update(fixtureCredential, 'utf8').digest('hex');
    const fixtureProof = Object.freeze({
      version: 'heygen-space-qualification-proof/v1', provider: 'heygen', providerNativeScopeType: 'space', globalAccountIdVerified: false,
      credentialKeyFingerprint: fixtureCredentialFingerprint, credentialScopeFingerprint,
      keyIdDigest: digest(`key-id:${accountId}`), keyCreatedAt: fixtureNow.toISOString(), usernameDigest: digest(`username:${accountId}`),
      providerSpaceFingerprint: digest(`synthetic-provider-space:${accountId}`), canonicalScopeKey: digest(`synthetic-canonical-scope:${accountId}`),
      preflightEvidenceSha256: digest(`synthetic-binding-evidence:${accountId}`), spaceProofSha256: digest(`synthetic-scope-evidence:${accountId}`),
      identityDigest: digest(`synthetic-promotion-evidence:${accountId}`), evidenceRefVersion: 'heygen-space-anchor-evidence/v1',
      probeResultSha256: digest(`synthetic-probe:${accountId}`), spaceObservedAt: new Date(fixtureNow.getTime() - 1_000).toISOString(),
      qualifiedAt: fixtureNow.toISOString(), expiresAt: new Date(fixtureNow.getTime() + 60_000).toISOString(),
      anchorExpiresAt: new Date(fixtureNow.getTime() + 3_600_000).toISOString(),
    });
    const proofBrand = new WeakSet([fixtureProof]);
    const fixtureEnv = {
      VIDEO_OS_SPACE_BINDING_ENVIRONMENT: 'verification',
      DATABASE_URL: process.env.DATABASE_URL,
      ...(process.env.DATABASE_URL_UNPOOLED ? { DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED } : {}),
      HEYGEN_API_KEY: fixtureCredential,
    };
    const bindingRepository = createHeygenSpaceBindingRepository({
      env: () => fixtureEnv,
      now: () => fixtureNow,
      executor: db,
      targetPreflight: async () => ({
        environment: binding.environment, projectId: binding.projectId,
        databaseBindingSha256: binding.databaseBindingSha256,
        databaseUrl: fixtureEnv.DATABASE_URL,
        unpooledUrl: fixtureEnv.DATABASE_URL_UNPOOLED || null,
      }),
      loadVerifiedHeygenSpaceAnchor: async () => ({ credentialKeyFingerprint: fixtureCredentialFingerprint }),
      loadPinnedHeygenSpaceAnchorProjection: async () => ({ credentialKeyFingerprint: fixtureCredentialFingerprint }),
      qualifyHeygenCredential: async () => ({}),
      validateFreshHeygenQualification: () => fixtureProof,
      assertFreshHeygenSpaceProof: proof => { assert.equal(proofBrand.has(proof), true); return proof; },
      assertFreshHeygenBootstrapProof: proof => { assert.equal(proofBrand.has(proof), true); return proof; },
    });
    providerBinding = await bindingRepository.bootstrapVerifiedHeygenSpaceBinding({
      accountId,
      privateEvidenceDir: process.platform === 'win32' ? 'C:\\provider-ledger-fixture' : '/provider-ledger-fixture',
    });
    assert.equal(providerBinding.applicationAccountId, accountId);
    assert.equal(providerBinding.credentialScopeFingerprint, credentialScopeFingerprint);

    const operationInput = {
      accountId,
      providerBinding,
      kind: 'asset_upload',
      originOperationKey: `asset-upload:${randomUUID()}`,
      correlationId: randomUUID(),
      enrollmentId,
      identityId,
      requestDigest: providerOperationRequestDigest({ action: 'asset-upload', photoSha256 }),
      sourceSha256: photoSha256,
      sourceBytes: 128,
    };
    const resourceInput = {
      kind: 'asset',
      providerResourceId,
      state: 'present',
      sourceSha256: photoSha256,
      sourceBytes: 128,
      publicUrlDigest: digest(`temporary-public-url:${providerResourceId}`),
      privateEvidenceRef: `provider-ledger/${accountId}/synthetic-asset.json`,
      evidenceExpiresAt,
    };

    const accepted = await withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
      const reserved = await reserveProviderOperationTx(tx, operationInput);
      assert.equal(reserved.replayed, false);
      assert.equal(reserved.operation.state, 'pending');
      const recorded = await recordProviderOperationResourcesTx(tx, {
        accountId,
        operationId: reserved.operation.id,
        resources: [resourceInput],
      });
      assert.equal(recorded.operation.state, 'succeeded');
      assert.equal(recorded.conflicts.length, 0);
      assert.equal(recorded.resources[0].providerResourceId, providerResourceId);
      const ready = await markProviderResourceReadyTx(tx, { accountId, resourceId: recorded.resources[0].id });
      const reference = await attachProviderConsumerReferenceTx(tx, {
        accountId,
        resourceId: ready.id,
        consumerKind: 'identity',
        consumerId: identityId,
        originOperationId: reserved.operation.id,
      });
      return { operationId: reserved.operation.id, resourceId: ready.id, referenceId: reference.id };
    });

    await withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
      const replay = await reserveProviderOperationTx(tx, operationInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.operation.id, accepted.operationId);
      const resourceReplay = await recordProviderOperationResourcesTx(tx, {
        accountId,
        operationId: replay.operation.id,
        resources: [resourceInput],
      });
      assert.equal(resourceReplay.conflicts.length, 0);
      assert.equal(resourceReplay.resources[0].id, accepted.resourceId);
      assert.equal(resourceReplay.resources[0].state, 'ready');
    });

    const terminalConflict = await withProviderLifecycleLock(accountId, async tx => {
      const recorded = await recordProviderOperationResourcesTx(tx, {
        accountId,
        operationId: accepted.operationId,
        resources: [{
          ...resourceInput,
          providerResourceId: terminalConflictProviderResourceId,
          sourceSha256: digest('wrong-terminal-media-source'),
        }],
      });
      assert.equal(recorded.operation.state, 'succeeded');
      assert.equal(recorded.resources.length, 0);
      assert.equal(recorded.conflicts[0].reason, 'OPERATION_RESOURCE_SOURCE_MISMATCH');
      return recorded.operation;
    }, { executor: db });
    assert.equal(terminalConflict.id, accepted.operationId);

    const retainedTerminalConflict = await pool.query(`
      select id, observed_provider_resource_id, event_type
      from provider_lifecycle_events
      where operation_id = $1 and event_type = 'provider.resource_source_conflict'
    `, [accepted.operationId]);
    assert.equal(retainedTerminalConflict.rows.length, 1);
    assert.equal(retainedTerminalConflict.rows[0].observed_provider_resource_id, terminalConflictProviderResourceId);

    const conflict = await withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, async tx => {
      const reserved = await reserveProviderOperationTx(tx, {
        ...operationInput,
        originOperationKey: `asset-upload:${randomUUID()}`,
        correlationId: randomUUID(),
        requestDigest: providerOperationRequestDigest({ action: 'asset-upload-conflict', photoSha256 }),
      });
      const recorded = await recordProviderOperationResourcesTx(tx, {
        accountId,
        operationId: reserved.operation.id,
        resources: [{ ...resourceInput, providerResourceId: conflictingProviderResourceId, sourceSha256: digest('wrong-media-source') }],
      });
      assert.equal(recorded.operation.state, 'ambiguous');
      assert.equal(recorded.resources.length, 0);
      assert.equal(recorded.conflicts[0].reason, 'OPERATION_RESOURCE_SOURCE_MISMATCH');
      return { operationId: reserved.operation.id };
    });

    const retainedConflict = await pool.query(`
      select observed_provider_resource_id, event_type
      from provider_lifecycle_events
      where operation_id = $1 and event_type = 'provider.resource_source_conflict'
    `, [conflict.operationId]);
    assert.deepEqual(retainedConflict.rows, [{
      observed_provider_resource_id: conflictingProviderResourceId,
      event_type: 'provider.resource_source_conflict',
    }]);

    await assert.rejects(withProviderLifecycleLock(accountId, tx => tx.update(schema.providerResources).set({
      state: 'delete_claimed',
      tombstonedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.providerResources.id, accepted.resourceId)), { executor: db }), error => {
      assert.equal(error?.cause?.code, '23514');
      assert.match(String(error?.cause?.message || ''), /unreleased consumer cannot be tombstoned/i);
      return true;
    });

    const snapshot = await getProviderReconciliationSnapshot({
      accountId,
      enrollmentId,
      candidate: { sourceSha256: candidateSourceSha256, adapterSha256 },
      target: { environment: binding.environment, projectId: binding.projectId, databaseBindingSha256 },
    }, { executor: db });
    assert.equal(snapshot.candidate.sourceSha256, candidateSourceSha256);
    assert.notEqual(snapshot.candidate.sourceSha256, photoSha256);
    assert.equal(snapshot.target.providerAccountBindingState, 'verified');
    const snapResource = snapshot.resources.find(item => item.resourceKey === accepted.resourceId);
    assert.equal(snapResource.providerResourceId, providerResourceId);
    assert.equal(snapResource.sourceSha256, photoSha256);
    assert.equal(snapResource.sourceBytes, 128);
    assert.equal(snapResource.state, 'ready');
    assert.equal(snapshot.resources.some(item => item.providerResourceId === terminalConflictProviderResourceId), false);
    assert.ok(snapshot.references.some(item => item.referenceId === accepted.referenceId && item.state === 'active'));
    assert.equal(snapshot.operations.filter(item => item.operationId.startsWith('source-conflict:')).length, 0);
    assert.ok(snapshot.operations.some(item => item.operationId === accepted.operationId && item.state === 'succeeded'));
    assert.ok(snapshot.operations.some(item => item.operationId === conflict.operationId && item.state === 'ambiguous'));
    assert.ok(snapshot.operations.some(item => item.operationId === `event-conflict:${retainedTerminalConflict.rows[0].id}`
      && item.kind === 'resource_read' && item.state === 'ambiguous' && item.resourceKeys.length === 0));
    const plan = createReconciliationPlan(snapshot, {
      requestedActions: [{ resourceKey: accepted.resourceId, verbs: ['read', 'readback'] }],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      cohortId: `synthetic-live-${randomUUID()}`,
    });
    assert.ok(plan.blockers.some(item => item.code === 'UNRESOLVED_OPERATION_WITHOUT_RESOURCE'));
  } finally {
    // Append-only/RESTRICT ledger evidence intentionally remains for the
    // guarded runner's whole-schema TRUNCATE cleanup.
    await pool.end();
  }
});
