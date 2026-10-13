import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const container = process.env.VIDEO_OS_CORE_SCHEMA_PG18_CONTAINER || '';
const database = process.env.VIDEO_OS_CORE_SCHEMA_PG18_DATABASE || 'lux_core_schema_qualification';
const v3Policy = 'identity-provider-subject-consent-v3';
const accountId = 'schema-null-purpose-account';
const photoId = '00000000-0000-4000-8000-000000000001';
const voiceId = '00000000-0000-4000-8000-000000000002';
const identityId = '00000000-0000-4000-8000-000000000003';

function psql(sql) {
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  assert.match(database, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  return spawnSync('docker', [
    'exec', container, 'psql', '-X', '-U', 'postgres',
    '-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql,
  ], { encoding: 'utf8' });
}

function consentFixture(purposeSql, {
  policyVersion = v3Policy,
  voiceAuthorization = false,
} = {}) {
  return `
    insert into users(id, email, name, role)
      values ('${accountId}', 'schema-null-purpose@example.invalid', 'Schema Test', 'customer');
    insert into media_assets(id, account_id, kind, private_pathname, content_type, bytes, sha256)
      values
        ('${photoId}', '${accountId}', 'portrait', 'schema-test/photo', 'image/png', 1, repeat('a', 64)),
        ('${voiceId}', '${accountId}', 'voice', 'schema-test/voice', 'audio/wav', 1, repeat('b', 64));
    insert into user_identities(id, account_id, display_name, source_photo_asset_id, source_voice_asset_id)
      values ('${identityId}', '${accountId}', 'Schema Test', '${photoId}', '${voiceId}');
    insert into identity_consents(
      account_id, identity_id, face_authorization, voice_authorization,
      provider_processing_authorization, archive_delete_acknowledgment,
      policy_version, photo_sha256, voice_sha256,
      audio_extraction_authorization, temporary_public_provider_exposure_authorization,
      consent_purpose
    ) values (
      '${accountId}', '${identityId}', true, ${voiceAuthorization}, true, true,
      '${policyVersion}', repeat('a', 64), repeat('b', 64), false, false, ${purposeSql}
    );
  `;
}

test('original 0011 stays immutable while the separate proposal enforces exact hosted purpose', async () => {
  const [migrationBytes, schema, snapshot, proposal] = await Promise.all([
    readFile('drizzle/0011_concerned_micromacro.sql', 'utf8'),
    readFile('db/schema.js', 'utf8'),
    readFile('drizzle/meta/0011_snapshot.json', 'utf8'),
    readFile('docs/hosted-v3-purpose-guard.proposed.sql', 'utf8'),
  ]);
  const migrationHash = createHash('sha256').update(migrationBytes).digest('hex');
  assert.ok([
    '28c76bf7bf2b56694e6fd91ffbcce85e44f3c3f9d24af9b9c6b31852261b1b2b',
    'e6a3968178b60fb7854b7c44c9ea1cf1628c5d549ead42796c4eb40517fc92c1',
  ].includes(migrationHash));
  const snapshotHash = createHash('sha256').update(snapshot).digest('hex');
  assert.ok([
    '22f1750d4900682d4fbed1f9f0a490386173c80bb0cceeaa04614c073cb0024c',
    '5dc6d4c004e5d2fcb2509b03f8490c88f39cbff42356bce62234d92eef67deed',
  ].includes(snapshotHash));
  assert.doesNotMatch(migrationBytes, /"consent_purpose" is not null/);
  assert.doesNotMatch(snapshot, /identity_consents_hosted_v3_purpose_ck/);
  assert.match(schema, /check\('identity_consents_hosted_v3_purpose_ck'/);
  assert.match(proposal, /identity_consents_hosted_v3_purpose_ck/);
  assert.match(proposal, /consent_purpose IS NOT DISTINCT FROM 'hosted-avatar-consent'/);
  assert.match(proposal, /\) IS NOT TRUE/);
  assert.match(proposal, /NOT VALID/);
  assert.match(proposal, /VALIDATE CONSTRAINT identity_consents_hosted_v3_purpose_ck/);
});

test('PostgreSQL 18 rehearses fresh, upgrade, rejection, and rollback paths', {
  skip: container ? false : 'VIDEO_OS_CORE_SCHEMA_PG18_CONTAINER is not set',
}, async () => {
  const proposal = await readFile('docs/hosted-v3-purpose-guard.proposed.sql', 'utf8');
  const fresh = psql(`begin; ${proposal} select convalidated::text as guard_validated from pg_constraint where conname = 'identity_consents_hosted_v3_purpose_ck'; rollback;`);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  assert.match(fresh.stdout, /guard_validated\s*\n[- ]+\n\s*true/);

  const validUpgrade = psql(`begin; ${consentFixture("'hosted-avatar-consent'")} ${proposal} rollback;`);
  assert.equal(validUpgrade.status, 0, validUpgrade.stderr || validUpgrade.stdout);

  const incompatibleExisting = psql(`begin; ${consentFixture('null')} ${proposal} rollback;`);
  assert.notEqual(incompatibleExisting.status, 0, 'NULL hosted purpose unexpectedly passed the existing-row precheck');
  assert.match(incompatibleExisting.stderr, /Hosted consent purpose compatibility check failed/);

  const invalidNew = psql(`begin; ${proposal} ${consentFixture('null')} rollback;`);
  assert.notEqual(invalidNew.status, 0, 'NULL hosted purpose unexpectedly passed the additive CHECK');
  assert.match(invalidNew.stderr, /identity_consents_hosted_v3_purpose_ck/);

  const legacy = psql(`begin; ${consentFixture('null', {
    policyVersion: 'identity-consent-v1',
    voiceAuthorization: true,
  })} ${proposal} rollback;`);
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);

  const recovered = psql("select count(*) as guard_count from pg_constraint where conname = 'identity_consents_hosted_v3_purpose_ck'; select count(*) as journal_count from drizzle.__drizzle_migrations; select count(*) as synthetic_user_count from users where id = 'schema-null-purpose-account';");
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /guard_count\s*\n[- ]+\n\s*0/);
  assert.match(recovered.stdout, /journal_count\s*\n[- ]+\n\s*12/);
  assert.match(recovered.stdout, /synthetic_user_count\s*\n[- ]+\n\s*0/);
});
