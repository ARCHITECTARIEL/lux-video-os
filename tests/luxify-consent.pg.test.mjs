// Opt-in loopback PostgreSQL tests for the 0018/0019 LUXIFY consent lifecycle
// (repository behaviour, trigger guards, source-revoke race). Adapted from the
// PR #131 QA pass. Skipped unless VIDEO_OS_PG_RACE_TEST_URL points at a
// disposable loopback database migrated through 0019 and
// VIDEO_OS_PG_RACE_TEST_WSPROXY names a local WebSocket proxy. Seeding uses
// session_replication_role, so the role must be a superuser of that throwaway
// database. Rows are closed, never deleted, so the database is not reusable
// for anything else.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const raceUrl = process.env.VIDEO_OS_PG_RACE_TEST_URL;
const skip = !raceUrl && 'VIDEO_OS_PG_RACE_TEST_URL is unset';
const opts = { skip, timeout: 120_000 };

const hex = s => createHash('sha256').update(s).digest('hex');
const tag = randomUUID().slice(0, 8);
const acct = n => `user-pgt${tag}${n}`;
const A = acct('a'), B = acct('b'), C = acct('c'), CEO = acct('ceo'), STAFF = acct('staff'), PROBE = acct('probe'), LOOKSTAFF = acct('lookstaff'), NOSTAFF = acct('nostaff');
const idA = randomUUID(), idB = randomUUID(), idC = randomUUID();
const srcA = randomUUID(), srcB = randomUUID(), srcC = randomUUID(), srcCRevoked = randomUUID();
const CONSENT_COLS = 'id,account_id,identity_id,source_identity_consent_id,idempotency_key,provider_look_id,provider_space_fingerprint,policy_version,purpose,cinematic_generation_authorization,provider_processing_authorization,approval_evidence_sha256,accepted_at,expires_at';
const insertConsent = (src, look, expiry = "now()+interval '1 day'") => `insert into luxify_cinematic_consents(${CONSENT_COLS}) values(gen_random_uuid(),'${C}','${idC}','${src}',gen_random_uuid(),'${look}',repeat('a',64),'luxify-cinematic-consent/v1','luxify-cinematic-generation',true,true,repeat('b',64),now(),${expiry}) returning id`;
const insertGrant = (revoked = 'null') => `insert into lux_staff_grants(id,staff_account_id,staff_email,scope,explicit_grant,email_verified_at,granted_by_account_id,grant_evidence_sha256,granted_at,revoked_at) values(gen_random_uuid(),'${PROBE}','probe${tag}@luxmarketingcompany.com','creative_approval',true,now(),'${CEO}',repeat('c',64),now()-interval '2 days',${revoked}) returning id`;

let pool, db, repo, mod, NOTICE;
const q = (text, values) => pool.query(text, values);
const code = async p => { try { await p; return 'OK'; } catch (error) { return error.code || 'ERROR'; } };
const openCount = async id => Number((await q('select count(*) from luxify_cinematic_consents where identity_id=$1 and revoked_at is null', [id])).rows[0].count);
const grant = (accountId, identityId, key = randomUUID(), extra = {}) => repo.grantConsent({ accountId, identityId, idempotencyKey: key, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true, noticeSha256: NOTICE, challengeSha256: hex(randomUUID()), ...extra });

async function connect() {
  const parsed = new URL(raceUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'race target must be loopback');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^(?:race|throwaway|vos_race)[a-z0-9_]*$/, 'race target must be disposable');
  const proxy = process.env.VIDEO_OS_PG_RACE_TEST_WSPROXY;
  assert.match(proxy || '', /^(?:localhost|127\.0\.0\.1):(?:[1-9]\d{0,4})$/, 'local WebSocket proxy required');
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  const ws = (await import('ws')).default;
  neonConfig.webSocketConstructor = ws;
  neonConfig.wsProxy = () => `${proxy}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  pool = new Pool({ connectionString: raceUrl, max: 20, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  pool.on('error', () => {});
  const schema = await import('../db/schema.js');
  db = drizzle({ client: pool, schema });
  mod = await import('../db/luxify-consent-repository.js');
  repo = mod.createLuxifyConsentRepository({ executor: db });
  NOTICE = (await import('../lib/luxify-consent-policy.js')).LUXIFY_CONSENT_NOTICE_SHA256;
}

async function seed() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role=replica');
    const users = [[A, `a${tag}@example.test`, 'customer'], [B, `b${tag}@example.test`, 'customer'], [C, `c${tag}@example.test`, 'customer'],
      [CEO, `ceo${tag}@luxmarketingcompany.com`, 'ceo'], [STAFF, `staff${tag}@luxmarketingcompany.com`, 'customer'],
      [PROBE, `probe${tag}@luxmarketingcompany.com`, 'customer'], [LOOKSTAFF, `lookstaff${tag}@luxmarketingcompany.com`, 'customer'], [NOSTAFF, `x${tag}@luxmarketingcompany.com.example.test`, 'customer']];
    for (const [id, email, role] of users) {
      await c.query('insert into users(id,email,role) values($1,$2,$3)', [id, email, role]);
      await c.query("insert into auth_challenges(account_id,email,token_hash,expires_at,used_at) values($1,$2,$3,now()+interval '1h',now())", [id, email, hex(id + 'tok')]);
    }
    for (const [acc, id, src, look] of [[A, idA, srcA, `look_a_${tag}`], [B, idB, srcB, `look_b_${tag}`], [C, idC, srcC, `look_c_${tag}`]]) {
      await c.query("insert into user_identities(id,account_id,display_name,avatar_status,source_photo_asset_id,source_voice_asset_id,provider_renderable_avatar_id) values($1,$2,'L','READY',gen_random_uuid(),gen_random_uuid(),$3)", [id, acc, look]);
      await c.query("insert into identity_consents(id,account_id,identity_id,face_authorization,voice_authorization,provider_processing_authorization,archive_delete_acknowledgment,policy_version,photo_sha256,voice_sha256) values($1,$2,$3,true,true,true,true,$4,'x','x')", [src, acc, id, 'pgt-' + randomUUID()]);
      const scope = randomUUID(), bind = randomUUID();
      await c.query("insert into provider_verified_account_scopes(id,provider,provider_account_fingerprint,canonical_scope_key,evidence_digest,evidence_ref) values($1,'heygen',$2,$3,$3,'ref')", [scope, hex(acc + 'fp'), hex(acc + 'scope')]);
      await c.query("insert into provider_account_bindings(id,application_account_id,provider,environment,project_id,database_binding_sha256,credential_scope_fingerprint,origin_scope_key,lifecycle_state) values($1,$2,'heygen','pgt','pgt',$3,$3,$3,'active')", [bind, acc, hex(acc + 'b')]);
      await c.query("insert into provider_account_binding_promotions(binding_id,application_account_id,origin_scope_key,verified_account_scope_id,state,evidence_digest,evidence_ref,verified_at) values($1,$2,$3,$4,'verified',$3,'ref',now())", [bind, acc, hex(acc + 'b'), scope]);
    }
    await c.query("insert into identity_consents(id,account_id,identity_id,face_authorization,voice_authorization,provider_processing_authorization,archive_delete_acknowledgment,policy_version,photo_sha256,voice_sha256,revoked_at) values($1,$2,$3,true,true,true,true,$4,'x','x',now())", [srcCRevoked, C, idC, 'pgt-' + randomUUID()]);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback').catch(() => {});
    throw error;
  } finally { c.release(); }
}

test.before(async () => { if (skip) return; await connect(); await seed(); });
test.after(async () => { if (pool) await pool.end(); });

// Runs the statements in one transaction and always rolls back.
async function probe(statements) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const ids = {};
    for (const step of statements) {
      const text = typeof step === 'function' ? step(ids) : step;
      const result = await c.query(text);
      if (result.rows?.[0]?.id) ids.last = result.rows[0].id;
      ids.all = [...(ids.all || []), result.rows?.[0]?.id];
    }
    return 'ALLOW';
  } catch (error) {
    return `REJECT:${error.message}`;
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const rejects = async (statements, pattern) => {
  const got = await probe(statements);
  assert.ok(got.startsWith('REJECT:'), `expected rejection, got ${got}`);
  if (pattern) assert.match(got, pattern);
};
const allows = async statements => assert.equal(await probe(statements), 'ALLOW');

test('consent trigger: close-only, immutable once closed, no delete, no future close', opts, async () => {
  const open = insertConsent(srcC, `look_p_${tag}`);
  const upd = set => ids => `update luxify_cinematic_consents set ${set} where id='${ids.last}'`;
  await allows([open, upd("revoked_at=now(), terminal_reason='withdrawn'")]);
  await rejects([open, upd('revoked_at=now()')]);
  await rejects([open, upd("terminal_reason='withdrawn'")]);
  await rejects([open, upd("revoked_at=now(), terminal_reason='other'")]);
  await rejects([open, upd("revoked_at=now(), terminal_reason='withdrawn'"), upd('revoked_at=null, terminal_reason=null')], /immutable/);
  await rejects([open, upd("revoked_at=now(), terminal_reason='withdrawn'"), upd("terminal_reason='revoked'")], /immutable/);
  await rejects([open, upd("expires_at=expires_at+interval '1 hour'")], /only be closed/);
  await rejects([open, upd("revoked_at=now(), terminal_reason='withdrawn', provider_look_id='x'")], /only be closed/);
  await rejects([open, upd('id=id')], /only be closed/);
  await rejects([open, upd("revoked_at=accepted_at-interval '1 second', terminal_reason='withdrawn'")]);
  await rejects([open, upd("revoked_at=now()+interval '10 years', terminal_reason='withdrawn'")], /future/);
  await rejects([open, ids => `delete from luxify_cinematic_consents where id='${ids.last}'`], /never deleted/);
  await rejects([insertConsent(srcCRevoked, `look_r_${tag}`)], /active source identity consent/);
  await rejects([insertConsent(srcC, `look_x_${tag}`, "now()+interval '366 days'")]);
  await rejects([`insert into luxify_cinematic_consents(${CONSENT_COLS},revoked_at,terminal_reason) values(gen_random_uuid(),'${C}','${idC}','${srcC}',gen_random_uuid(),'look_y_${tag}',repeat('a',64),'luxify-cinematic-consent/v1','luxify-cinematic-generation',true,true,repeat('b',64),now(),now()+interval '1 day',now(),'withdrawn')`], /inserted open/);
  await allows([open, `update identity_consents set revoked_at=now() where id='${srcC}'`,
    ids => `do $$ begin if (select terminal_reason from luxify_cinematic_consents where id='${ids.all[0]}') is distinct from 'source_revoked' then raise exception 'cascade missed'; end if; end $$`]);
});

test('staff grant, creative approval and capability evidence rows are close-only (M-1)', opts, async () => {
  const grantRow = insertGrant();
  const updGrant = set => ids => `update lux_staff_grants set ${set} where id='${ids.all[0]}'`;
  await allows([grantRow, updGrant('revoked_at=now()')]);
  await rejects([insertGrant('now()-interval \'1 day\''), ids => `update lux_staff_grants set revoked_at=null where id='${ids.last}'`], /immutable/);
  await rejects([grantRow, updGrant('revoked_at=now()'), updGrant('revoked_at=null')], /immutable/);
  await rejects([grantRow, updGrant(`staff_email='other${tag}@luxmarketingcompany.com'`)], /only be closed/);
  await rejects([grantRow, updGrant(`revoked_at=now(), staff_email='other${tag}@luxmarketingcompany.com'`)], /only be closed/);
  await rejects([grantRow, updGrant("revoked_at=now()+interval '1 year'")], /future/);
  await rejects([grantRow, ids => `delete from lux_staff_grants where id='${ids.last}'`], /never deleted/);

  const asset = randomUUID();
  const assetRow = `insert into media_assets(id,account_id,kind,private_pathname,content_type,bytes,sha256) values('${asset}','${C}','image','pgt/${asset}','image/png',1,'${hex(asset)}') returning id`;
  const approval = ids => `insert into luxify_creative_asset_approvals(account_id,media_asset_id,asset_sha256,staff_grant_id,approver_account_id,decision) values('${C}','${asset}','${hex(asset)}','${ids.all[0]}','${PROBE}','approved') returning id`;
  const updApproval = set => ids => `update luxify_creative_asset_approvals set ${set} where id='${ids.all[2]}'`;
  await allows([grantRow, assetRow, approval, updApproval('revoked_at=now()')]);
  await rejects([grantRow, assetRow, approval, updApproval('revoked_at=now()'), updApproval('revoked_at=null')], /immutable/);
  await rejects([grantRow, assetRow, approval, updApproval(`asset_sha256='${'d'.repeat(64)}'`)], /only be closed/);

  const evidence = ids => `insert into luxify_look_capability_evidence(account_id,provider_look_id,provider_space_fingerprint,capability,eligible,avatar_type,evidence_sha256,staff_grant_id,observed_at,expires_at) values('${C}','look_e_${tag}',repeat('a',64),'cinematic_avatar',false,'studio',repeat('e',64),'${ids.all[0]}',now(),now()+interval '1 day') returning id`;
  const updEvidence = set => ids => `update luxify_look_capability_evidence set ${set} where id='${ids.all[1]}'`;
  await allows([grantRow, evidence, updEvidence('revoked_at=now()')]);
  await rejects([grantRow, evidence, updEvidence('eligible=true')], /only be closed/);
  await rejects([grantRow, evidence, updEvidence("expires_at=expires_at+interval '1 hour'")], /only be closed/);
  await rejects([grantRow, evidence, updEvidence('revoked_at=now()'), updEvidence('revoked_at=null')], /immutable/);
});

test('raw consent insert racing an uncommitted source revoke waits and fails closed (L-1)', opts, async () => {
  for (let i = 0; i < 3; i++) {
    const src = randomUUID();
    await q("insert into identity_consents(id,account_id,identity_id,face_authorization,voice_authorization,provider_processing_authorization,archive_delete_acknowledgment,policy_version,photo_sha256,voice_sha256) values($1,$2,$3,true,true,true,true,$4,'x','x')", [src, C, idC, 'pgt-' + randomUUID()]);
    const revoker = await pool.connect();
    const inserter = await pool.connect();
    try {
      await revoker.query('begin');
      await revoker.query('update identity_consents set revoked_at=now() where id=$1', [src]);
      const pending = inserter.query(insertConsent(src, `look_race_${tag}_${i}`)).then(() => 'OK', error => `REJECT:${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 400));
      await revoker.query('commit');
      assert.match(await pending, /^REJECT:.*active source identity consent/, `iteration ${i}`);
    } finally {
      await revoker.query('rollback').catch(() => {});
      revoker.release();
      inserter.release();
    }
    const bad = (await q('select count(*) from luxify_cinematic_consents where source_identity_consent_id=$1 and revoked_at is null', [src])).rows[0].count;
    assert.equal(Number(bad), 0, `iteration ${i}`);
  }
});

test('wrong account / anonymous / bad input never create consent', opts, async () => {
  assert.equal(await code(grant(B, idA)), 'LUXIFY_CONSENT_SUBJECT_REQUIRED');
  assert.equal(await code(grant('', idA)), 'LUXIFY_CONSENT_SIGN_IN_REQUIRED');
  assert.equal(await code(grant(A, idA, randomUUID(), { providerProcessingAuthorization: 'true' })), 'LUXIFY_CONSENT_AUTHORIZATION_REQUIRED');
  assert.equal(await code(grant(A, idA, randomUUID(), { noticeSha256: '0'.repeat(64) })), 'LUXIFY_CONSENT_CHALLENGE_INVALID');
  assert.notEqual(await code(grant(A, idA, randomUUID(), { expiryDays: 366 })), 'OK');
  assert.equal(await openCount(idA), 0);
});

test('concurrent grants (16 keys) yield exactly one open consent', opts, async () => {
  const results = await Promise.all(Array.from({ length: 16 }, () => code(grant(A, idA))));
  assert.equal(results.filter(r => r === 'OK').length, 1, results.join(','));
  assert.ok(results.filter(r => r !== 'OK').every(r => r === 'LUXIFY_CONSENT_ALREADY_ACTIVE'), results.join(','));
  assert.equal(await openCount(idA), 1);
});

test('idempotency replay and key reuse across identity', opts, async () => {
  const key = randomUUID();
  const first = await grant(B, idB, key);
  assert.equal(first.replayed, false);
  const second = await grant(B, idB, key);
  assert.equal(second.replayed, true);
  assert.equal(second.consent.id, first.consent.id);
  assert.equal(await code(grant(B, idA, key)), 'LUXIFY_CONSENT_IDEMPOTENCY_CONFLICT');
});

test('withdraw is owner-only and exactly one of 8 concurrent withdrawals closes the row', opts, async () => {
  const [{ id }] = (await q('select id from luxify_cinematic_consents where identity_id=$1 and revoked_at is null', [idA])).rows;
  assert.equal(await code(repo.withdrawConsent({ accountId: B, consentId: id })), 'LUXIFY_CONSENT_NOT_FOUND');
  const results = await Promise.all(Array.from({ length: 8 }, () => repo.withdrawConsent({ accountId: A, consentId: id })));
  assert.equal(results.filter(r => r.changed).length, 1);
  assert.equal((await q('select terminal_reason from luxify_cinematic_consents where id=$1', [id])).rows[0].terminal_reason, 'withdrawn');
  assert.equal(await openCount(idA), 0);
});

test('non-staff cannot revoke; consent stays open', opts, async () => {
  const [{ id }] = (await q('select id from luxify_cinematic_consents where identity_id=$1 and revoked_at is null', [idB])).rows;
  for (const who of [A, B, NOSTAFF, CEO]) assert.equal(await code(repo.revokeConsent({ staffAccountId: who, consentId: id })), 'LUX_STAFF_GRANT_REQUIRED');
  assert.equal(await openCount(idB), 1);
});

test('staff grants: CEO only, verified Lux domain only, approvals die with the grant, no reactivation', opts, async () => {
  assert.equal(await code(repo.grantStaff({ grantorAccountId: A, staffAccountId: STAFF, explicitGrant: true })), 'LUX_STAFF_GRANTOR_REQUIRED');
  assert.equal(await code(repo.grantStaff({ grantorAccountId: STAFF, staffAccountId: STAFF, explicitGrant: true })), 'LUX_STAFF_GRANTOR_REQUIRED');
  assert.notEqual(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: NOSTAFF, explicitGrant: true })), 'OK');
  assert.notEqual(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: A, explicitGrant: true })), 'OK');
  assert.notEqual(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: STAFF, explicitGrant: false })), 'OK');
  const results = await Promise.all(Array.from({ length: 6 }, () => code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: STAFF, explicitGrant: true }))));
  assert.ok(results.every(r => r === 'OK'), results.join(','));
  assert.equal(Number((await q('select count(*) from lux_staff_grants where staff_account_id=$1 and revoked_at is null', [STAFF])).rows[0].count), 1);
  // A spoofed grant row for a customer account is ignored (email is not that account's verified email).
  await q("insert into lux_staff_grants(id,staff_account_id,staff_email,scope,explicit_grant,email_verified_at,granted_by_account_id,grant_evidence_sha256,granted_at) values(gen_random_uuid(),$1,$2,'creative_approval',true,now(),$3,$4,now())", [A, `staff${tag}@luxmarketingcompany.com`, CEO, hex('spoof' + tag)]);
  const asset = randomUUID();
  await q("insert into media_assets(id,account_id,kind,private_pathname,content_type,bytes,sha256) values($1,$2,'image',$4,'image/png',1,$3)", [asset, A, hex('asset1' + tag), 'pgt/' + asset]);
  assert.notEqual(await code(repo.approveCreativeAsset({ staffAccountId: A, mediaAssetId: asset })), 'OK', 'spoofed grant row must not authorize');
  assert.equal((await repo.approveCreativeAsset({ staffAccountId: STAFF, mediaAssetId: asset })).replayed, false);
  const gate = (accountId, ids) => code(db.transaction(tx => mod.assertLuxifyCreativeAssetsApprovedTx(tx, { accountId, mediaAssetIds: ids })));
  assert.equal(await gate(A, [asset]), 'OK');
  assert.equal(await gate(A, [asset, randomUUID()]), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED');
  assert.equal(await gate(B, [asset]), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED');
  assert.equal(await gate(A, 'x'), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED');
  await q('update media_assets set sha256=$1 where id=$2', [hex('asset2' + tag), asset]);
  assert.equal(await gate(A, [asset]), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED');
  await q('update media_assets set sha256=$1 where id=$2', [hex('asset1' + tag), asset]);
  assert.equal(await gate(A, [asset]), 'OK');
  // The account's verified email moving off the grant email removes staff authority.
  await q('update users set email=$1 where id=$2', [`other${tag}@luxmarketingcompany.com`, STAFF]);
  await q("insert into auth_challenges(account_id,email,token_hash,expires_at,used_at) values($1,$2,$3,now()+interval '1h',now()+interval '1 second')", [STAFF, `other${tag}@luxmarketingcompany.com`, hex('other' + tag)]);
  assert.notEqual(await code(repo.approveCreativeAsset({ staffAccountId: STAFF, mediaAssetId: asset })), 'OK');
  await q('update users set email=$1 where id=$2', [`staff${tag}@luxmarketingcompany.com`, STAFF]);
  assert.equal(await code(repo.revokeStaffGrant({ grantorAccountId: STAFF, staffAccountId: STAFF })), 'LUX_STAFF_GRANTOR_REQUIRED');
  await repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: STAFF });
  assert.equal(await gate(A, [asset]), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'approval dies with grant');
  assert.equal(await code(repo.approveCreativeAsset({ staffAccountId: STAFF, mediaAssetId: asset })), 'LUX_STAFF_GRANT_REQUIRED');
  await assert.rejects(q('update lux_staff_grants set revoked_at=null where staff_account_id=$1 and revoked_at is not null', [STAFF]), /immutable/);
  await assert.rejects(q("update luxify_creative_asset_approvals set asset_sha256=repeat('d',64) where media_asset_id=$1", [asset]), /only be closed|immutable/);
});

test('source revoke cascades; regrant fails; app grant racing source revoke never leaves an open consent', opts, async () => {
  const revoked = await repo.revokeSourceIdentityConsent({ accountId: B, identityConsentId: srcB });
  assert.equal(revoked.closedCinematicConsents, 1);
  assert.equal(Number((await q("select count(*) from luxify_cinematic_consents where identity_id=$1 and terminal_reason='source_revoked'", [idB])).rows[0].count), 1);
  assert.equal(await code(grant(B, idB)), 'LUXIFY_SOURCE_CONSENT_REQUIRED');
  assert.equal(await code(repo.revokeSourceIdentityConsent({ accountId: A, identityConsentId: srcB })), 'LUXIFY_CONSENT_SUBJECT_REQUIRED');
  for (let i = 0; i < 10; i++) {
    const src = randomUUID();
    await q("insert into identity_consents(id,account_id,identity_id,face_authorization,voice_authorization,provider_processing_authorization,archive_delete_acknowledgment,policy_version,photo_sha256,voice_sha256) values($1,$2,$3,true,true,true,true,$4,'x','x')", [src, B, idB, 'pgt-' + randomUUID()]);
    await Promise.all([code(grant(B, idB)), q('update identity_consents set revoked_at=now() where id=$1', [src])]);
    const bad = (await q('select count(*) from luxify_cinematic_consents l join identity_consents s on s.id=l.source_identity_consent_id where l.identity_id=$1 and l.revoked_at is null and s.revoked_at is not null', [idB])).rows[0].count;
    assert.equal(Number(bad), 0, `iteration ${i}`);
  }
});

test('authority fails closed: missing consent -> 409, DB error -> 503', opts, async () => {
  const missing = await db.transaction(tx => mod.resolvePersistedLuxifyAuthority({ tx, accountId: A, lookIdentityIds: [idA], intent: {} })).catch(error => error);
  assert.equal(missing.statusCode, 409);
  const broken = { select() { throw new Error('db down'); }, execute() { throw new Error('db down'); } };
  const down = await mod.resolvePersistedLuxifyAuthority({ tx: broken, accountId: A, lookIdentityIds: [idA], intent: {} }).catch(error => error);
  assert.equal(down.statusCode, 503);
  assert.equal(down.code, 'LUXIFY_CINEMATIC_AUTHORITY_UNAVAILABLE');
  const downAssets = await mod.resolvePersistedLuxifyAuthority({ tx: broken, accountId: A, lookIdentityIds: [idA], intent: { creativeAssetIds: [randomUUID()] } }).catch(error => error);
  assert.equal(downAssets.statusCode, 503);
});

test('mandatory look creative approval: none, revoked, expired and revoked-grant approvals deny; a valid one passes', opts, async () => {
  const space = await db.transaction(tx => mod.loadActiveProviderSpaceTx(tx, C));
  const look = `look_c_${tag}`;
  const gate = () => code(db.transaction(async tx => mod.assertLuxifyLookCreativeApprovalTx(tx, {
    accountId: C, identityId: idC, providerLookId: look, providerSpaceFingerprint: space.providerSpaceFingerprint, now: new Date(),
  })));
  assert.equal(await gate(), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'no approval');
  assert.equal(await code(repo.approveLookCreative({ staffAccountId: C, accountId: C, identityId: idC })), 'LUX_STAFF_GRANT_REQUIRED');
  await repo.grantStaff({ grantorAccountId: CEO, staffAccountId: LOOKSTAFF, explicitGrant: true });
  assert.equal(await code(repo.approveLookCreative({ staffAccountId: LOOKSTAFF, accountId: C, identityId: idA })), 'LUXIFY_LOOK_NOT_FOUND', 'another account\'s look');
  const approved = await repo.approveLookCreative({ staffAccountId: LOOKSTAFF, accountId: C, identityId: idC, expiresInDays: 7 });
  assert.equal(await gate(), 'OK', 'valid approval');
  assert.equal(await code(db.transaction(tx => mod.assertLuxifyLookCreativeApprovalTx(tx, {
    accountId: B, identityId: idC, providerLookId: look, providerSpaceFingerprint: space.providerSpaceFingerprint, now: new Date(),
  }))), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'approval is account-bound');
  // Expired: evaluated past the approval expiry.
  assert.equal(await code(db.transaction(tx => mod.assertLuxifyLookCreativeApprovalTx(tx, {
    accountId: C, identityId: idC, providerLookId: look, providerSpaceFingerprint: space.providerSpaceFingerprint, now: new Date(Date.parse(approved.expiresAt) + 1000),
  }))), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'expired approval');
  await assert.rejects(q("update luxify_look_creative_approvals set expires_at=expires_at+interval '1 day' where id=$1", [approved.approvalId]), /only be closed/);
  await assert.rejects(q('delete from luxify_look_creative_approvals where id=$1', [approved.approvalId]), /never deleted/);
  await assert.rejects(q("insert into luxify_look_creative_approvals(account_id,identity_id,provider_look_id,provider_space_fingerprint,staff_grant_id,approver_account_id,decision,expires_at) select account_id,identity_id,provider_look_id,provider_space_fingerprint,staff_grant_id,approver_account_id,decision,now()+interval '31 days' from luxify_look_creative_approvals where id=$1", [approved.approvalId]));
  // Revoked approval denies; a re-approval works; revoking the staff grant denies again.
  assert.equal((await repo.revokeLookCreativeApproval({ staffAccountId: LOOKSTAFF, approvalId: approved.approvalId })).changed, true);
  assert.equal(await gate(), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'revoked approval');
  await assert.rejects(q('update luxify_look_creative_approvals set revoked_at=null where id=$1', [approved.approvalId]), /immutable/);
  await repo.approveLookCreative({ staffAccountId: LOOKSTAFF, accountId: C, identityId: idC });
  assert.equal(await gate(), 'OK');
  await repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: LOOKSTAFF });
  assert.equal(await gate(), 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', 'grant revoked');
});

test('0019: a consent challenge is single-use, even across concurrent grants, and its ledger is insert-only (L-3)', opts, async () => {
  const challengeSha256 = hex('challenge' + tag);
  // A has no open consent here (earlier tests withdraw it), so one grant may succeed.
  await q("update luxify_cinematic_consents set revoked_at=now(), terminal_reason='withdrawn' where identity_id=$1 and revoked_at is null", [idA]);
  const results = await Promise.all(Array.from({ length: 6 }, () => code(grant(A, idA, randomUUID(), { challengeSha256 }))));
  assert.equal(results.filter(r => r === 'OK').length <= 1, true, results.join(','));
  assert.ok(results.every(r => r === 'OK' || r === 'LUXIFY_CONSENT_CHALLENGE_USED' || r === 'LUXIFY_CONSENT_ALREADY_ACTIVE'), results.join(','));
  // With no open consent left, replaying the used challenge is refused by the ledger itself.
  await q("update luxify_cinematic_consents set revoked_at=now(), terminal_reason='withdrawn' where identity_id=$1 and revoked_at is null", [idA]);
  assert.equal(await code(grant(A, idA, randomUUID(), { challengeSha256 })), 'LUXIFY_CONSENT_CHALLENGE_USED');
  assert.equal(await openCount(idA), 0, 'replayed challenge created no consent');
  assert.equal(await code(grant(A, idA)), 'OK', 'a fresh challenge still works');
  assert.equal(Number((await q('select count(*) from luxify_consent_challenge_uses where challenge_sha256=$1', [challengeSha256])).rows[0].count), 1);
  // A failed grant (wrong account) rolls back and leaves its challenge unused.
  const unused = hex('unused' + tag);
  assert.notEqual(await code(grant(B, idA, randomUUID(), { challengeSha256: unused })), 'OK');
  assert.equal(Number((await q('select count(*) from luxify_consent_challenge_uses where challenge_sha256=$1', [unused])).rows[0].count), 0);
  await assert.rejects(q('update luxify_consent_challenge_uses set used_at=now() where challenge_sha256=$1', [challengeSha256]), /insert-only|never/i);
  await assert.rejects(q('delete from luxify_consent_challenge_uses where challenge_sha256=$1', [challengeSha256]), /insert-only|never/i);
  await assert.rejects(q("insert into luxify_consent_challenge_uses(challenge_sha256,account_id,identity_id) values('nothex',$1,$2)", [A, idA]));
});

test('0019: list/revoke look approvals end to end; non-READY and archived looks refused; grant revoke closes approvals (N-1/N-2/N-4/N-6/I-5)', opts, async () => {
  const FUSTAFF = acct('fustaff');
  const idD = randomUUID(), idE = randomUUID();
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role=replica');
    await c.query('insert into users(id,email,role) values($1,$2,$3)', [FUSTAFF, `fustaff${tag}@luxmarketingcompany.com`, 'customer']);
    await c.query("insert into auth_challenges(account_id,email,token_hash,expires_at,used_at) values($1,$2,$3,now()+interval '1h',now())", [FUSTAFF, `fustaff${tag}@luxmarketingcompany.com`, hex(FUSTAFF + 'tok')]);
    await c.query("insert into user_identities(id,account_id,display_name,avatar_status,source_photo_asset_id,source_voice_asset_id,provider_renderable_avatar_id) values($1,$2,'L','PROCESSING',gen_random_uuid(),gen_random_uuid(),$3)", [idD, C, `look_d_${tag}`]);
    await c.query("insert into user_identities(id,account_id,display_name,avatar_status,source_photo_asset_id,source_voice_asset_id,provider_renderable_avatar_id,archived_at) values($1,$2,'L','READY',gen_random_uuid(),gen_random_uuid(),$3,now())", [idE, C, `look_e_${tag}`]);
    await c.query('commit');
  } catch (error) { await c.query('rollback').catch(() => {}); throw error; } finally { c.release(); }
  assert.equal(await code(repo.listLookCreativeApprovals({ staffAccountId: FUSTAFF, accountId: C })), 'LUX_STAFF_GRANT_REQUIRED');
  await repo.grantStaff({ grantorAccountId: CEO, staffAccountId: FUSTAFF, explicitGrant: true });
  assert.equal(await code(repo.approveLookCreative({ staffAccountId: FUSTAFF, accountId: C, identityId: idD })), 'LUXIFY_LOOK_NOT_READY');
  assert.equal(await code(repo.approveLookCreative({ staffAccountId: FUSTAFF, accountId: C, identityId: idE })), 'LUXIFY_LOOK_NOT_FOUND');
  const first = await repo.approveLookCreative({ staffAccountId: FUSTAFF, accountId: C, identityId: idC });
  assert.match(first.approvalId, /^[0-9a-f-]{36}$/);
  const listed = (await repo.listLookCreativeApprovals({ staffAccountId: FUSTAFF, accountId: C, identityId: idC })).approvals;
  const mine = listed.find(a => a.approvalId === first.approvalId);
  assert.equal(mine.status, 'active');
  assert.equal(mine.approvedUnderYourGrant, true);
  assert.equal(JSON.stringify(listed).includes(`look_c_${tag}`), false, 'look id is masked');
  assert.equal((await repo.revokeLookCreativeApproval({ staffAccountId: FUSTAFF, approvalId: listed[0].approvalId })).changed, true);
  assert.equal((await repo.listLookCreativeApprovals({ staffAccountId: FUSTAFF, accountId: C, identityId: idC })).approvals.find(a => a.approvalId === listed[0].approvalId).status, 'revoked');
  assert.equal(await code(repo.revokeLookCreativeApproval({ staffAccountId: FUSTAFF, approvalId: randomUUID() })), 'LUXIFY_LOOK_APPROVAL_NOT_FOUND');
  const second = await repo.approveLookCreative({ staffAccountId: FUSTAFF, accountId: C, identityId: idC });
  // I-5: revoke-staff needs the CEO; staff cannot revoke.
  assert.equal(await code(repo.revokeStaffGrant({ grantorAccountId: FUSTAFF, staffAccountId: FUSTAFF })), 'LUX_STAFF_GRANTOR_REQUIRED');
  const result = await repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: FUSTAFF });
  assert.equal(result.revoked, 1);
  assert.ok(result.closedLookApprovals >= 1);
  const row = (await q('select revoked_at from luxify_look_creative_approvals where id=$1', [second.approvalId])).rows[0];
  assert.notEqual(row.revoked_at, null, 'approval row closed with the grant (N-1)');
  assert.equal(await code(repo.listLookCreativeApprovals({ staffAccountId: FUSTAFF, accountId: C })), 'LUX_STAFF_GRANT_REQUIRED');
});

test('0019 trigger: a raw grant revoke closes its open approvals in the same statement (N-1)', opts, async () => {
  await allows([
    insertGrant(),
    ids => `insert into luxify_look_creative_approvals(account_id,identity_id,provider_look_id,provider_space_fingerprint,staff_grant_id,approver_account_id,decision,expires_at) values('${C}','${idC}','look_c_${tag}',repeat('a',64),'${ids.last}','${PROBE}','approved',now()+interval '1 day') returning staff_grant_id as gid`,
    ids => `update lux_staff_grants set revoked_at=now() where id='${ids.all[0]}'`,
    ids => `do $$ begin if exists(select 1 from luxify_look_creative_approvals where staff_grant_id='${ids.all[0]}' and revoked_at is null) then raise exception 'approval left open'; end if; end $$`,
  ]);
});

const lookApproval = (approvedAt, gid = 'ids.all[0]') => ids => `insert into luxify_look_creative_approvals(account_id,identity_id,provider_look_id,provider_space_fingerprint,staff_grant_id,approver_account_id,decision,approved_at,expires_at) values('${C}','${idC}','look_c_${tag}',repeat('a',64),'${ids.all[0]}','${PROBE}','approved',${approvedAt},${approvedAt}+interval '1 day') returning id`;

test('0019 L-1: a near-future approval closes at its approved_at, not before (kills S11); revoke still succeeds', opts, async () => {
  await allows([
    insertGrant(),
    lookApproval("now()+interval '2 minutes'"),
    ids => `update lux_staff_grants set revoked_at=now() where id='${ids.all[0]}'`,
    ids => `do $$ begin if not exists(select 1 from luxify_look_creative_approvals where id='${ids.all[1]}' and revoked_at = approved_at and approved_at > now()) then raise exception 'not closed at approved_at'; end if; end $$`,
  ]);
});

test('0019 L-1: approved_at more than 5 minutes ahead is refused on insert', opts, async () => {
  await rejects([insertGrant(), lookApproval("now()+interval '1 day'")], /approved_at is in the future/);
  await allows([insertGrant(), lookApproval("now()+interval '4 minutes'")]);
});

test('0019 L-1: a legacy far-future approval never blocks a grant revoke (left open; gates need an active grant)', opts, async () => {
  await allows([
    insertGrant(),
    'alter table luxify_look_creative_approvals disable trigger luxify_look_creative_approvals_insert_guard_trg',
    lookApproval("now()+interval '1 day'"),
    'alter table luxify_look_creative_approvals enable trigger luxify_look_creative_approvals_insert_guard_trg',
    ids => `update lux_staff_grants set revoked_at=now() where id='${ids.all[0]}'`,
    ids => `do $$ begin if not exists(select 1 from lux_staff_grants where id='${ids.all[0]}' and revoked_at is not null) then raise exception 'grant not revoked'; end if; end $$`,
  ]);
});

test('0019 L-2: a grant revoke closes its capability evidence (trigger and repository)', opts, async () => {
  const evidence = ids => `insert into luxify_look_capability_evidence(account_id,provider_look_id,provider_space_fingerprint,capability,eligible,avatar_type,evidence_sha256,staff_grant_id,observed_at,expires_at) values('${C}','look_c_${tag}',repeat('a',64),'cinematic_avatar',true,'studio',repeat('d',64),'${ids.all[0]}',now(),now()+interval '1 day') returning id`;
  await allows([
    insertGrant(),
    evidence,
    ids => `update lux_staff_grants set revoked_at=now() where id='${ids.all[0]}'`,
    ids => `do $$ begin if exists(select 1 from luxify_look_capability_evidence where staff_grant_id='${ids.all[0]}' and revoked_at is null) then raise exception 'evidence left open'; end if; end $$`,
  ]);
  const EVSTAFF = acct('evstaff');
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role=replica');
    await c.query('insert into users(id,email,role) values($1,$2,$3)', [EVSTAFF, `evstaff${tag}@luxmarketingcompany.com`, 'customer']);
    await c.query("insert into auth_challenges(account_id,email,token_hash,expires_at,used_at) values($1,$2,$3,now()+interval '1h',now())", [EVSTAFF, `evstaff${tag}@luxmarketingcompany.com`, hex(EVSTAFF + 'tok')]);
    await c.query('commit');
  } catch (error) { await c.query('rollback').catch(() => {}); throw error; } finally { c.release(); }
  await repo.grantStaff({ grantorAccountId: CEO, staffAccountId: EVSTAFF, explicitGrant: true });
  const gid = (await q('select id from lux_staff_grants where staff_account_id=$1 and revoked_at is null', [EVSTAFF])).rows[0].id;
  await q(`insert into luxify_look_capability_evidence(account_id,provider_look_id,provider_space_fingerprint,capability,eligible,avatar_type,evidence_sha256,staff_grant_id,observed_at,expires_at) values($1,$2,repeat('a',64),'cinematic_avatar',true,'studio',repeat('d',64),$3,now(),now()+interval '1 day')`, [C, `look_c_${tag}`, gid]);
  const result = await repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: EVSTAFF });
  assert.equal(result.revoked, 1);
  assert.equal(result.closedCapabilityEvidence, 1);
  assert.equal(Number((await q('select count(*) from luxify_look_capability_evidence where staff_grant_id=$1 and revoked_at is null', [gid])).rows[0].count), 0);
});
