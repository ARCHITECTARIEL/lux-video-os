// Opt-in loopback PostgreSQL tests for LUXIFY-STAFF-1031: the magic-link
// verified-email proof row unlocks Lux staff grants, the staff page reads,
// and the run-time capability check write (HeyGen mocked). Same guards as
// luxify-consent.pg.test.mjs: skipped unless VIDEO_OS_PG_RACE_TEST_URL points
// at a disposable loopback database migrated through 0019 and
// VIDEO_OS_PG_RACE_TEST_WSPROXY names a local WebSocket proxy.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const raceUrl = process.env.VIDEO_OS_PG_RACE_TEST_URL;
const skip = !raceUrl && 'VIDEO_OS_PG_RACE_TEST_URL is unset';
const opts = { skip, timeout: 120_000 };
const hex = s => createHash('sha256').update(s).digest('hex');
const tag = randomUUID().slice(0, 8);
const CEO = `user-pls${tag}ceo`, STAFF = `user-pls${tag}staff`, SUBJ = `user-pls${tag}subj`, OUT = `user-pls${tag}out`;
const CEO_EMAIL = `ceo${tag}@luxmarketingcompany.com`, STAFF_EMAIL = `staff${tag}@luxmarketingcompany.com`, SUBJ_EMAIL = `subj${tag}@example.test`;
const IDENT = randomUUID();
const LOOK = `look_s_${tag}`;
const FP = hex(SUBJ + 'fp');
const DAY = 86_400_000;

let pool, repo, proof, routeMod;
const q = (text, values) => pool.query(text, values);
const code = async p => { try { await p; return 'OK'; } catch (error) { return error.code || 'ERROR'; } };

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
  pool = new Pool({ connectionString: raceUrl, max: 10, connectionTimeoutMillis: 15_000, query_timeout: 30_000 });
  pool.on('error', () => {});
  const schema = await import('../db/schema.js');
  const db = drizzle({ client: pool, schema });
  repo = (await import('../db/luxify-consent-repository.js')).createLuxifyConsentRepository({ executor: db });
  const proofMod = await import('../db/auth-email-proof.js');
  proof = input => proofMod.recordMagicLinkEmailProof({ executor: db, ...input });
  routeMod = await import('../routes/video-os-lite/luxify-consent.js');
}

async function seed() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role=replica');
    // No auth_challenges rows: nobody starts with a verified email.
    for (const [id, email, role] of [[CEO, CEO_EMAIL, 'ceo'], [STAFF, STAFF_EMAIL, 'customer'], [SUBJ, SUBJ_EMAIL, 'customer'], [OUT, `out${tag}@example.test`, 'customer']]) {
      await c.query('insert into users(id,email,role) values($1,$2,$3)', [id, email, role]);
    }
    await c.query("insert into user_identities(id,account_id,display_name,avatar_status,source_photo_asset_id,source_voice_asset_id,provider_renderable_avatar_id) values($1,$2,'Look S','READY',gen_random_uuid(),gen_random_uuid(),$3)", [IDENT, SUBJ, LOOK]);
    const scope = randomUUID(), bind = randomUUID();
    await c.query("insert into provider_verified_account_scopes(id,provider,provider_account_fingerprint,canonical_scope_key,evidence_digest,evidence_ref) values($1,'heygen',$2,$3,$3,'ref')", [scope, FP, hex(SUBJ + 'scope')]);
    await c.query("insert into provider_account_bindings(id,application_account_id,provider,environment,project_id,database_binding_sha256,credential_scope_fingerprint,origin_scope_key,lifecycle_state) values($1,$2,'heygen','pgt','pgt',$3,$3,$3,'active')", [bind, SUBJ, hex(SUBJ + 'b')]);
    await c.query("insert into provider_account_binding_promotions(binding_id,application_account_id,origin_scope_key,verified_account_scope_id,state,evidence_digest,evidence_ref,verified_at) values($1,$2,$3,$4,'verified',$3,'ref',now())", [bind, SUBJ, hex(SUBJ + 'b'), scope]);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback').catch(() => {});
    throw error;
  } finally { c.release(); }
}

test.before(async () => { if (skip) return; await connect(); await seed(); });
test.after(async () => { if (pool) await pool.end(); });

test('magic-link proof row is what makes a staff grant possible', opts, async () => {
  // Before any sign-in proof the CEO cannot manage staff.
  assert.deepEqual(await repo.staffContext({ accountId: CEO }), { isCeo: true, ceoEmailVerified: false, canManageStaff: false, hasStaffGrant: false });
  assert.match(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: STAFF, explicitGrant: true })), /^LUX_STAFF_(EMAIL_UNVERIFIED|GRANTOR_REQUIRED)$/);
  // A proof recorded for a different address than the account's does not count.
  assert.deepEqual(await proof({ accountId: CEO, email: `other${tag}@luxmarketingcompany.com`, magicTokenHash: hex('wrong' + tag) }), { recorded: true });
  assert.equal((await repo.staffContext({ accountId: CEO })).canManageStaff, false);
  // The real sign-in proof (case-insensitive) unlocks the CEO.
  assert.deepEqual(await proof({ accountId: CEO, email: CEO_EMAIL.toUpperCase(), magicTokenHash: hex('ceo' + tag) }), { recorded: true });
  assert.deepEqual(await proof({ accountId: CEO, email: CEO_EMAIL, magicTokenHash: hex('ceo' + tag) }), { recorded: false }, 'replay is a no-op');
  const row = (await q("select token_hash, challenge_type, used_at is not null as used from auth_challenges where account_id=$1 and email=$2", [CEO, CEO_EMAIL])).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].challenge_type, 'magic_link');
  assert.equal(row[0].used, true);
  assert.notEqual(row[0].token_hash, hex('ceo' + tag), 'stored hash is domain-separated');
  assert.equal((await repo.staffContext({ accountId: CEO })).canManageStaff, true);
  // Staff member still unverified → refused; after their own proof → granted.
  assert.equal(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: STAFF, explicitGrant: true })), 'LUX_STAFF_EMAIL_UNVERIFIED');
  await proof({ accountId: STAFF, email: STAFF_EMAIL, magicTokenHash: hex('staff' + tag) });
  assert.equal(await code(repo.grantStaff({ grantorAccountId: CEO, staffAccountId: STAFF, explicitGrant: true })), 'OK');
  const { grants } = await repo.listStaffGrants({ grantorAccountId: CEO });
  const mine = grants.find(g => g.staffAccountId === STAFF);
  assert.equal(mine.active, true);
  assert.ok(!mine.emailRef.includes(`staff${tag}`), 'email is masked');
  assert.deepEqual(await repo.staffContext({ accountId: STAFF }), { isCeo: false, ceoEmailVerified: false, canManageStaff: false, hasStaffGrant: true });
  assert.equal(await code(repo.staffContext({ accountId: OUT })), 'LUX_STAFF_PAGE_FORBIDDEN');
  assert.equal(await code(repo.listStaffGrants({ grantorAccountId: STAFF })), 'LUX_STAFF_GRANTOR_REQUIRED');
});

test('staff lookup and run-time capability check write evidence with a 30-day window (HeyGen mocked)', opts, async () => {
  const target = await repo.lookupStaffTarget({ actorAccountId: STAFF, email: SUBJ_EMAIL.toUpperCase() });
  assert.equal(target.accountId, SUBJ);
  assert.equal(target.identities.length, 1);
  assert.equal(target.identities[0].identityId, IDENT);
  assert.equal(await code(repo.lookupStaffTarget({ actorAccountId: OUT, email: SUBJ_EMAIL })), 'LUX_STAFF_PAGE_FORBIDDEN');

  let reads = 0;
  const body = engines => JSON.stringify({ data: { id: LOOK, avatar_type: 'digital_twin', supported_api_engines: engines, status: 'completed' } });
  let engines = ['avatar_iv'];
  const reader = {
    resolveBinding: async () => ({ providerSpaceFingerprint: FP }),
    assertBinding: () => {},
    readLook: async id => { reads += 1; assert.equal(id, LOOK); const text = body(engines); return { text, payload: JSON.parse(text) }; },
  };
  const env = { VIDEO_OS_PUBLIC_ORIGIN: 'https://video.example', VIDEO_OS_LUXIFY_ENABLED: 'true' };
  const handler = routeMod.createLuxifyConsentHandler({ authenticate: () => ({ accountId: STAFF }), environment: env, repository: repo, capabilityReader: reader, rateLimit: async () => true });
  const call = async payload => {
    const res = { headers: {}, setHeader(n, v) { this.headers[n] = v; }, end(raw) { this.body = JSON.parse(raw); } };
    await handler({ method: 'POST', url: '/api/video-os-lite/luxify-consent', headers: { origin: env.VIDEO_OS_PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: payload }, res);
    return res;
  };
  const first = await call({ action: 'check-capability', accountId: SUBJ, identityId: IDENT });
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  assert.equal(first.body.eligible, false);
  engines = ['avatar_iv', 'cinematic_avatar'];
  const second = await call({ action: 'check-capability', accountId: SUBJ, identityId: IDENT });
  assert.equal(second.body.eligible, true);
  assert.equal(reads, 2);
  const rows = (await q('select eligible, staff_grant_id is not null as has_grant, provider_space_fingerprint, evidence_sha256, observed_at, expires_at, revoked_at from luxify_look_capability_evidence where account_id=$1 order by observed_at, revoked_at nulls last', [SUBJ])).rows;
  assert.equal(rows.length, 2);
  const open = rows.filter(r => r.revoked_at === null);
  assert.equal(open.length, 1, 'the newer check supersedes the older one');
  assert.equal(open[0].eligible, true);
  assert.equal(open[0].has_grant, true);
  assert.equal(open[0].provider_space_fingerprint, FP);
  assert.equal(open[0].evidence_sha256, hex(body(engines)));
  assert.equal(new Date(open[0].expires_at).getTime() - new Date(open[0].observed_at).getTime(), 30 * DAY);
  // QA M1: checked rows carry created_at = observed_at; a staff-typed legacy row would not.
  assert.equal(Number((await q('select count(*) from luxify_look_capability_evidence where account_id=$1 and created_at <> observed_at', [SUBJ])).rows[0].count), 0);

  // Staff can now approve the look; revoking the staff grant cascades.
  assert.equal(await code(repo.approveLookCreative({ staffAccountId: STAFF, accountId: SUBJ, identityId: IDENT })), 'OK');
  const before = (await repo.listLookCreativeApprovals({ staffAccountId: STAFF, accountId: SUBJ, identityId: IDENT })).approvals.filter(a => a.status === 'active');
  assert.equal(before.length, 1);
  assert.equal(await code(repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: STAFF })), 'OK');
  assert.equal(await code(call({ action: 'check-capability', accountId: SUBJ, identityId: IDENT }).then(r => { if (r.statusCode !== 201) throw Object.assign(new Error('x'), { code: r.body.code }); })), 'LUX_STAFF_GRANT_REQUIRED');
  assert.equal(reads, 2, 'no HeyGen read without a staff grant');
  const after = Number((await q('select count(*) from luxify_look_capability_evidence where account_id=$1 and revoked_at is null', [SUBJ])).rows[0].count);
  assert.equal(after, 0, 'grant revoke cascades to evidence');
});

test('QA I1: only a used magic_link challenge verifies an email; other used challenge types do not', opts, async () => {
  const OUT_EMAIL = `out${tag}@example.test`;
  await q("insert into auth_challenges(account_id,email,token_hash,challenge_type,expires_at,used_at) values($1,$2,$3,'provider_subject_consent_launch',now(),now())", [OUT, OUT_EMAIL, hex('launch' + tag)]);
  assert.equal((await repo.lookupStaffTarget({ actorAccountId: CEO, email: OUT_EMAIL })).emailVerified, false);
  await proof({ accountId: OUT, email: OUT_EMAIL, magicTokenHash: hex('out' + tag) });
  assert.equal((await repo.lookupStaffTarget({ actorAccountId: CEO, email: OUT_EMAIL })).emailVerified, true);
});
