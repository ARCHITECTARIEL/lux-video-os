import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

import { providerLifecycleLockInput } from '../db/provider-lifecycle-lock.js';
import { validateTarget } from '../tools/check-migrations.mjs';

const LIVE = process.env.VIDEO_OS_ISOLATED_LIVE === '1';
const digest = value => createHash('sha256').update(String(value), 'utf8').digest('hex');

async function beginGuarded(client, accountId) {
  await client.query('begin');
  // This must remain the first statement after BEGIN. Trigger enforcement then
  // proves the same canonical transaction-level advisory lock is held.
  await client.query(
    'select pg_advisory_xact_lock(hashtextextended($1, 0))',
    [providerLifecycleLockInput(accountId)],
  );
}

async function guarded(pool, accountId, callback) {
  const client = await pool.connect();
  try {
    await beginGuarded(client, accountId);
    const value = await callback(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejected(pool, accountId, callback, expected) {
  const client = await pool.connect();
  try {
    await beginGuarded(client, accountId);
    await assert.rejects(callback(client), error => {
      assert.match(String(error?.message || error), expected);
      return true;
    });
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

test('isolated live DB: provider ledger triggers enforce immutable scoped lifecycle evidence', {
  skip: !LIVE && 'Run only through the guarded isolated-live runner.',
  timeout: 120000,
}, async () => {
  const target = JSON.parse(await readFile(new URL('../config/database-target.verification.json', import.meta.url), 'utf8'));
  const validated = validateTarget(process.env.DATABASE_URL, target, 'verification');
  const targetUrl = new URL(process.env.DATABASE_URL);
  assert.equal(validated.database, 'mvp_verification_20260930');
  assert.equal(targetUrl.pathname, '/mvp_verification_20260930');
  assert.ok(target.hosts.includes(targetUrl.hostname));
  assert.match(targetUrl.pathname, /^\/mvp_verification_\d{8}$/);

  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });

  const accountId = `provider-ledger-${randomUUID()}`;
  const otherAccountId = `provider-ledger-other-${randomUUID()}`;
  const otherJobId = `provider-ledger-job-${randomUUID()}`;
  const photoAssetId = randomUUID();
  const voiceAssetId = randomUUID();
  const identityId = randomUUID();
  const originScopeKey = digest(`origin:${accountId}`);
  const bindingId = randomUUID();
  const secondBindingId = randomUUID();
  const verifiedScopeId = randomUUID();
  const promotionId = randomUUID();
  const groupOperationId = randomUUID();
  const assetOperationId = randomUUID();
  const voiceOperationId = randomUUID();
  const secondBindingOperationId = randomUUID();
  const groupResourceId = randomUUID();
  const lookResourceId = randomUUID();
  const assetResourceId = randomUUID();
  const voiceResourceId = randomUUID();
  const referenceId = randomUUID();
  const assetReferenceId = randomUUID();
  const initialEventId = randomUUID();
  const approvalId = randomUUID();
  const zeroBudgetApprovalId = randomUUID();
  const zeroBudgetOperationId = randomUUID();
  const revocationApprovalId = randomUUID();
  const secondApprovedAttemptId = randomUUID();
  const deleteOperationId = randomUUID();
  const sourceSha256 = digest(`source:${accountId}`);
  const adapterSha256 = digest('adapter:v1');
  const createdRows = {
    accountId,
    otherAccountId,
    bindingId,
    secondBindingId,
    verifiedScopeId,
    promotionId,
    operationIds: [groupOperationId, assetOperationId, voiceOperationId, secondBindingOperationId, deleteOperationId],
    resourceIds: [groupResourceId, lookResourceId, assetResourceId, voiceResourceId],
    approvalId,
  };

  try {
    const catalog = await pool.query(`
      select tgname
      from pg_trigger
      where not tgisinternal
        and tgname = any($1::text[])
      order by tgname
    `, [[
      'provider_account_bindings_guard_trg',
      'provider_verified_account_scopes_append_only_trg',
      'provider_binding_promotions_guard_trg',
      'provider_verified_promotion_complete_trg',
      'provider_approval_claims_guard_trg',
      'provider_lifecycle_operations_guard_trg',
      'provider_resources_guard_trg',
      'provider_resource_parent_graph_trg',
      'provider_consumer_references_guard_trg',
      'provider_lifecycle_events_guard_trg',
      'provider_approval_claim_resources_guard_trg',
    ]]);
    assert.equal(catalog.rows.length, 11, 'isolated target must contain every reviewed provider ledger trigger');

    const canonicalInput = providerLifecycleLockInput(accountId);
    const keyProof = await pool.query(`
      select
        public.provider_lifecycle_guard_key($1) as guarded_key,
        hashtextextended($2, 0) as expected_key
    `, [accountId, canonicalInput]);
    assert.equal(String(keyProof.rows[0].guarded_key), String(keyProof.rows[0].expected_key));
    await assert.rejects(
      pool.query('select public.provider_lifecycle_guard_key($1)', [`bad\naccount`]),
      /provider lifecycle account is invalid/i,
    );
    await assert.rejects(
      pool.query('select public.provider_lifecycle_guard_key($1)', ['x'.repeat(513)]),
      /provider lifecycle account is invalid/i,
    );

    await pool.query(
      `insert into users (id, name) values ($1, 'Provider Ledger Guard Test'), ($2, 'Provider Ledger Other Account')`,
      [accountId, otherAccountId],
    );
    await pool.query(`
      insert into video_jobs (
        id, account_id, idempotency_key, correlation_id, provider, status,
        title, format, cost_credits, input, output
      ) values ($1, $2, $3, $4, 'heygen', 'queued', 'Other account fixture',
                'vertical', 0, '{}'::jsonb, '{}'::jsonb)
    `, [otherJobId, otherAccountId, randomUUID(), randomUUID()]);
    await pool.query(`
      insert into media_assets (
        id, account_id, kind, private_pathname, content_type, bytes, sha256
      ) values
        ($1, $3, 'identity-photo-source', $4, 'image/png', 128, $5),
        ($2, $3, 'identity-voice-source', $6, 'audio/wav', 256, $7)
    `, [
      photoAssetId,
      voiceAssetId,
      accountId,
      `video-os/provider-ledger/${accountId}/photo.png`,
      digest('bridge-photo'),
      `video-os/provider-ledger/${accountId}/voice.wav`,
      digest('bridge-voice'),
    ]);
    await pool.query(`
      insert into user_identities (
        id, account_id, display_name, source_photo_asset_id, source_voice_asset_id
      ) values ($1, $2, 'Bridge NULL-purpose guard fixture', $3, $4)
    `, [identityId, accountId, photoAssetId, voiceAssetId]);
    await assert.rejects(pool.query(`
      insert into identity_consents (
        account_id, identity_id, idempotency_key,
        audio_extraction_authorization, face_authorization, voice_authorization,
        provider_processing_authorization, archive_delete_acknowledgment,
        temporary_public_provider_exposure_authorization, policy_version,
        consent_purpose, photo_sha256, source_video_sha256, voice_sha256
      ) values ($1, $2, $3, true, true, true, true, true, true,
                'identity-provider-bridge-v2', null, $4, $5, $6)
    `, [
      accountId,
      identityId,
      randomUUID(),
      digest('bridge-photo'),
      digest('bridge-video'),
      digest('bridge-voice'),
    ]), /identity_consents_bridge_v2_ck|check constraint/i);

    const unlocked = await pool.connect();
    try {
      await unlocked.query('begin');
      await assert.rejects(unlocked.query(`
        insert into provider_account_bindings (
          id, application_account_id, environment, project_id,
          database_binding_sha256, credential_scope_fingerprint, origin_scope_key
        ) values ($1, $2, 'verification', 'missing-lock', $3, $4, $5)
      `, [randomUUID(), accountId, digest('missing-lock-db'), digest('missing-lock-credential'), digest('missing-lock-origin')]),
      /account guard must be acquired/i);
    } finally {
      await unlocked.query('rollback').catch(() => {});
      unlocked.release();
    }

    await guarded(pool, accountId, async client => {
      await client.query(`
        insert into provider_account_bindings (
          id, application_account_id, environment, project_id,
          database_binding_sha256, credential_scope_fingerprint, origin_scope_key,
          credential_evidence_digest, credential_evidence_ref
        ) values ($1, $2, 'verification', 'video-os-isolated', $3, $4, $5, $6, $7)
      `, [
        bindingId,
        accountId,
        digest('database-binding-a'),
        digest('credential-scope-a'),
        originScopeKey,
        digest('credential-evidence-a'),
        `provider-ledger/${accountId}/binding.json`,
      ]);
      await client.query(`
        insert into provider_verified_account_scopes (
          id, provider_account_fingerprint, canonical_scope_key, evidence_digest, evidence_ref
        ) values ($1, $2, $3, $4, $5)
      `, [
        verifiedScopeId,
        digest('provider-account-a'),
        digest('canonical-provider-account-a'),
        digest('verified-scope-evidence-a'),
        `provider-ledger/${accountId}/scope.json`,
      ]);
      await client.query(`
        insert into provider_account_binding_promotions (
          id, binding_id, application_account_id, origin_scope_key,
          verified_account_scope_id, state, evidence_digest, evidence_ref,
          observed_at, verified_at
        ) values ($1, $2, $3, $4, $5, 'verified', $6, $7, now(), now())
      `, [
        promotionId,
        bindingId,
        accountId,
        originScopeKey,
        verifiedScopeId,
        digest('promotion-a'),
        `provider-ledger/${accountId}/promotion.json`,
      ]);
      await client.query(`
        insert into provider_lifecycle_operations (
          id, application_account_id, binding_id, origin_scope_key, kind, state,
          origin_operation_key, attempt, correlation_id, request_digest,
          source_sha256, source_bytes
        ) values
          ($1, $3, $4, $5, 'avatar_create', 'reserved', $6, 1, $7, $8, $12, 128),
          ($2, $3, $4, $5, 'asset_upload', 'reserved', $9, 1, $10, $11, $12, 128)
      `, [
        groupOperationId,
        assetOperationId,
        accountId,
        bindingId,
        originScopeKey,
        `group-create:${randomUUID()}`,
        randomUUID(),
        digest('group-create-request'),
        `asset-upload:${randomUUID()}`,
        randomUUID(),
        digest('asset-upload-request'),
        sourceSha256,
      ]);
      await client.query(`
        insert into provider_lifecycle_operations (
          id, application_account_id, binding_id, origin_scope_key, kind, state,
          origin_operation_key, attempt, correlation_id, request_digest,
          source_sha256, source_bytes
        ) values ($1, $2, $3, $4, 'voice_clone', 'reserved', $5, 1, $6, $7, $8, 128)
      `, [
        voiceOperationId,
        accountId,
        bindingId,
        originScopeKey,
        `voice-create:${randomUUID()}`,
        randomUUID(),
        digest('voice-create-request'),
        sourceSha256,
      ]);
      await client.query(`
        update provider_lifecycle_operations
        set state = 'pending', submitted_at = now(), updated_at = now()
        where id in ($1, $2, $3)
      `, [groupOperationId, assetOperationId, voiceOperationId]);
      await client.query(`
        update provider_lifecycle_operations
        set state = 'succeeded', completed_at = now(), updated_at = now()
        where id in ($1, $2, $3)
      `, [groupOperationId, assetOperationId, voiceOperationId]);
      await client.query(`
        insert into provider_resources (
          id, application_account_id, binding_id, origin_scope_key,
          verified_account_scope_id, kind, provider_resource_id,
          origin_operation_id, state, source_sha256, source_bytes
        ) values ($1, $2, $3, $4, $5, 'avatar_group', $6, $7, 'ready', $8, 128)
      `, [groupResourceId, accountId, bindingId, originScopeKey, verifiedScopeId, `group-${randomUUID()}`, groupOperationId, sourceSha256]);
      await client.query(`
        insert into provider_resources (
          id, application_account_id, binding_id, origin_scope_key,
          verified_account_scope_id, kind, provider_resource_id,
          origin_operation_id, parent_resource_id, state, source_sha256, source_bytes
        ) values ($1, $2, $3, $4, $5, 'avatar_look', $6, $7, $8, 'ready', $9, 128)
      `, [lookResourceId, accountId, bindingId, originScopeKey, verifiedScopeId, `look-${randomUUID()}`, groupOperationId, groupResourceId, sourceSha256]);
      await client.query(`
        insert into provider_resources (
          id, application_account_id, binding_id, origin_scope_key,
          verified_account_scope_id, kind, provider_resource_id,
          origin_operation_id, state, source_sha256, source_bytes
        ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', $8, 128)
      `, [assetResourceId, accountId, bindingId, originScopeKey, verifiedScopeId, `asset-${randomUUID()}`, assetOperationId, sourceSha256]);
      await client.query(`
        insert into provider_resources (
          id, application_account_id, binding_id, origin_scope_key,
          verified_account_scope_id, kind, provider_resource_id,
          origin_operation_id, voice_namespace, state, source_sha256, source_bytes
        ) values ($1, $2, $3, $4, $5, 'voice', $6, $7, 'instant', 'ready', $8, 128)
      `, [voiceResourceId, accountId, bindingId, originScopeKey, verifiedScopeId, `voice-${randomUUID()}`, voiceOperationId, sourceSha256]);
      await client.query(`
        insert into provider_consumer_references (
          id, application_account_id, origin_scope_key, resource_id,
          consumer_kind, consumer_id, origin_operation_id
        ) values ($1, $2, $3, $4, 'template', $5, $6)
      `, [referenceId, accountId, originScopeKey, groupResourceId, `template-${randomUUID()}`, groupOperationId]);
      await client.query(`
        insert into provider_consumer_references (
          id, application_account_id, origin_scope_key, resource_id,
          consumer_kind, consumer_id, origin_operation_id
        ) values ($1, $2, $3, $4, 'template', $5, $6)
      `, [assetReferenceId, accountId, originScopeKey, assetResourceId, `asset-template-${randomUUID()}`, assetOperationId]);
      await client.query(`
        insert into provider_lifecycle_events (
          id, application_account_id, origin_scope_key, operation_id,
          resource_id, reference_id, event_type, correlation_id, path_template, details
        ) values ($1, $2, $3, $4, $5, $6, 'fixture.created', $7,
                  '/v2/avatar_group/{id}', '{}'::jsonb)
      `, [initialEventId, accountId, originScopeKey, groupOperationId, groupResourceId, referenceId, randomUUID()]);
    });

    await rejected(pool, accountId, client => client.query(
      `update provider_account_bindings set project_id = 'retargeted' where id = $1`,
      [bindingId],
    ), /origin and target facts are immutable/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_account_bindings (
        id, application_account_id, environment, project_id,
        database_binding_sha256, credential_scope_fingerprint, origin_scope_key,
        credential_evidence_digest
      ) values ($1, $2, 'verification', 'partial-evidence', $3, $4, $5, $6)
    `, [
      randomUUID(), accountId, digest('partial-evidence-db'),
      digest('partial-evidence-credential'), digest('partial-evidence-origin'),
      digest('partial-evidence-digest'),
    ]), /credential evidence must be complete/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_account_bindings (
        id, application_account_id, environment, project_id,
        database_binding_sha256, credential_scope_fingerprint, origin_scope_key,
        credential_evidence_digest, credential_evidence_ref
      ) values ($1, $2, 'verification', 'raw-evidence', $3, $4, $5, $6, $7)
    `, [
      randomUUID(), accountId, digest('raw-evidence-db'),
      digest('raw-evidence-credential'), digest('raw-evidence-origin'),
      digest('raw-evidence-digest'), 'data:text/plain,secret',
    ]), /evidence reference is not an internal path/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_verified_account_scopes (
        id, provider_account_fingerprint, canonical_scope_key, evidence_digest, evidence_ref
      ) values ($1, $2, $3, $4, $5)
    `, [
      randomUUID(), digest(`bad-scope-account:${randomUUID()}`),
      digest(`bad-scope-key:${randomUUID()}`), digest('bad-scope-evidence'),
      'javascript:alert(1)',
    ]), /scope evidence reference is not an internal path/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_account_binding_promotions (
        id, binding_id, application_account_id, origin_scope_key,
        state, evidence_digest, evidence_ref, observed_at
      ) values ($1, $2, $3, $4, 'conflict', $5, $6, now())
    `, [
      randomUUID(), bindingId, accountId, originScopeKey,
      digest('bad-promotion-evidence'), 'provider-ledger/../escape.json',
    ]), /promotion evidence reference is not an internal path/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_account_bindings (
        id, application_account_id, environment, project_id,
        database_binding_sha256, credential_scope_fingerprint, origin_scope_key,
        lifecycle_state, revoked_at
      ) values ($1, $2, 'verification', 'already-revoked', $3, $4, $5, 'revoked', now())
    `, [
      randomUUID(), accountId, digest('revoked-insert-db'),
      digest('revoked-insert-credential'), digest('revoked-insert-origin'),
    ]), /must be inserted active/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, request_digest, submitted_at, completed_at
      ) values ($1, $2, $3, $4, 'avatar_create', 'succeeded', $5, $6, $7, now(), now())
    `, [
      randomUUID(), accountId, bindingId, originScopeKey,
      `fabricated-terminal:${randomUUID()}`, randomUUID(), digest('fabricated-terminal'),
    ]), /must be inserted reserved before remote work/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_lifecycle_operations set request_digest = $2 where id = $1`,
      [assetOperationId, digest('changed-request')],
    ), /request.*immutable/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_resources set provider_resource_id = $2 where id = $1`,
      [assetResourceId, `changed-${randomUUID()}`],
    ), /resource origin.*immutable/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_resources set verified_account_scope_id = null where id = $1`,
      [groupResourceId],
    ), /active verified scope|cannot be cleared/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, request_digest, source_sha256
      ) values ($1, $2, $3, $4, 'asset_upload', 'reserved', $5, $6, $7, $8)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey,
      `partial-operation-source:${randomUUID()}`, randomUUID(),
      digest('partial-operation-source-request'), sourceSha256,
    ]), /source digest and byte count must be a complete positive pair/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, request_digest, source_bytes
      ) values ($1, $2, $3, $4, 'asset_upload', 'reserved', $5, $6, $7, 128)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey,
      `partial-operation-bytes:${randomUUID()}`, randomUUID(),
      digest('partial-operation-bytes-request'),
    ]), /source digest and byte count must be a complete positive pair/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, source_sha256
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', $8)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `partial-resource-source-${randomUUID()}`, assetOperationId, sourceSha256,
    ]), /source digest and byte count must be a complete positive pair/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, source_bytes
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', 128)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `partial-resource-bytes-${randomUUID()}`, assetOperationId,
    ]), /source digest and byte count must be a complete positive pair/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, source_sha256, source_bytes
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', $8, 128)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `mismatched-resource-source-${randomUUID()}`, assetOperationId,
      digest('different-source'),
    ]), /source provenance must exactly match its origin operation/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready')
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `missing-resource-source-${randomUUID()}`, assetOperationId,
    ]), /source provenance must exactly match its origin operation/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, voice_namespace
      ) values ($1, $2, $3, $4, $5, 'voice', $6, $7, 'ready', null)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `voice-null-namespace-${randomUUID()}`, voiceOperationId,
    ]), /voice namespace must be exactly instant/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, public_url_digest
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', $8)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `partial-url-evidence-${randomUUID()}`, assetOperationId,
      digest('partial-public-url'),
    ]), /public URL evidence requires a private evidence reference and retention deadline/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, state, private_evidence_ref
      ) values ($1, $2, $3, $4, $5, 'asset', $6, $7, 'ready', $8)
    `, [
      randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId,
      `raw-resource-evidence-${randomUUID()}`, assetOperationId,
      'https://provider.example/raw',
    ]), /resource evidence reference is not an internal path/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_resources (
        id, application_account_id, binding_id, origin_scope_key,
        verified_account_scope_id, kind, provider_resource_id,
        origin_operation_id, parent_resource_id, state, source_sha256, source_bytes
      ) values ($1, $2, $3, $4, $5, 'avatar_look', $6, $7, $8, 'ready', $9, 128)
    `, [randomUUID(), accountId, bindingId, originScopeKey, verifiedScopeId, `bad-look-${randomUUID()}`, groupOperationId, assetResourceId, sourceSha256]),
    /parent must be a group/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, job_id, request_digest
      ) values ($1, $2, $3, $4, 'video_create', 'reserved', $5, $6, $7, $8)
    `, [randomUUID(), accountId, bindingId, originScopeKey, `wrong-job:${randomUUID()}`, randomUUID(), otherJobId, digest('wrong-account-job')]),
    /job belongs to another account/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_consumer_references (
        id, application_account_id, origin_scope_key, resource_id,
        consumer_kind, consumer_id, origin_operation_id
      ) values ($1, $2, $3, $4, 'job', $5, $6)
    `, [randomUUID(), accountId, originScopeKey, groupResourceId, otherJobId, groupOperationId]),
    /job consumer belongs to another account/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_events (
        id, application_account_id, origin_scope_key, operation_id,
        event_type, correlation_id, observed_resource_kind, details
      ) values ($1, $2, $3, $4, 'partial_observed_identity', $5, 'asset', '{}'::jsonb)
    `, [randomUUID(), accountId, originScopeKey, assetOperationId, randomUUID()]),
    /observed resource identity must be complete/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_events (
        id, application_account_id, origin_scope_key, operation_id,
        resource_id, event_type, correlation_id,
        observed_resource_kind, observed_provider_resource_id, details
      ) values ($1, $2, $3, $4, $5, 'mismatched_observed_identity', $6,
                'video', $7, '{}'::jsonb)
    `, [
      randomUUID(), accountId, originScopeKey, assetOperationId,
      assetResourceId, randomUUID(), `invented-${randomUUID()}`,
    ]), /observed identity does not match its resource/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_events (
        id, application_account_id, origin_scope_key, operation_id,
        event_type, correlation_id, private_evidence_ref, details
      ) values ($1, $2, $3, $4, 'raw_evidence_ref', $5, $6, '{}'::jsonb)
    `, [
      randomUUID(), accountId, originScopeKey, assetOperationId,
      randomUUID(), 'provider.example/path',
    ]), /event evidence reference is not an internal path/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_events (
        id, application_account_id, origin_scope_key, operation_id,
        event_type, correlation_id, path_template, details
      ) values ($1, $2, $3, $4, 'unsafe_path_template', $5, $6, '{}'::jsonb)
    `, [
      randomUUID(), accountId, originScopeKey, assetOperationId,
      randomUUID(), '/v2/assets/{id}?token=secret',
    ]), /path template is not a fixed internal template/i);

    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_consumer_references
        set state = 'pending', release_claimed_at = now()
        where id = $1
      `, [referenceId]);
      await client.query(`
        update provider_consumer_references
        set state = 'released', released_at = now()
        where id = $1
      `, [referenceId]);
    });
    await rejected(pool, accountId, client => client.query(
      `update provider_consumer_references set state = 'active', release_claimed_at = null, released_at = null where id = $1`,
      [referenceId],
    ), /attachment identity is immutable|transition is not allowed|timestamp is immutable/i);
    await guarded(pool, accountId, client => client.query(`
      update provider_resources
      set state = 'pending_reconciliation', updated_at = now()
      where id = $1
    `, [groupResourceId]));
    await rejected(pool, accountId, client => client.query(`
      insert into provider_consumer_references (
        id, application_account_id, origin_scope_key, resource_id,
        consumer_kind, consumer_id, origin_operation_id
      ) values ($1, $2, $3, $4, 'template', $5, $6)
    `, [
      randomUUID(), accountId, originScopeKey, groupResourceId,
      `uncertain-template-${randomUUID()}`, groupOperationId,
    ]), /cannot attach to a tombstoned or uncertain resource/i);
    await guarded(pool, accountId, client => client.query(`
      update provider_resources set state = 'ready', updated_at = now() where id = $1
    `, [groupResourceId]));

    await guarded(pool, accountId, async client => {
      await client.query(`
        insert into provider_approval_claims (
          id, application_account_id, binding_id, origin_scope_key,
          nonce_digest, plan_digest, approval_kid, approval_envelope_digest,
          candidate_id, source_sha256, adapter_sha256, target_digest, cohort_id,
          max_provider_calls, max_spend_microusd, issued_at, expires_at
        ) values ($1, $2, $3, $4, $5, $6, 'owner-key-v1', $7,
                  $8, $9, $10, $11, 'isolated-canary', 3, 1000, now(), now() + interval '1 hour')
      `, [
        approvalId,
        accountId,
        bindingId,
        originScopeKey,
        digest(`nonce:${approvalId}`),
        digest(`plan:${approvalId}`),
        digest(`envelope:${approvalId}`),
        `source:${sourceSha256}`,
        sourceSha256,
        adapterSha256,
        digest(`target:${bindingId}`),
      ]);
      for (const verb of ['read', 'delete', 'readback']) {
        await client.query(`
          insert into provider_approval_claim_resources (
            claim_id, resource_id, application_account_id, origin_scope_key, verb
          ) values ($1, $2, $3, $4, $5)
        `, [approvalId, assetResourceId, accountId, originScopeKey, verb]);
      }
      for (const [claimId, resourceId, label] of [
        [zeroBudgetApprovalId, lookResourceId, 'zero-budget'],
        [revocationApprovalId, groupResourceId, 'revocation'],
      ]) {
        await client.query(`
          insert into provider_approval_claims (
            id, application_account_id, binding_id, origin_scope_key,
            nonce_digest, plan_digest, approval_kid, approval_envelope_digest,
            candidate_id, source_sha256, adapter_sha256, target_digest, cohort_id,
            max_provider_calls, max_spend_microusd, issued_at, expires_at
          ) values ($1, $2, $3, $4, $5, $6, 'owner-key-v1', $7,
                    $8, $9, $10, $11, 'isolated-canary', 2, 0,
                    now(), now() + interval '1 hour')
        `, [
          claimId,
          accountId,
          bindingId,
          originScopeKey,
          digest(`nonce:${label}:${claimId}`),
          digest(`plan:${label}:${claimId}`),
          digest(`envelope:${label}:${claimId}`),
          `source:${sourceSha256}`,
          sourceSha256,
          adapterSha256,
          digest(`target:${label}:${bindingId}`),
        ]);
        await client.query(`
          insert into provider_approval_claim_resources (
            claim_id, resource_id, application_account_id, origin_scope_key, verb
          ) values ($1, $2, $3, $4, 'read')
        `, [claimId, resourceId, accountId, originScopeKey]);
      }
    });

    await rejected(pool, accountId, client => client.query(`
      insert into provider_approval_claims (
        id, application_account_id, binding_id, origin_scope_key,
        nonce_digest, plan_digest, approval_kid, approval_envelope_digest,
        candidate_id, source_sha256, adapter_sha256, target_digest, cohort_id,
        max_provider_calls, max_spend_microusd, issued_at, expires_at
      ) values ($1, $2, $3, $4, $5, $6, 'owner-key-v1', $7,
                $8, $9, $10, $11, 'isolated-canary', 3, $12::bigint,
                now(), now() + interval '1 hour')
    `, [
      randomUUID(), accountId, bindingId, originScopeKey,
      digest(`nonce:unsafe:${randomUUID()}`), digest(`plan:unsafe:${randomUUID()}`),
      digest(`envelope:unsafe:${randomUUID()}`), `source:${sourceSha256}`,
      sourceSha256, adapterSha256, digest(`target:unsafe:${randomUUID()}`),
      '9007199254740992',
    ]), /safe integers/i);

    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_approval_claims
        set consumed_at = now(), used_provider_calls = 1
        where id = $1
      `, [approvalId]);
      await client.query(`
        insert into provider_lifecycle_operations (
          id, application_account_id, binding_id, origin_scope_key, kind, state,
          origin_operation_key, correlation_id, request_digest,
          source_sha256, source_bytes, approval_claim_id
        ) values ($1, $2, $3, $4, 'resource_delete', 'reserved', $5, $6, $7, $8, 128, $9)
      `, [
        deleteOperationId, accountId, bindingId, originScopeKey,
        `delete:${randomUUID()}`, randomUUID(), digest('delete-request'), sourceSha256, approvalId,
      ]);
    });
    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_approval_claims set consumed_at = now() where id = $1
      `, [zeroBudgetApprovalId]);
      await client.query(`
        insert into provider_lifecycle_operations (
          id, application_account_id, binding_id, origin_scope_key, kind, state,
          origin_operation_key, correlation_id, request_digest, approval_claim_id
        ) values ($1, $2, $3, $4, 'resource_read', 'reserved', $5, $6, $7, $8)
      `, [
        zeroBudgetOperationId, accountId, bindingId, originScopeKey,
        `zero-budget-read:${randomUUID()}`, randomUUID(), digest('zero-budget-read'), zeroBudgetApprovalId,
      ]);
    });
    await rejected(pool, accountId, client => client.query(`
      update provider_lifecycle_operations
      set state = 'pending', submitted_at = now(), updated_at = now()
      where id = $1
    `, [zeroBudgetOperationId]), /exceeds its reserved provider-call budget/i);

    await rejected(pool, accountId, client => client.query(`
      insert into provider_approval_claim_resources (
        claim_id, resource_id, application_account_id, origin_scope_key, verb
      ) values ($1, $2, $3, $4, 'read')
    `, [approvalId, groupResourceId, accountId, originScopeKey]), /cannot widen after consumption/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_approval_claims set used_provider_calls = 0 where id = $1`,
      [approvalId],
    ), /budget usage cannot decrease/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_approval_claims set plan_digest = $2 where id = $1`,
      [approvalId, digest('changed-plan')],
    ), /identity, target, scope.*immutable/i);

    await rejected(pool, accountId, client => client.query(`
      update provider_resources
      set state = 'delete_claimed', tombstoned_at = now(), updated_at = now()
      where id = $1
    `, [assetResourceId]), /unreleased consumer cannot be tombstoned/i);
    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_consumer_references
        set state = 'pending', release_claimed_at = now()
        where id = $1
      `, [assetReferenceId]);
      await client.query(`
        update provider_consumer_references
        set state = 'released', released_at = now()
        where id = $1
      `, [assetReferenceId]);
    });

    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_resources
        set state = 'delete_claimed', tombstoned_at = now(), updated_at = now()
        where id = $1
      `, [assetResourceId]);
      await client.query(`
        update provider_lifecycle_operations
        set state = 'pending', submitted_at = now(), updated_at = now()
        where id = $1
      `, [deleteOperationId]);
    });
    await rejected(pool, accountId, client => client.query(`
      insert into provider_consumer_references (
        id, application_account_id, origin_scope_key, resource_id,
        consumer_kind, consumer_id, origin_operation_id
      ) values ($1, $2, $3, $4, 'template', $5, $6)
    `, [randomUUID(), accountId, originScopeKey, assetResourceId, `late-template-${randomUUID()}`, assetOperationId]),
    /cannot attach to a tombstoned or uncertain resource/i);
    await rejected(pool, accountId, client => client.query(
      `update provider_resources set state = 'ready', updated_at = now() where id = $1`,
      [assetResourceId],
    ), /lifecycle transition is not allowed|tombstone requires/i);

    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_lifecycle_operations
        set state = 'ambiguous', completed_at = now(), updated_at = now()
        where id = $1
      `, [deleteOperationId]);
    });
    await rejected(pool, accountId, client => client.query(
      `update provider_lifecycle_operations set state = 'pending', completed_at = null, updated_at = now() where id = $1`,
      [deleteOperationId],
    ), /lifecycle transition is not allowed|completion timestamp is immutable/i);
    await guarded(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, request_digest, approval_claim_id
      ) values ($1, $2, $3, $4, 'resource_read', 'reserved', $5, $6, $7, $8)
    `, [
      secondApprovedAttemptId, accountId, bindingId, originScopeKey,
      `second-approved-read:${randomUUID()}`, randomUUID(),
      digest('second-approved-read'), approvalId,
    ]));
    await rejected(pool, accountId, client => client.query(`
      update provider_lifecycle_operations
      set state = 'pending', submitted_at = now(), updated_at = now()
      where id = $1
    `, [secondApprovedAttemptId]), /exceeds its reserved provider-call budget/i);

    await rejected(pool, accountId, client => client.query(
      `update provider_lifecycle_events set details = '{"tampered":true}'::jsonb where id = $1`,
      [initialEventId],
    ), /append-only/i);
    await rejected(pool, accountId, client => client.query(
      `delete from provider_verified_account_scopes where id = $1`,
      [verifiedScopeId],
    ), /append-only/i);
    await rejected(pool, accountId, client => client.query(
      `delete from provider_approval_claim_resources where claim_id = $1 and resource_id = $2 and verb = 'delete'`,
      [approvalId, assetResourceId],
    ), /append-only/i);

    await guarded(pool, accountId, async client => {
      await client.query(`
        insert into provider_account_bindings (
          id, application_account_id, environment, project_id,
          database_binding_sha256, credential_scope_fingerprint, origin_scope_key
        ) values ($1, $2, 'verification', 'video-os-second-credential', $3, $4, $5)
      `, [secondBindingId, accountId, digest('database-binding-b'), digest('credential-scope-b'), originScopeKey]);
      await client.query(`
        insert into provider_lifecycle_operations (
          id, application_account_id, binding_id, origin_scope_key, kind, state,
          origin_operation_key, correlation_id, request_digest
        ) values ($1, $2, $3, $4, 'asset_upload', 'reserved', $5, $6, $7)
      `, [
        secondBindingOperationId, accountId, secondBindingId, originScopeKey,
        `second-binding-upload:${randomUUID()}`, randomUUID(), digest('second-binding-request'),
      ]);
      await client.query(`
        update provider_lifecycle_operations
        set state = 'pending', submitted_at = now(), updated_at = now()
        where id = $1
      `, [secondBindingOperationId]);
    });

    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_operations (
        id, application_account_id, binding_id, origin_scope_key, kind, state,
        origin_operation_key, correlation_id, request_digest, source_sha256,
        source_bytes, approval_claim_id
      ) values ($1, $2, $3, $4, 'resource_read', 'reserved', $5, $6, $7, $8, 128, $9)
    `, [
      randomUUID(), accountId, secondBindingId, originScopeKey,
      `wrong-binding-read:${randomUUID()}`, randomUUID(), digest('wrong-binding-read'),
      sourceSha256, approvalId,
    ]), /approval graph is invalid/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_consumer_references (
        id, application_account_id, origin_scope_key, resource_id,
        consumer_kind, consumer_id, origin_operation_id
      ) values ($1, $2, $3, $4, 'template', $5, $6)
    `, [
      randomUUID(), accountId, originScopeKey, groupResourceId,
      `wrong-binding-template-${randomUUID()}`, secondBindingOperationId,
    ]), /operation graph is invalid/i);
    await rejected(pool, accountId, client => client.query(`
      insert into provider_lifecycle_events (
        id, application_account_id, origin_scope_key, operation_id,
        resource_id, event_type, correlation_id, details
      ) values ($1, $2, $3, $4, $5, 'wrong_binding.event', $6, '{}'::jsonb)
    `, [randomUUID(), accountId, originScopeKey, secondBindingOperationId, groupResourceId, randomUUID()]),
    /resource graph is invalid/i);

    await guarded(pool, accountId, async client => {
      await client.query('savepoint duplicate_remote_id');
      await assert.rejects(client.query(`
        insert into provider_resources (
          id, application_account_id, binding_id, origin_scope_key,
          kind, provider_resource_id, origin_operation_id, state
        ) select $1, $2, $3, $4, 'asset', provider_resource_id, $5, 'present'
          from provider_resources where id = $6
      `, [randomUUID(), accountId, secondBindingId, originScopeKey, secondBindingOperationId, assetResourceId]),
      /provider_resources_origin_scope_resource_uq|duplicate key/i);
      await client.query('rollback to savepoint duplicate_remote_id');
      await client.query(`
        update provider_lifecycle_operations
        set state = 'ambiguous', completed_at = now(), updated_at = now()
        where id = $1
      `, [secondBindingOperationId]);
      await client.query(`
        insert into provider_lifecycle_events (
          application_account_id, origin_scope_key, operation_id, event_type,
          correlation_id, observed_resource_kind, observed_provider_resource_id,
          evidence_digest, details
        ) select $1, $2, $3, 'remote_id.conflict', $4, 'asset',
                 provider_resource_id, $5, '{"disposition":"held"}'::jsonb
          from provider_resources where id = $6
      `, [
        accountId, originScopeKey, secondBindingOperationId, randomUUID(),
        digest('remote-id-conflict-evidence'), assetResourceId,
      ]);
    });
    const conflictProof = await pool.query(`
      select operation.state,
             count(event.id)::int as conflict_events
      from provider_lifecycle_operations operation
      left join provider_lifecycle_events event
        on event.operation_id = operation.id and event.event_type = 'remote_id.conflict'
      where operation.id = $1
      group by operation.state
    `, [secondBindingOperationId]);
    assert.deepEqual(conflictProof.rows[0], { state: 'ambiguous', conflict_events: 1 });

    const beforePromotionConflict = await pool.query(
      `select count(*)::int as n from provider_lifecycle_events where operation_id = $1`,
      [secondBindingOperationId],
    );
    const conflictClient = await pool.connect();
    try {
      await beginGuarded(conflictClient, accountId);
      await conflictClient.query(`
        insert into provider_lifecycle_events (
          application_account_id, origin_scope_key, operation_id,
          event_type, correlation_id, details
        ) values ($1, $2, $3, 'promotion.transaction.probe', $4, '{}'::jsonb)
      `, [accountId, originScopeKey, secondBindingOperationId, randomUUID()]);
      await assert.rejects(conflictClient.query(`
        insert into provider_account_binding_promotions (
          id, binding_id, application_account_id, origin_scope_key,
          verified_account_scope_id, state, evidence_digest, evidence_ref,
          observed_at, verified_at
        ) values ($1, $2, $3, $4, $5, 'verified', $6, $7, now(), now())
      `, [
        randomUUID(), bindingId, accountId, originScopeKey, verifiedScopeId,
        digest('duplicate-promotion'), `provider-ledger/${accountId}/duplicate-promotion.json`,
      ]), /provider_binding_promotions_active_verified_uq|duplicate key/i);
    } finally {
      await conflictClient.query('rollback').catch(() => {});
      conflictClient.release();
    }
    const afterPromotionConflict = await pool.query(`
      select operation.state,
             (select count(*)::int from provider_lifecycle_events where operation_id = $1) as event_count
      from provider_lifecycle_operations operation
      where operation.id = $1
    `, [secondBindingOperationId]);
    assert.equal(afterPromotionConflict.rows[0].state, 'ambiguous');
    assert.equal(afterPromotionConflict.rows[0].event_count, beforePromotionConflict.rows[0].n);

    await guarded(pool, accountId, async client => {
      await client.query(`
        update provider_account_binding_promotions
        set state = 'revoked', revoked_at = now()
        where id = $1
      `, [promotionId]);
      await client.query(`
        update provider_resources set updated_at = now() where id = $1
      `, [groupResourceId]);
    });
    await rejected(pool, accountId, client => client.query(`
      update provider_approval_claims set consumed_at = now() where id = $1
    `, [revocationApprovalId]), /target verification is no longer active/i);
    await rejected(pool, accountId, client => client.query(`
      update provider_approval_claims set used_provider_calls = 2 where id = $1
    `, [approvalId]), /budget cannot advance after target verification is revoked/i);
    await rejected(pool, accountId, client => client.query(`
      update provider_lifecycle_operations
      set state = 'pending', submitted_at = now(), updated_at = now()
      where id = $1
    `, [secondApprovedAttemptId]), /requires an active verified target/i);

    const finalProof = await pool.query(`
      select
        (select state from provider_resources where id = $1) as resource_state,
        (select tombstoned_at is not null from provider_resources where id = $1) as tombstoned,
        (select state from provider_lifecycle_operations where id = $2) as delete_operation_state,
        (select used_provider_calls from provider_approval_claims where id = $3) as used_calls,
        (select count(*)::int from provider_approval_claim_resources where claim_id = $3) as approved_scope_rows,
        (select state from provider_account_binding_promotions where id = $4) as promotion_state,
        (select verified_account_scope_id from provider_resources where id = $5) as retained_scope
    `, [assetResourceId, deleteOperationId, approvalId, promotionId, groupResourceId]);
    assert.deepEqual(finalProof.rows[0], {
      resource_state: 'delete_claimed',
      tombstoned: true,
      delete_operation_state: 'ambiguous',
      used_calls: 1,
      approved_scope_rows: 3,
      promotion_state: 'revoked',
      retained_scope: verifiedScopeId,
    });
    assert.ok(createdRows.operationIds.includes(deleteOperationId));
  } finally {
    // Provider audit FKs and append-only triggers intentionally retain this
    // unique fixture. The pinned isolated-live cleanup truncates the whole
    // reviewed test database after the test run.
    await pool.end();
  }
});
