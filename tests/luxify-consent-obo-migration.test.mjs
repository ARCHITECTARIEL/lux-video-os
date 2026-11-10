import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('0021 is additive: journal idx 21 after 0020, snapshot chained to 0020, no rewrites of prior objects', async () => {
  const [sqlText, previousText, currentText, journalText] = await Promise.all([
    read('../drizzle/0021_luxify_consent_on_behalf.sql'), read('../drizzle/meta/0020_snapshot.json'),
    read('../drizzle/meta/0021_snapshot.json'), read('../drizzle/meta/_journal.json'),
  ]);
  const text = sqlText.replace(/\r\n/g, '\n');
  const journal = JSON.parse(journalText);
  const entry = journal.entries[21];
  assert.deepEqual(entry, { idx: 21, version: '7', when: entry.when, tag: '0021_luxify_consent_on_behalf', breakpoints: true });
  assert.ok(entry.when > journal.entries[20].when);
  assert.equal(journal.entries.length, 22);
  const previous = JSON.parse(previousText);
  const current = JSON.parse(currentText);
  assert.equal(current.prevId, previous.id);
  assert.deepEqual(Object.keys(current.tables).filter(name => !previous.tables[name]), ['public.luxify_consent_audit_events']);
  const consents = current.tables['public.luxify_cinematic_consents'];
  for (const column of ['consent_mode', 'operator_user_id', 'operator_staff_grant_id', 'attestation_text_version', 'attestation_text_sha256', 'attested_at', 'attestation_method', 'attestation_evidence_ref']) {
    assert.ok(consents.columns[column], column);
    assert.equal(consents.columns[column].notNull, column === 'consent_mode', `${column} nullability`);
  }
  assert.equal(consents.columns.consent_mode.default, "'self'");
  assert.equal(current.tables['public.video_jobs'].columns.luxify_consent_id.notNull, false);
  // Only two CHECKs are dropped, each re-added wider: the staff scope and the
  // terminal reasons (+ confirmation_expired, H1b).
  assert.deepEqual(text.match(/DROP [A-Z ]+"[a-z_]+"/g), ['DROP CONSTRAINT "lux_staff_grants_scope_ck"', 'DROP CONSTRAINT "luxify_cinematic_consents_terminal_ck"']);
  assert.match(text, /ADD CONSTRAINT "lux_staff_grants_scope_ck" CHECK \("lux_staff_grants"\."scope" in \('creative_approval', 'consent_operator'\)\)/);
  assert.match(text, /ADD CONSTRAINT "luxify_cinematic_consents_terminal_ck" CHECK [^\n]+'withdrawn', 'revoked', 'source_revoked', 'confirmation_expired'/);
  // Executable SQL only (comments and string literals removed); the one
  // TRUNCATE token allowed is the L4 guard trigger's `BEFORE TRUNCATE ON`.
  const code = text.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(code.replace(/BEFORE TRUNCATE ON/g, '').replace(/[a-z_]*truncate[a-z_]*/g, ''), /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|CREATE OR REPLACE/i);
  // L7: bounded lock wait, first statement.
  assert.match(text.split('--> statement-breakpoint')[0], /SET LOCAL lock_timeout = '5s';/);
  assert.ok(text.indexOf('luxify_cinematic_consents_id_account_uq') < text.indexOf('luxify_consent_audit_events_consent_fk'), 'unique (id, account_id) precedes composite FKs');
  assert.ok(text.indexOf('luxify_cinematic_consents_id_account_uq') < text.indexOf('video_jobs_luxify_consent_fk'));
  assert.match(text, /consent_mode" = 'self' and [^)]*"operator_user_id" is null/);
  assert.match(text, /"operator_user_id" <> "luxify_cinematic_consents"\."account_id"/);
  assert.match(text, /"lux_staff_grants"\."granted_by_account_id" <> "lux_staff_grants"\."staff_account_id"/);
  assert.match(text, /CREATE TRIGGER luxify_cinematic_consents_operator_guard_trg BEFORE INSERT ON luxify_cinematic_consents/);
  assert.match(text, /grant_row\.scope = 'consent_operator'[\s\S]+FOR SHARE OF grant_row;/);
  // M1: no +tag alias, canonical grantor mailbox compared in SQL.
  assert.match(text, /"lux_staff_grants_operator_no_alias_ck" CHECK \("lux_staff_grants"\."scope" <> 'consent_operator' or strpos\("lux_staff_grants"\."staff_email", '\+'\) = 0\)/);
  assert.match(text, /CREATE TRIGGER lux_staff_grants_operator_guard_trg BEFORE INSERT ON lux_staff_grants/);
  assert.match(text, /regexp_replace\(lower\(grantor\.email\), '\[\+\]\[\^@\]\*@', '@'\)/);
  // H1b: confirmation is admitted only after the subject's link was consumed.
  assert.match(text, /CREATE TRIGGER luxify_consent_audit_events_confirm_guard_trg BEFORE INSERT ON luxify_consent_audit_events/);
  assert.match(text, /challenge\.challenge_type = 'luxify-obo-confirm:' \|\| NEW\.consent_id::text[\s\S]+challenge\.used_at IS NOT NULL/);
  assert.match(text, /CREATE UNIQUE INDEX "luxify_consent_audit_events_confirmed_uq"[^\n]+'consent\.subject_confirmed'/);
  // P2 / L3: source cascade audited; L4: no truncate.
  assert.match(text, /CREATE TRIGGER luxify_cinematic_consents_cascade_audit_trg AFTER UPDATE OF revoked_at ON luxify_cinematic_consents/);
  assert.match(text, /CREATE TRIGGER luxify_consent_audit_events_no_truncate_trg BEFORE TRUNCATE ON luxify_consent_audit_events/);
  assert.match(text, /CREATE TRIGGER video_jobs_luxify_consent_guard_tg BEFORE INSERT OR UPDATE OF luxify_consent_id, status, provider, input/);
  assert.match(text, /consent\.revoked_at IS NULL\s+AND consent\.expires_at > now\(\)[\s\S]+FOR SHARE OF consent;/);
  // M2: luxified insert needs a consent id; L2: every pre-submit -> claimed move; P2: space; H1b: confirmed.
  assert.match(text, /RAISE EXCEPTION 'a luxified job requires luxify_consent_id'/);
  assert.match(text, /OLD\.status IN \('reserved', 'workflow_starting', 'workflow_started'\)/);
  assert.match(text, /consent\.provider_space_fingerprint = active_space/);
  assert.match(text, /consent\.consent_mode = 'self' OR EXISTS[\s\S]+confirmation\.event = 'consent\.subject_confirmed'/);
  for (const [, name] of text.matchAll(/CREATE (?:FUNCTION|TRIGGER) ([a-z0-9_]+)/g)) assert.ok(name.length <= 63, `${name} exceeds 63 bytes`);
  assert.match(text, /luxify_consent_audit_events rows are append-only/);
  for (const name of text.match(/"[a-z0-9_]+"/g)) assert.ok(name.length - 2 <= 63, `${name} exceeds 63 bytes`);
});
