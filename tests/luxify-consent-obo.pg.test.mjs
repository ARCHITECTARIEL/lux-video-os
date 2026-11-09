import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// CORE-CONSENT-OBO: 0021 CHECKs and triggers on a DISPOSABLE in-process
// Postgres (PGlite, WASM). Never reads DATABASE_URL or any real database.
// Opt-in: VIDEO_OS_PGLITE_MODULE must name a local @electric-sql/pglite
// entry file. Otherwise every test here is skipped.
// Limitation: PGlite is single-connection, so true lock contention (two
// sessions racing revoke vs enqueue) is NOT exercised here; only both
// commit orders are. The race needs a multi-connection throwaway Postgres.
const MODULE = process.env.VIDEO_OS_PGLITE_MODULE || '';
const skip = MODULE ? false : 'VIDEO_OS_PGLITE_MODULE is unset (disposable PGlite only; never a real DATABASE_URL)';

const SUBJECT = 'subject-account-obo';
const OTHER = 'other-account-obo';
const OPERATOR = 'operator-account-obo';
const CEO = 'ceo-account-obo';
const IDENTITY = '0d0d0d0d-0000-4000-8000-000000000001';
const OTHER_IDENTITY = '0d0d0d0d-0000-4000-8000-000000000011';
const SOURCE = '0d0d0d0d-0000-4000-8000-000000000002';
const OTHER_SOURCE = '0d0d0d0d-0000-4000-8000-000000000012';
const GRANT = '0d0d0d0d-0000-4000-8000-000000000003';
const CREATIVE_GRANT = '0d0d0d0d-0000-4000-8000-000000000004';
const HEX = 'a'.repeat(64);
const SUBJECT_HASH = 'b'.repeat(64);
const EVIDENCE = `video-os/consent-evidence/${SUBJECT_HASH}/0d0d0d0d-0000-4000-8000-0000000000ee.pdf`;

let db;
let counter = 0;
const uuid = () => `0d0d0d0d-0000-4000-8000-${String(++counter).padStart(12, '0')}`.replace(/-(\d{12})$/, (_, n) => `-9${n.slice(1)}`);

// Autocommit: each refused statement rolls back on its own.
async function rejects(sql, params, pattern) {
  let failed = null;
  try { await db.query(sql, params); } catch (error) { failed = error; }
  assert.ok(failed, `expected failure matching ${pattern}`);
  assert.match(String(failed.message), pattern);
}

const consentColumns = 'id, account_id, identity_id, source_identity_consent_id, idempotency_key, provider_look_id, provider_space_fingerprint, policy_version, purpose, cinematic_generation_authorization, provider_processing_authorization, approval_evidence_sha256, accepted_at, expires_at';
const selfValues = (id, { account = SUBJECT, identity = IDENTITY, source = SOURCE, expires = "now() + interval '30 days'" } = {}) =>
  `'${id}', '${account}', '${identity}', '${source}', '${uuid()}', 'look_obo', '${HEX}', 'luxify-cinematic-consent/v1', 'luxify-cinematic-generation', true, true, '${HEX}', now() - interval '1 minute', ${expires}`;
const oboColumns = 'consent_mode, operator_user_id, operator_staff_grant_id, attestation_text_version, attestation_text_sha256, attested_at, attestation_method, attestation_evidence_ref';
const oboValues = ({ operator = OPERATOR, grant = GRANT, attested = "now() - interval '1 hour'", evidence = EVIDENCE } = {}) =>
  `'operator_on_behalf', '${operator}', '${grant}', 'luxify-operator-attestation/v1', '${HEX}', ${attested}, 'written', '${evidence}'`;
async function insertObo(id, opts = {}) {
  return db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(id, opts)}, ${oboValues(opts)})`);
}
const jobInput = (identity = IDENTITY, look = 'look_obo') => JSON.stringify({
  renderMode: 'luxify_cinematic_v1', contractVersion: 'luxify-cinematic-v1', providerCapability: 'cinematic_avatar',
  lookIdentityIds: [identity], lookBindings: [{ identityId: identity, providerLookId: look }],
});
async function insertJob(id, consentId, { account = SUBJECT, input = jobInput() } = {}) {
  return db.query(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ($1, $2, $1, $1, 'heygen', 'reserved', 'obo', 'landscape', 41, $3::jsonb, $4)`, [id, account, input, consentId]);
}

test.before(async () => {
  if (skip) return;
  const { PGlite } = await import(MODULE);
  db = new PGlite();
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) {
    const text = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) if (statement.trim()) await db.exec(statement);
  }
  await db.exec(`INSERT INTO users (id, email, role) VALUES
    ('${SUBJECT}', 'subject@example.test', 'customer'), ('${OTHER}', 'other@example.test', 'customer'),
    ('${OPERATOR}', 'operator@luxmarketingcompany.com', 'customer'), ('${CEO}', 'ceo@luxmarketingcompany.com', 'customer')`); // role 'ceo' needs the 0014 privileged path; irrelevant to these DB checks
  // Fixture-only: identities/source consents reference media assets we do not
  // need here, so FK/trigger checks are suspended for these seed rows only.
  await db.exec(`SET session_replication_role = replica;
    INSERT INTO user_identities (id, account_id, display_name, source_photo_asset_id, source_voice_asset_id, provider, avatar_status, provider_renderable_avatar_id)
      VALUES ('${IDENTITY}', '${SUBJECT}', 'Subject', '${uuid()}', '${uuid()}', 'heygen', 'READY', 'look_obo'),
             ('${OTHER_IDENTITY}', '${OTHER}', 'Other', '${uuid()}', '${uuid()}', 'heygen', 'READY', 'look_other');
    INSERT INTO identity_consents (id, account_id, identity_id, face_authorization, voice_authorization, provider_processing_authorization, archive_delete_acknowledgment, policy_version, photo_sha256, voice_sha256, consent_purpose)
      VALUES ('${SOURCE}', '${SUBJECT}', '${IDENTITY}', true, false, true, true, 'identity-provider-subject-consent-v3', '${HEX}', '${HEX}', 'hosted-avatar-consent'),
             ('${OTHER_SOURCE}', '${OTHER}', '${OTHER_IDENTITY}', true, false, true, true, 'identity-provider-subject-consent-v3', '${HEX}', '${HEX}', 'hosted-avatar-consent');
    SET session_replication_role = origin;`);
  await db.exec(`INSERT INTO lux_staff_grants (id, staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256)
    VALUES ('${GRANT}', '${OPERATOR}', 'operator@luxmarketingcompany.com', 'consent_operator', true, now(), '${CEO}', '${HEX}'),
           ('${CREATIVE_GRANT}', '${CEO}', 'ceo@luxmarketingcompany.com', 'creative_approval', true, now(), '${CEO}', '${HEX}')`);
});

test.after(async () => { if (db) await db.close(); });

test('0021 applies on top of 0000-0020 and pre-0021 style inserts default to consent_mode self', { skip }, async () => {
  const id = uuid();
  await db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}) VALUES (${selfValues(id)})`);
  const { rows } = await db.query('SELECT consent_mode, operator_user_id, attestation_text_sha256 FROM luxify_cinematic_consents WHERE id = $1', [id]);
  assert.deepEqual(rows[0], { consent_mode: 'self', operator_user_id: null, attestation_text_sha256: null });
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [id]);
});

test('mode CHECK: self rows cannot carry operator/attestation columns; on-behalf rows need all of them; operator <> subject', { skip }, async () => {
  // Old code cannot create an on-behalf row: a self row with any operator column is refused.
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, operator_user_id) VALUES (${selfValues(uuid())}, '${OPERATOR}')`, [], /mode_fields_ck/);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, attestation_text_sha256) VALUES (${selfValues(uuid())}, '${HEX}')`, [], /mode_fields_ck/);
  // On-behalf with a missing column.
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, consent_mode, operator_user_id, operator_staff_grant_id) VALUES (${selfValues(uuid())}, 'operator_on_behalf', '${OPERATOR}', '${GRANT}')`, [], /mode_fields_ck/);
  // Operator is the subject: the 0021 trigger refuses it (no grant held by the
  // subject), and with triggers suspended the CHECK alone still refuses it.
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ operator: SUBJECT })})`, [], /consent_operator staff grant/);
  await db.exec('SET session_replication_role = replica');
  try {
    await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ operator: SUBJECT })})`, [], /mode_fields_ck/);
  } finally { await db.exec('SET session_replication_role = origin'); }
  // Unknown mode; public URL instead of a private evidence path; attested too far back; 365-day cap from attestation.
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, consent_mode) VALUES (${selfValues(uuid())}, 'agency')`, [], /mode_fields_ck/);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ evidence: 'https://example.test/evidence.pdf' })})`, [], /attestation_ck/);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ attested: "now() - interval '8 days'" })})`, [], /attestation_ck/);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid(), { expires: "now() + interval '365 days'" })}, ${oboValues({ attested: "now() - interval '2 days'" })})`, [], /attestation_ck/);
});

test('operator gate: only an active, explicit, non-self consent_operator grant held by the operator admits an on-behalf row', { skip }, async () => {
  const ok = uuid();
  await insertObo(ok);
  const { rows } = await db.query('SELECT consent_mode, operator_user_id, account_id FROM luxify_cinematic_consents WHERE id = $1', [ok]);
  assert.deepEqual(rows[0], { consent_mode: 'operator_on_behalf', operator_user_id: OPERATOR, account_id: SUBJECT });
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [ok]);
  // Non-staff operator: the grant id belongs to someone else / wrong scope.
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ operator: CEO, grant: CREATIVE_GRANT })})`, [], /consent_operator staff grant/);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ operator: OTHER, grant: GRANT })})`, [], /consent_operator staff grant/);
  // Self-granted consent_operator and an unknown scope are refused by lux_staff_grants CHECKs.
  await rejects(`INSERT INTO lux_staff_grants (staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256) VALUES ('${CEO}', 'ceo@luxmarketingcompany.com', 'consent_operator', true, now(), '${CEO}', '${HEX}')`, [], /no_self_operator_ck/);
  await rejects(`INSERT INTO lux_staff_grants (staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256) VALUES ('${OTHER}', 'other@luxmarketingcompany.com', 'admin', true, now(), '${CEO}', '${HEX}')`, [], /scope_ck/);
});

test('on-behalf columns are immutable after insert; the row can only be closed', { skip }, async () => {
  const id = uuid();
  await insertObo(id);
  await rejects(`UPDATE luxify_cinematic_consents SET attestation_text_sha256 = '${'c'.repeat(64)}' WHERE id = $1`, [id], /may only be closed/);
  await rejects(`UPDATE luxify_cinematic_consents SET operator_user_id = '${CEO}', revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [id], /may only be closed/);
  await rejects('DELETE FROM luxify_cinematic_consents WHERE id = $1', [id], /never deleted/);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [id]);
});

test('audit events are append-only and pinned to the consent account', { skip }, async () => {
  const id = uuid();
  await insertObo(id);
  const audit = uuid();
  await db.query(`INSERT INTO luxify_consent_audit_events (id, consent_id, account_id, event, actor_type, actor_account_id, on_behalf_of_account_id, staff_grant_id, attestation_text_sha256, request_id)
    VALUES ($1, $2, '${SUBJECT}', 'consent.granted_on_behalf', 'operator', '${OPERATOR}', '${SUBJECT}', '${GRANT}', '${HEX}', 'req-1')`, [audit, id]);
  await rejects(`UPDATE luxify_consent_audit_events SET request_id = 'x' WHERE id = $1`, [audit], /append-only/);
  await rejects('DELETE FROM luxify_consent_audit_events WHERE id = $1', [audit], /never deleted/);
  await rejects(`INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id) VALUES ($1, '${OTHER}', 'consent.withdrawn', 'subject', '${OTHER}')`, [id], /audit_events_consent_fk/);
  await rejects(`INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id) VALUES ($1, '${SUBJECT}', 'consent.granted_on_behalf', 'operator', '${OPERATOR}')`, [id], /grant_uq/);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [id]);
});

test('video_jobs.luxify_consent_id: same account, open, unexpired and same look at enqueue; re-checked at provider submit', { skip }, async () => {
  const consent = uuid();
  await insertObo(consent);
  // Cross-account: another account's job cannot reference this consent.
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-x', '${OTHER}', 'job-x', 'job-x', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(OTHER_IDENTITY, 'look_other'), consent], /video_jobs_luxify_consent_fk|not active/);
  // Wrong look on the same account.
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-w', '${SUBJECT}', 'job-w', 'job-w', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(IDENTITY, 'look_else'), consent], /not active/);
  // Non-luxified job cannot carry a consent id.
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-p', '${SUBJECT}', 'job-p', 'job-p', 'heygen', 'reserved', 'obo', 'landscape', 41, '{}'::jsonb, $1)`, [consent], /only valid on a luxified job/);
  await insertJob('job-ok', consent);
  await rejects(`UPDATE video_jobs SET luxify_consent_id = NULL WHERE id = 'job-ok'`, [], /immutable/);
  await db.query(`UPDATE video_jobs SET status = 'workflow_started' WHERE id = 'job-ok'`);
  await db.query(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-ok'`);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [consent]);
});

test('withdraw or expiry blocks enqueue, and a withdraw committed after enqueue blocks provider submit (both commit orders)', { skip }, async () => {
  // Order A: withdraw commits first -> enqueue refused.
  const a = uuid();
  await insertObo(a);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [a]);
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-a', '${SUBJECT}', 'job-a', 'job-a', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(), a], /not active/);
  // Expired consent (self row) -> enqueue refused.
  const expired = uuid();
  await db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}) VALUES ('${expired}', '${SUBJECT}', '${IDENTITY}', '${SOURCE}', '${uuid()}', 'look_obo', '${HEX}', 'luxify-cinematic-consent/v1', 'luxify-cinematic-generation', true, true, '${HEX}', now() - interval '10 days', now() - interval '1 day')`);
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-e', '${SUBJECT}', 'job-e', 'job-e', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(), expired], /not active/);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'revoked' WHERE id = $1`, [expired]);
  // Order B: enqueue first, then withdraw -> provider submit refused.
  const b = uuid();
  await insertObo(b);
  await insertJob('job-b', b);
  await db.query(`UPDATE video_jobs SET status = 'workflow_started' WHERE id = 'job-b'`);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [b]);
  await rejects(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-b'`, [], /not active/);
  // Revoked consent_operator grant: no new on-behalf rows.
  await db.query(`UPDATE lux_staff_grants SET revoked_at = now() WHERE id = '${GRANT}'`);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues()})`, [], /consent_operator staff grant/);
});
