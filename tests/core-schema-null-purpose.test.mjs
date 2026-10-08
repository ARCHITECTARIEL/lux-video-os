import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const container = process.env.VIDEO_OS_CORE_SCHEMA_PG18_CONTAINER || '';
const v3Policy = 'identity-provider-subject-consent-v3';
const accountId = 'schema-null-purpose-account';
const photoId = '00000000-0000-4000-8000-000000000001';
const voiceId = '00000000-0000-4000-8000-000000000002';
const identityId = '00000000-0000-4000-8000-000000000003';

function psql(sql) {
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  return spawnSync('docker', [
    'exec', container, 'psql', '-X', '-U', 'postgres',
    '-d', 'lux_core_schema_qualification', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql,
  ], { encoding: 'utf8' });
}

function consentFixture(purposeSql, {
  policyVersion = v3Policy,
  voiceAuthorization = false,
} = {}) {
  return `
    begin;
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
    rollback;
  `;
}

test('hosted-consent v3 requires a non-null exact purpose in migration, schema, and snapshot', async () => {
  const [migration, schema, snapshot] = await Promise.all([
    readFile('drizzle/0011_concerned_micromacro.sql', 'utf8'),
    readFile('db/schema.js', 'utf8'),
    readFile('drizzle/meta/0011_snapshot.json', 'utf8'),
  ]);
  assert.match(migration, /"consent_purpose" is not null\s+and "identity_consents"\."consent_purpose" = 'hosted-avatar-consent'/);
  assert.match(schema, /\$\{table\.consentPurpose\} is not null\s+and \$\{table\.consentPurpose\} = 'hosted-avatar-consent'/);
  assert.match(snapshot, /\\"consent_purpose\\" is not null\\n    and \\"identity_consents\\"\.\\"consent_purpose\\" = 'hosted-avatar-consent'/);
});

test('PostgreSQL 18 rejects NULL only for hosted v3 purpose', {
  skip: container ? false : 'VIDEO_OS_CORE_SCHEMA_PG18_CONTAINER is not set',
}, () => {
  const valid = psql(consentFixture("'hosted-avatar-consent'"));
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  const invalid = psql(consentFixture('null'));
  assert.notEqual(invalid.status, 0, 'NULL consent purpose unexpectedly passed the migrated CHECK constraint');
  assert.match(invalid.stderr, /identity_consents_authorizations_ck/);

  const legacy = psql(consentFixture('null', {
    policyVersion: 'identity-consent-v1',
    voiceAuthorization: true,
  }));
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
});
