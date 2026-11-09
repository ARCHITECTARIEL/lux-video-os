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
const CASCADE_IDENTITY = '0d0d0d0d-0000-4000-8000-000000000021';
const CASCADE_SOURCE = '0d0d0d0d-0000-4000-8000-000000000022';
const BINDING = '0d0d0d0d-0000-4000-8000-000000000031';
const SCOPE = '0d0d0d0d-0000-4000-8000-000000000032';
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
const selfValues = (id, { account = SUBJECT, identity = IDENTITY, source = SOURCE, look = 'look_obo', expires = "now() + interval '30 days'" } = {}) =>
  `'${id}', '${account}', '${identity}', '${source}', '${uuid()}', '${look}', '${HEX}', 'luxify-cinematic-consent/v1', 'luxify-cinematic-generation', true, true, '${HEX}', now() - interval '1 minute', ${expires}`;
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
// H1b: the subject consumes the single-use link, then the confirmation audit row is admitted.
async function confirmObo(consentId, { used = true } = {}) {
  await db.query(`INSERT INTO auth_challenges (account_id, email, token_hash, challenge_type, expires_at, used_at)
    VALUES ($1, 'subject@example.test', $2, $3, now() + interval '7 days', ${used ? 'now()' : 'NULL'})`, [SUBJECT, `${consentId.replace(/-/g, '')}`.padEnd(64, '0'), `luxify-obo-confirm:${consentId}`]);
  if (used) await db.query(`INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id) VALUES ($1, '${SUBJECT}', 'consent.subject_confirmed', 'subject', '${SUBJECT}')`, [consentId]);
}
const close = id => db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1 AND revoked_at IS NULL`, [id]);
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
             ('${OTHER_IDENTITY}', '${OTHER}', 'Other', '${uuid()}', '${uuid()}', 'heygen', 'READY', 'look_other'),
             ('${CASCADE_IDENTITY}', '${SUBJECT}', 'Cascade', '${uuid()}', '${uuid()}', 'heygen', 'READY', 'look_cascade');
    INSERT INTO identity_consents (id, account_id, identity_id, face_authorization, voice_authorization, provider_processing_authorization, archive_delete_acknowledgment, policy_version, photo_sha256, voice_sha256, consent_purpose)
      VALUES ('${SOURCE}', '${SUBJECT}', '${IDENTITY}', true, false, true, true, 'identity-provider-subject-consent-v3', '${HEX}', '${HEX}', 'hosted-avatar-consent'),
             ('${OTHER_SOURCE}', '${OTHER}', '${OTHER_IDENTITY}', true, false, true, true, 'identity-provider-subject-consent-v3', '${HEX}', '${HEX}', 'hosted-avatar-consent'),
             ('${CASCADE_SOURCE}', '${SUBJECT}', '${CASCADE_IDENTITY}', true, false, true, true, 'identity-provider-subject-consent-v3', '${HEX}', '${HEX}', 'hosted-avatar-consent');
    INSERT INTO provider_verified_account_scopes (id, provider_account_fingerprint, canonical_scope_key, evidence_digest, evidence_ref)
      VALUES ('${SCOPE}', '${HEX}', '${'1'.repeat(64)}', '${'2'.repeat(64)}', 'fixture/scope');
    INSERT INTO provider_account_bindings (id, application_account_id, environment, project_id, database_binding_sha256, credential_scope_fingerprint, origin_scope_key)
      VALUES ('${BINDING}', '${SUBJECT}', 'test', 'fixture', '${'3'.repeat(64)}', '${'4'.repeat(64)}', '${'5'.repeat(64)}');
    INSERT INTO provider_account_binding_promotions (binding_id, application_account_id, origin_scope_key, verified_account_scope_id, state, evidence_digest, evidence_ref, verified_at)
      VALUES ('${BINDING}', '${SUBJECT}', '${'5'.repeat(64)}', '${SCOPE}', 'verified', '${'6'.repeat(64)}', 'fixture/promotion', now());
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
  // Self-granted consent_operator: the 0021 grant trigger refuses it first,
  // and with triggers suspended the CHECK alone still refuses it.
  const selfGrant = `INSERT INTO lux_staff_grants (staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256) VALUES ('${CEO}', 'ceo@luxmarketingcompany.com', 'consent_operator', true, now(), '${CEO}', '${HEX}')`;
  await rejects(selfGrant, [], /own mailbox/);
  await db.exec('SET session_replication_role = replica');
  try { await rejects(selfGrant, [], /no_self_operator_ck/); } finally { await db.exec('SET session_replication_role = origin'); }
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
  await rejects('DELETE FROM luxify_consent_audit_events WHERE id = $1', [audit], /append-only/);
  await rejects('TRUNCATE luxify_consent_audit_events', [], /append-only/);
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
  // H1b: pending on-behalf consent cannot be linked at enqueue.
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-pending', '${SUBJECT}', 'job-pending', 'job-pending', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(), consent], /not active/);
  await confirmObo(consent);
  await insertJob('job-ok', consent);
  await rejects(`UPDATE video_jobs SET luxify_consent_id = NULL WHERE id = 'job-ok'`, [], /immutable/);
  await db.query(`UPDATE video_jobs SET status = 'workflow_started' WHERE id = 'job-ok'`);
  await db.query(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-ok'`);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [consent]);
});

test('QA M1: consent_operator refuses +tag aliases (CHECK) and the grantor\'s own canonical mailbox (trigger); creative_approval is unchanged', { skip }, async () => {
  const grant = (staff, email, scope = 'consent_operator') => `INSERT INTO lux_staff_grants (staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256) VALUES ('${staff}', '${email}', '${scope}', true, now(), '${CEO}', '${HEX}')`;
  await rejects(grant(OTHER, 'ceo+op@luxmarketingcompany.com'), [], /own mailbox/);
  await rejects(grant(OTHER, 'other+op@luxmarketingcompany.com'), [], /operator_no_alias_ck/);
  await db.query(grant(OTHER, 'other+art@luxmarketingcompany.com', 'creative_approval'));
  // A grant smuggled in with triggers off is still refused by the consent trigger.
  await db.exec('SET session_replication_role = replica');
  const smuggled = uuid();
  try {
    await db.query(`INSERT INTO lux_staff_grants (id, staff_account_id, staff_email, scope, explicit_grant, email_verified_at, granted_by_account_id, grant_evidence_sha256) VALUES ('${smuggled}', '${OTHER}', 'ceo@luxmarketingcompany.com', 'consent_operator', true, now(), '${CEO}', '${HEX}')`);
  } finally { await db.exec('SET session_replication_role = origin'); }
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues({ operator: OTHER, grant: smuggled })})`, [], /consent_operator staff grant/);
  await db.query(`UPDATE lux_staff_grants SET revoked_at = now() WHERE staff_account_id = '${OTHER}' AND revoked_at IS NULL`);
});

test('H1b: consent.subject_confirmed is admitted only as the subject after the link was consumed; once per consent', { skip }, async () => {
  const id = uuid();
  await insertObo(id);
  const confirmAudit = (actorType = 'subject', actor = SUBJECT) => `INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id) VALUES ('${id}', '${SUBJECT}', 'consent.subject_confirmed', '${actorType}', '${actor}')`;
  await rejects(confirmAudit(), [], /consumed subject confirmation link/);
  await confirmObo(id, { used: false });
  await rejects(confirmAudit(), [], /consumed subject confirmation link/);
  await rejects(confirmAudit('operator', OPERATOR), [], /made by the subject/);
  await db.query(`UPDATE auth_challenges SET used_at = now() WHERE challenge_type = $1`, [`luxify-obo-confirm:${id}`]);
  await db.query(confirmAudit());
  await rejects(confirmAudit(), [], /confirmed_uq/);
  // Expiry of a pending row is a valid terminal reason (H1b).
  const pending = uuid();
  await close(id);
  await insertObo(pending);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'confirmation_expired' WHERE id = $1`, [pending]);
  await rejects(`INSERT INTO luxify_consent_audit_events (consent_id, account_id, event, actor_type, actor_account_id) VALUES ('${pending}', '${SUBJECT}', 'consent.subject_confirmed', 'subject', '${SUBJECT}')`, [], /open on-behalf consent/);
});

test('QA M2 + L2 + P2: luxified jobs need a consent id at insert; every pre-submit -> claimed move is checked; the consent must be in the active space', { skip }, async () => {
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input)
    VALUES ('job-null', '${SUBJECT}', 'job-null', 'job-null', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb)`, [jobInput()], /requires luxify_consent_id/);
  await db.query(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input)
    VALUES ('job-plain', '${SUBJECT}', 'job-plain', 'job-plain', 'heygen', 'reserved', 'plain', 'landscape', 41, '{}'::jsonb)`);
  await rejects(`UPDATE video_jobs SET input = $1::jsonb WHERE id = 'job-plain'`, [jobInput()], /requires luxify_consent_id/);
  // A pre-0021 luxified row (NULL link) keeps moving.
  await db.exec('SET session_replication_role = replica');
  try {
    await db.query(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, render_mode)
      VALUES ('job-legacy', '${SUBJECT}', 'job-legacy', 'job-legacy', 'heygen', 'workflow_started', 'legacy', 'landscape', 41, $1::jsonb, 'luxified')`, [jobInput()]);
  } finally { await db.exec('SET session_replication_role = origin'); }
  await db.query(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-legacy'`);
  // L2: a raw workflow_started -> provider_submitted jump on a withdrawn consent is refused.
  const c = uuid();
  await db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}) VALUES (${selfValues(c)})`);
  await insertJob('job-l2', c);
  await db.query(`UPDATE video_jobs SET status = 'workflow_started' WHERE id = 'job-l2'`);
  await close(c);
  await rejects(`UPDATE video_jobs SET status = 'provider_submitted' WHERE id = 'job-l2'`, [], /not active/);
  // P2: a consent recorded for another HeyGen space never links.
  const otherSpace = uuid();
  await db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}) VALUES (${selfValues(otherSpace).replace(`'look_obo', '${HEX}'`, `'look_obo', '${'9'.repeat(64)}'`)})`);
  await rejects(`INSERT INTO video_jobs (id, account_id, idempotency_key, correlation_id, provider, status, title, format, cost_credits, input, luxify_consent_id)
    VALUES ('job-space', '${SUBJECT}', 'job-space', 'job-space', 'heygen', 'reserved', 'obo', 'landscape', 41, $1::jsonb, $2)`, [jobInput(), otherSpace], /not active/);
  await close(otherSpace);
  // P2: once the binding is revoked, a linked job cannot be claimed.
  const s2 = uuid();
  await db.query(`INSERT INTO luxify_cinematic_consents (${consentColumns}) VALUES (${selfValues(s2)})`);
  await insertJob('job-p2', s2);
  // Fixture-only: the provider ledger's own guards are bypassed to flip the binding.
  const setBinding = async state => {
    await db.exec('SET session_replication_role = replica');
    try {
      await db.query(`UPDATE provider_account_bindings SET lifecycle_state = $1, revoked_at = ${state === 'revoked' ? 'now()' : 'NULL'} WHERE id = '${BINDING}'`, [state]);
    } finally { await db.exec('SET session_replication_role = origin'); }
  };
  await setBinding('revoked');
  try {
    await rejects(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-p2'`, [], /not active/);
  } finally { await setBinding('active'); }
  await db.query(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-p2'`);
  await close(s2);
});

test('P2 / QA L3: the source-consent cascade audits each on-behalf consent it closes; self rows are not audited', { skip }, async () => {
  const obo = uuid();
  await insertObo(obo, { identity: CASCADE_IDENTITY, source: CASCADE_SOURCE, look: 'look_cascade' });
  await db.query(`UPDATE identity_consents SET revoked_at = now() WHERE id = '${CASCADE_SOURCE}'`);
  const { rows } = await db.query(`SELECT c.terminal_reason, e.event, e.actor_type, e.actor_account_id FROM luxify_cinematic_consents c
    LEFT JOIN luxify_consent_audit_events e ON e.consent_id = c.id AND e.event = 'consent.source_revoked' WHERE c.id = $1`, [obo]);
  assert.deepEqual(rows, [{ terminal_reason: 'source_revoked', event: 'consent.source_revoked', actor_type: 'system', actor_account_id: SUBJECT }]);
});

test('H1b sweep SQL selects only open, unconfirmed on-behalf rows whose link lapsed', { skip }, async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { unconfirmedOnBehalfSweepSql } = await import('../db/luxify-consent-repository.js');
  const query = new PgDialect().sqlToQuery(unconfirmedOnBehalfSweepSql(50));
  const run = async () => (await db.query(query.sql, query.params)).rows.map(row => row.id);
  const lapsed = uuid();
  await insertObo(lapsed);
  await db.query(`INSERT INTO auth_challenges (account_id, email, token_hash, challenge_type, expires_at, created_at) VALUES ($1, 'subject@example.test', $2, $3, now() - interval '1 minute', now() - interval '8 days')`, [SUBJECT, 'e'.repeat(64), `luxify-obo-confirm:${lapsed}`]);
  assert.deepEqual(await run(), [lapsed]);
  await close(lapsed);
  const live = uuid();
  await insertObo(live);
  await db.query(`INSERT INTO auth_challenges (account_id, email, token_hash, challenge_type, expires_at) VALUES ($1, 'subject@example.test', $2, $3, now() + interval '1 day')`, [SUBJECT, 'f'.repeat(64), `luxify-obo-confirm:${live}`]);
  assert.deepEqual(await run(), [], 'a live link is not swept');
  await close(live);
  const confirmed = uuid();
  await insertObo(confirmed);
  await confirmObo(confirmed);
  assert.deepEqual(await run(), [], 'a confirmed consent is not swept');
  await close(confirmed);
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
  await confirmObo(b);
  await insertJob('job-b', b);
  await db.query(`UPDATE video_jobs SET status = 'workflow_started' WHERE id = 'job-b'`);
  await db.query(`UPDATE luxify_cinematic_consents SET revoked_at = now(), terminal_reason = 'withdrawn' WHERE id = $1`, [b]);
  await rejects(`UPDATE video_jobs SET status = 'provider_submitting' WHERE id = 'job-b'`, [], /not active/);
  // Revoked consent_operator grant: no new on-behalf rows.
  await db.query(`UPDATE lux_staff_grants SET revoked_at = now() WHERE id = '${GRANT}'`);
  await rejects(`INSERT INTO luxify_cinematic_consents (${consentColumns}, ${oboColumns}) VALUES (${selfValues(uuid())}, ${oboValues()})`, [], /consent_operator staff grant/);
});

// Runs last: it empties the disposable DB. Mirrors the reset in
// tests/heygen-admission-race.pg.test.mjs (QA recheck N-L2).
test('QA N-L2: TRUNCATE users CASCADE is refused by the audit trigger; the race-test reset (SET LOCAL replica) succeeds and leaves the trigger intact', { skip }, async () => {
  assert.ok((await db.query('SELECT count(*)::int AS n FROM luxify_consent_audit_events')).rows[0].n > 0, 'audit rows exist to cascade into');
  await rejects('TRUNCATE TABLE users CASCADE', [], /append-only/);
  const triggers = async () => (await db.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'luxify_consent_audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  const before = await triggers();
  await db.exec(`BEGIN;
    SET LOCAL session_replication_role = replica;
    TRUNCATE TABLE users CASCADE;
    COMMIT;`);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM luxify_consent_audit_events')).rows[0].n, 0);
  assert.equal((await db.query("SELECT current_setting('session_replication_role') AS r")).rows[0].r, 'origin', 'SET LOCAL is restored at COMMIT');
  assert.deepEqual(await triggers(), before, 'no trigger dropped or disabled');
  assert.ok(before.length > 0 && before.every(row => row.tgenabled === 'O'));
  await rejects('TRUNCATE TABLE luxify_consent_audit_events', [], /append-only/);
});
