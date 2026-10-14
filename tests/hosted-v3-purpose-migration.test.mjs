import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrationPlan } from '../tools/check-migrations.mjs';

const container = process.env.VIDEO_OS_MIG0013_PG18_CONTAINER || '';
const database = 'lux_mig0013_qualification';
const v3Policy = 'identity-provider-subject-consent-v3';
const accountId = 'mig0013-purpose-account';
const photoId = '00000000-0000-4000-8000-000000000011';
const voiceId = '00000000-0000-4000-8000-000000000012';
const identityId = '00000000-0000-4000-8000-000000000013';
const EXPECTED_SQL = `ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_hosted_v3_purpose_ck" CHECK ("identity_consents"."policy_version" <> 'identity-provider-subject-consent-v3' or "identity_consents"."consent_purpose" is not distinct from 'hosted-avatar-consent');`;

test('0013 adds only the hosted v3 purpose CHECK declared in db/schema.js, validated directly', async () => {
  const [sql, schema, journalRaw, snapshotRaw, previousRaw] = await Promise.all([
    readFile('drizzle/0013_hosted_v3_purpose_guard.sql', 'utf8'),
    readFile('db/schema.js', 'utf8'),
    readFile('drizzle/meta/_journal.json', 'utf8'),
    readFile('drizzle/meta/0013_snapshot.json', 'utf8'),
    readFile('drizzle/meta/0012_snapshot.json', 'utf8'),
  ]);
  assert.equal(sql.replace(/\r\n/g, '\n').trim(), EXPECTED_SQL);
  assert.doesNotMatch(sql, /NOT VALID|DROP|DELETE|UPDATE|TRUNCATE/i);
  assert.match(schema, /check\('identity_consents_hosted_v3_purpose_ck', sql`\$\{table\.policyVersion\} <> 'identity-provider-subject-consent-v3' or \$\{table\.consentPurpose\} is not distinct from 'hosted-avatar-consent'`\)/);

  const journal = JSON.parse(journalRaw);
  const last = journal.entries.at(-1);
  assert.equal(last.idx, 13);
  assert.equal(last.tag, '0013_hosted_v3_purpose_guard');

  const snapshot = JSON.parse(snapshotRaw);
  const previous = JSON.parse(previousRaw);
  assert.equal(snapshot.prevId, previous.id);
  const check = snapshot.tables['public.identity_consents'].checkConstraints.identity_consents_hosted_v3_purpose_ck;
  assert.equal(check.value, `"identity_consents"."policy_version" <> 'identity-provider-subject-consent-v3' or "identity_consents"."consent_purpose" is not distinct from 'hosted-avatar-consent'`);
  // Apart from ids and the new CHECK, the snapshot is identical to 0012.
  delete snapshot.tables['public.identity_consents'].checkConstraints.identity_consents_hosted_v3_purpose_ck;
  for (const s of [snapshot, previous]) { delete s.id; delete s.prevId; }
  assert.deepEqual(snapshot, previous);

  const plan = await migrationPlan();
  assert.equal(plan.migrations.at(-1).tag, '0013_hosted_v3_purpose_guard');
});

function psql(sql, db = database) {
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  return spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'],
    { input: sql, encoding: 'utf8', maxBuffer: 1 << 26 });
}

function consentFixture(purposeSql, policyVersion = v3Policy) {
  return `
    insert into users(id, email, name, role) values ('${accountId}', 'mig0013@example.invalid', 'Schema Test', 'customer');
    insert into media_assets(id, account_id, kind, private_pathname, content_type, bytes, sha256) values
      ('${photoId}', '${accountId}', 'portrait', 'schema-test/photo', 'image/png', 1, repeat('a', 64)),
      ('${voiceId}', '${accountId}', 'voice', 'schema-test/voice', 'audio/wav', 1, repeat('b', 64));
    insert into user_identities(id, account_id, display_name, source_photo_asset_id, source_voice_asset_id)
      values ('${identityId}', '${accountId}', 'Schema Test', '${photoId}', '${voiceId}');
    insert into identity_consents(account_id, identity_id, face_authorization, voice_authorization,
      provider_processing_authorization, archive_delete_acknowledgment, policy_version, photo_sha256, voice_sha256,
      audio_extraction_authorization, temporary_public_provider_exposure_authorization, consent_purpose)
    values ('${accountId}', '${identityId}', true, ${policyVersion === v3Policy ? 'false' : 'true'}, true, true,
      '${policyVersion}', repeat('a', 64), repeat('b', 64), false, false, ${purposeSql});`;
}

test('PostgreSQL 18: after 0000-0013 a v3 consent with the wrong purpose is rejected', {
  skip: container ? false : 'VIDEO_OS_MIG0013_PG18_CONTAINER is not set',
}, async () => {
  const plan = await migrationPlan();
  assert.equal(psql(`drop database if exists ${database}; create database ${database};`, 'postgres').status, 0);
  try {
    const apply = async entries => {
      for (const entry of entries) {
        const body = (await readFile(`drizzle/${entry.tag}.sql`, 'utf8')).replace(/--> statement-breakpoint/g, ';');
        const applied = psql(body);
        assert.equal(applied.status, 0, `${entry.tag}: ${applied.stderr}`);
      }
    };
    await apply(plan.migrations.slice(0, -1));
    // Before 0013 a NULL v3 purpose slips through identity_consents_authorizations_ck (NULL check result).
    const before = psql(`begin; ${consentFixture('null')} rollback;`);
    assert.equal(before.status, 0, before.stderr);

    await apply(plan.migrations.slice(-1));
    const state = psql("select convalidated::text as v from pg_constraint where conname = 'identity_consents_hosted_v3_purpose_ck';");
    assert.match(state.stdout, /v\s*\n[- ]+\n\s*true/);

    const nullPurpose = psql(`begin; ${consentFixture('null')} rollback;`);
    assert.notEqual(nullPurpose.status, 0, 'NULL v3 purpose unexpectedly accepted');
    assert.match(nullPurpose.stderr, /identity_consents_hosted_v3_purpose_ck/);

    for (const purpose of ["'identity-voice-enrollment'", "'something-else'"]) {
      const rejected = psql(`begin; ${consentFixture(purpose)} rollback;`);
      assert.notEqual(rejected.status, 0, `v3 purpose ${purpose} unexpectedly accepted`);
      // With the older broad CHECK removed inside the transaction, the new CHECK alone rejects it.
      const isolated = psql(`begin; alter table identity_consents drop constraint identity_consents_authorizations_ck; ${consentFixture(purpose)} rollback;`);
      assert.notEqual(isolated.status, 0, `v3 purpose ${purpose} accepted by the new CHECK alone`);
      assert.match(isolated.stderr, /identity_consents_hosted_v3_purpose_ck/);
    }
    const ok = psql(`begin; ${consentFixture("'hosted-avatar-consent'")} rollback;`);
    assert.equal(ok.status, 0, ok.stderr);
    const legacy = psql(`begin; ${consentFixture('null', 'identity-consent-v1')} rollback;`);
    assert.equal(legacy.status, 0, legacy.stderr);
  } finally {
    psql(`drop database if exists ${database};`, 'postgres');
  }
});