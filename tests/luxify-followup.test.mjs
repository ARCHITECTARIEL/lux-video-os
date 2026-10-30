// Unit tests for the LUXIFY follow-up (QA N-1..N-6, L-3, I-5). No DB, no network.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createLuxifyConsentRepository, lookApprovalDto } from '../db/luxify-consent-repository.js';
import { createLuxifyConsentHandler } from '../routes/video-os-lite/luxify-consent.js';
import { requireLuxifyActivation } from '../routes/video-os-lite/luxify.js';
import {
  LUXIFY_CONSENT_CHALLENGE_TTL_MS,
  LUXIFY_CONSENT_NOTICE_SHA256,
  issueLuxifyConsentChallenge,
  luxifyConsentChallengeDigest,
  verifyLuxifyConsentChallenge,
} from '../lib/luxify-consent-policy.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const ACCOUNT = 'subject-account-test';
const STAFF = 'staff-account-test';
const CEO = 'owner-account-test';
const IDENTITY = '0d0d0d0d-0000-4000-8000-000000000001';
const APPROVAL = '0d0d0d0d-0000-4000-8000-000000000002';
const KEY = '0d0d0d0d-0000-4000-8000-000000000003';
const GRANT = '0d0d0d0d-0000-4000-8000-000000000004';
const FP = 'f'.repeat(64);
const LOOK = 'look_test_1234';
const ORIGIN = 'https://video.example';
const ENV = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: 'followup-route-test-secret-at-least-32-bytes' };

function fakeDb(queue, now = NOW) {
  const log = [];
  const chain = kind => {
    const entry = { kind, calls: [] };
    log.push(entry);
    const proxy = new Proxy(function chainFn() {}, {
      get(_target, prop) {
        if (prop === 'then') {
          let value = queue.shift();
          if (typeof value === 'function') value = value(entry);
          return value instanceof Error ? (_resolve, reject) => reject(value) : resolve => resolve(value ?? []);
        }
        return (...args) => { entry.calls.push([prop, args]); return proxy; };
      },
    });
    return proxy;
  };
  const tx = { execute: async () => [{ now }], select: () => chain('select'), update: () => chain('update'), insert: () => chain('insert') };
  return { log, tx, executor: { transaction: async callback => callback(tx) } };
}
const arg = (entry, method) => entry.calls.find(([name]) => name === method)?.[1]?.[0];
const writes = log => log.filter(entry => entry.kind !== 'select');
const repoFor = queue => { const db = fakeDb(queue); return { db, repo: createLuxifyConsentRepository({ executor: db.executor }) }; };

const staffUser = [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }];
const staffGrant = [{ id: GRANT, staffAccountId: STAFF, staffEmail: 'staff@luxmarketingcompany.com', explicitGrant: true }];
const verified = [{ usedAt: NOW }];
const staffOk = () => [staffUser, staffGrant, verified];
const identity = (overrides = {}) => ({ id: IDENTITY, accountId: ACCOUNT, archivedAt: null, provider: 'heygen', avatarStatus: 'READY', providerRenderableAvatarId: LOOK, ...overrides });
const space = { bindingId: 'b', originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: 's', verifiedAt: NOW, providerSpaceFingerprint: FP };

// ---- N-2 / N-4 / N-6: look approval lifecycle ---------------------------
test('approve-look returns the approval id and binds the READY look (N-2)', async () => {
  const { repo, db } = repoFor([...staffOk(), [identity()], [space], [], [{ id: APPROVAL, expiresAt: new Date('2026-11-09T10:00:00.000Z') }]]);
  const result = await repo.approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY, expiresInDays: 7 });
  assert.deepEqual(result, { approvalId: APPROVAL, expiresAt: '2026-11-09T10:00:00.000Z' });
  const insert = writes(db.log).find(entry => entry.kind === 'insert');
  assert.equal(arg(insert, 'values').staffGrantId, GRANT);
});

test('approve-look refuses an archived identity (N-6) and a look that is not READY (N-4), writing nothing', async () => {
  const archived = repoFor([...staffOk(), [identity({ archivedAt: NOW })]]);
  await assert.rejects(archived.repo.approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUXIFY_LOOK_NOT_FOUND', statusCode: 404 });
  assert.equal(writes(archived.db.log).length, 0);
  for (const overrides of [{ avatarStatus: 'PROCESSING' }, { avatarStatus: 'FAILED' }, { provider: 'other' }]) {
    const notReady = repoFor([...staffOk(), [identity(overrides)]]);
    await assert.rejects(notReady.repo.approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUXIFY_LOOK_NOT_READY', statusCode: 409 });
    assert.equal(writes(notReady.db.log).length, 0);
  }
});

test('revoke-look-approval needs an active staff grant, 404s an unknown id and is idempotent', async () => {
  const noGrant = repoFor([staffUser, []]);
  await assert.rejects(noGrant.repo.revokeLookCreativeApproval({ staffAccountId: STAFF, approvalId: APPROVAL }), { code: 'LUX_STAFF_GRANT_REQUIRED', statusCode: 403 });
  assert.equal(writes(noGrant.db.log).length, 0);
  const missing = repoFor([...staffOk(), []]);
  await assert.rejects(missing.repo.revokeLookCreativeApproval({ staffAccountId: STAFF, approvalId: APPROVAL }), { code: 'LUXIFY_LOOK_APPROVAL_NOT_FOUND', statusCode: 404 });
  const closed = repoFor([...staffOk(), [{ id: APPROVAL, revokedAt: NOW }]]);
  assert.deepEqual(await closed.repo.revokeLookCreativeApproval({ staffAccountId: STAFF, approvalId: APPROVAL }), { changed: false });
  assert.equal(writes(closed.db.log).length, 0);
  const open = repoFor([...staffOk(), [{ id: APPROVAL, revokedAt: null }], [{ id: APPROVAL }]]);
  assert.deepEqual(await open.repo.revokeLookCreativeApproval({ staffAccountId: STAFF, approvalId: APPROVAL }), { changed: true });
  assert.deepEqual(arg(writes(open.db.log)[0], 'set'), { revokedAt: NOW });
});

test('list-look-approvals is staff-only, scoped to one account, and returns masked fields only (N-2)', async () => {
  const noGrant = repoFor([staffUser, []]);
  await assert.rejects(noGrant.repo.listLookCreativeApprovals({ staffAccountId: STAFF, accountId: ACCOUNT }), { code: 'LUX_STAFF_GRANT_REQUIRED' });
  await assert.rejects(repoFor([]).repo.listLookCreativeApprovals({ staffAccountId: STAFF, accountId: '' }), { code: 'LUXIFY_CONSENT_SIGN_IN_REQUIRED' });
  await assert.rejects(repoFor([]).repo.listLookCreativeApprovals({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: 'nope' }), { code: 'LUXIFY_CONSENT_INVALID_REQUEST' });
  const row = (overrides = {}) => ({
    id: APPROVAL, identityId: IDENTITY, providerLookId: LOOK, staffGrantId: GRANT, approvedAt: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-11-08T00:00:00.000Z'), revokedAt: null, grantRevokedAt: null, accountId: ACCOUNT, approverAccountId: STAFF, providerSpaceFingerprint: FP, ...overrides,
  });
  const ok = repoFor([...staffOk(), [row(), row({ revokedAt: NOW }), row({ expiresAt: new Date('2026-11-02T09:00:00.000Z') }), row({ grantRevokedAt: NOW, staffGrantId: 'other' })]]);
  const { approvals } = await ok.repo.listLookCreativeApprovals({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY });
  assert.deepEqual(approvals.map(item => item.status), ['active', 'revoked', 'expired', 'revoked']);
  assert.deepEqual(approvals.map(item => item.approvedUnderYourGrant), [true, true, true, false]);
  assert.deepEqual(Object.keys(approvals[1]).sort(), ['approvalId', 'approvedAt', 'approvedUnderYourGrant', 'closedAt', 'expiresAt', 'identityId', 'lookRef', 'status']);
  assert.equal(approvals[0].lookRef, '…1234');
  const text = JSON.stringify(approvals);
  for (const secret of [ACCOUNT, STAFF, FP, LOOK, 'luxmarketingcompany']) assert.equal(text.includes(secret), false, `leaked ${secret}`);
  assert.equal(writes(ok.db.log).length, 0, 'list never writes');
  const limit = ok.db.log.at(-1).calls.find(([name]) => name === 'limit');
  assert.deepEqual(limit[1], [50]);
  assert.equal(lookApprovalDto(row({ providerLookId: 'ab' })).lookRef, '…');
});

// ---- N-1 / I-5: staff grant revoke ------------------------------------------
const ceo = [{ id: CEO, email: 'owner@luxmarketingcompany.com', role: 'ceo' }];
test('revoke-staff requires the CEO with a verified Lux email, like grant-staff (I-5)', async () => {
  const cases = [
    [[[{ ...ceo[0], role: 'customer' }], verified], 'LUX_STAFF_GRANTOR_REQUIRED'],
    [[ceo, []], 'LUX_STAFF_EMAIL_UNVERIFIED'],
    [[[{ ...ceo[0], email: 'owner@luxmarketingcompany.com.example.test' }], verified], 'LUX_STAFF_DOMAIN_REQUIRED'],
    [[[{ ...ceo[0], email: null }], verified], 'LUX_STAFF_DOMAIN_REQUIRED'],
  ];
  for (const [queue, code] of cases) {
    const { repo, db } = repoFor(queue);
    await assert.rejects(repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: STAFF }), { code, statusCode: 403 });
    assert.equal(writes(db.log).length, 0, code);
  }
});

test('revoking a staff grant closes its open look and creative approvals in the same transaction (N-1)', async () => {
  const { repo, db } = repoFor([ceo, verified, [{ id: GRANT }], [{ id: 'l1' }, { id: 'l2' }], [{ id: 'a1' }], [], [], []]);
  const result = await repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: STAFF });
  assert.deepEqual(result, { revoked: 1, closedLookApprovals: 2, closedCreativeApprovals: 1 });
  const updates = writes(db.log);
  assert.equal(updates.length, 3, 'grant + look approvals + asset approvals');
  for (const entry of updates) assert.deepEqual(arg(entry, 'set'), { revokedAt: NOW });
  const none = repoFor([ceo, verified, []]);
  assert.deepEqual(await none.repo.revokeStaffGrant({ grantorAccountId: CEO, staffAccountId: STAFF }), { revoked: 0, closedLookApprovals: 0, closedCreativeApprovals: 0 });
  assert.equal(writes(none.db.log).length, 0);
});

// ---- L-3: single-use consent challenge ------------------------------------
test('consent challenges are distinct per issue, keep the 10-minute expiry, and digest stably', () => {
  const at = NOW.getTime();
  const a = issueLuxifyConsentChallenge({ accountId: ACCOUNT, identityId: IDENTITY, now: at, env: ENV });
  const b = issueLuxifyConsentChallenge({ accountId: ACCOUNT, identityId: IDENTITY, now: at, env: ENV });
  assert.notEqual(a, b);
  assert.equal(verifyLuxifyConsentChallenge(a, { accountId: ACCOUNT, identityId: IDENTITY, now: at + LUXIFY_CONSENT_CHALLENGE_TTL_MS - 1, env: ENV }), true);
  assert.throws(() => verifyLuxifyConsentChallenge(a, { accountId: ACCOUNT, identityId: IDENTITY, now: at + LUXIFY_CONSENT_CHALLENGE_TTL_MS, env: ENV }), { code: 'LUXIFY_CONSENT_CHALLENGE_INVALID' });
  assert.equal(LUXIFY_CONSENT_CHALLENGE_TTL_MS, 600_000);
  assert.match(luxifyConsentChallengeDigest(a), /^[a-f0-9]{64}$/);
  assert.equal(luxifyConsentChallengeDigest(a), luxifyConsentChallengeDigest(a));
  assert.notEqual(luxifyConsentChallengeDigest(a), luxifyConsentChallengeDigest(b));
});

const grantInput = (overrides = {}) => ({
  accountId: ACCOUNT, identityId: IDENTITY, idempotencyKey: KEY, noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256,
  cinematicGenerationAuthorization: true, providerProcessingAuthorization: true, challengeSha256: 'c'.repeat(64), ...overrides,
});
const sourceRow = { id: 'src', accountId: ACCOUNT, identityId: IDENTITY, faceAuthorization: true, providerProcessingAuthorization: true, revokedAt: null };

test('grant without a challenge digest is refused; a consumed challenge is refused and no consent is written (L-3)', async () => {
  for (const challengeSha256 of [undefined, '', 'x'.repeat(64), 'C'.repeat(64)]) {
    const { repo, db } = repoFor([]);
    await assert.rejects(repo.grantConsent(grantInput({ challengeSha256 })), { code: 'LUXIFY_CONSENT_CHALLENGE_INVALID', statusCode: 409 });
    assert.equal(db.log.length, 0);
  }
  const replay = repoFor([[], [identity()], [sourceRow], [space], [], []]);
  await assert.rejects(replay.repo.grantConsent(grantInput()), { code: 'LUXIFY_CONSENT_CHALLENGE_USED', statusCode: 409 });
  const inserts = writes(replay.db.log).filter(entry => entry.kind === 'insert');
  assert.equal(inserts.length, 1, 'only the (conflicting) challenge insert ran');
  assert.ok(inserts[0].calls.some(([name]) => name === 'onConflictDoNothing'));
});

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = raw ? JSON.parse(raw) : null; } };
}
function request(body) {
  return { method: 'POST', url: '/api/video-os-lite/luxify-consent', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body };
}
function routeFixture(overrides = {}) {
  const calls = [];
  const record = (name, value) => async input => { calls.push([name, input]); if (overrides[name]) return overrides[name](input); return value; };
  const repository = {
    grantConsent: record('grantConsent', { consent: { id: APPROVAL, status: 'active' }, replayed: false }),
    approveLookCreative: record('approveLookCreative', { approvalId: APPROVAL, expiresAt: '2026-11-09T10:00:00.000Z' }),
    revokeLookCreativeApproval: record('revokeLookCreativeApproval', { changed: true }),
    listLookCreativeApprovals: record('listLookCreativeApprovals', { approvals: [{ approvalId: APPROVAL, status: 'active' }] }),
    revokeStaffGrant: record('revokeStaffGrant', { revoked: 1, closedLookApprovals: 2, closedCreativeApprovals: 0 }),
  };
  const handler = createLuxifyConsentHandler({ authenticate: () => ({ accountId: STAFF }), environment: ENV, repository, now: () => NOW.getTime() });
  return { handler, calls };
}

test('route: approve-look returns the approval id; list and revoke act as the signed-in staff account', async () => {
  const { handler, calls } = routeFixture();
  const approve = response();
  await handler(request({ action: 'approve-look', accountId: ACCOUNT, identityId: IDENTITY }), approve);
  assert.equal(approve.statusCode, 201);
  assert.deepEqual(approve.body, { ok: true, approvalId: APPROVAL, expiresAt: '2026-11-09T10:00:00.000Z' });
  const list = response();
  await handler(request({ action: 'list-look-approvals', accountId: ACCOUNT, identityId: IDENTITY.toUpperCase() }), list);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.approvals, [{ approvalId: APPROVAL, status: 'active' }]);
  const revoke = response();
  await handler(request({ action: 'revoke-look-approval', approvalId: list.body.approvals[0].approvalId }), revoke);
  assert.deepEqual(revoke.body, { ok: true, changed: true });
  const staffRevoke = response();
  await handler(request({ action: 'revoke-staff', staffAccountId: 'other-staff-test' }), staffRevoke);
  assert.deepEqual(staffRevoke.body, { ok: true, revoked: 1, closedLookApprovals: 2, closedCreativeApprovals: 0 });
  assert.deepEqual(calls.map(([name, input]) => [name, input.grantorAccountId ?? input.staffAccountId]), [
    ['approveLookCreative', STAFF], ['listLookCreativeApprovals', STAFF], ['revokeLookCreativeApproval', STAFF], ['revokeStaffGrant', STAFF],
  ]);
  assert.equal(calls[1][1].accountId, ACCOUNT);
  assert.equal(calls[1][1].identityId, IDENTITY);
  const bad = response();
  await handler(request({ action: 'list-look-approvals', accountId: ACCOUNT, extra: true }), bad);
  assert.equal(bad.statusCode, 400);
  const noAccount = response();
  await handler(request({ action: 'list-look-approvals' }), noAccount);
  assert.equal(noAccount.statusCode, 400);
  assert.equal(calls.length, 4);
});

test('route: grant passes the digest of the verified challenge; a used challenge is a 409', async () => {
  const challenge = issueLuxifyConsentChallenge({ accountId: STAFF, identityId: IDENTITY, now: NOW.getTime(), env: ENV });
  const body = { action: 'grant', identityId: IDENTITY, idempotencyKey: KEY, challenge, noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true };
  const { handler, calls } = routeFixture();
  const res = response();
  await handler(request(body), res);
  assert.equal(res.statusCode, 201);
  assert.equal(calls[0][1].challengeSha256, luxifyConsentChallengeDigest(challenge));
  const used = routeFixture({ grantConsent: () => { throw Object.assign(new Error('This consent notice was already used. Reload and try again.'), { code: 'LUXIFY_CONSENT_CHALLENGE_USED', statusCode: 409 }); } });
  const usedRes = response();
  await used.handler(request(body), usedRes);
  assert.equal(usedRes.statusCode, 409);
  assert.equal(usedRes.body.code, 'LUXIFY_CONSENT_CHALLENGE_USED');
});

// ---- N-3 ---------------------------------------------------------------------
test('route activation reports LUXIFY_CREATIVE_APPROVAL_REQUIRED consistently (N-3)', async () => {
  const env = { VIDEO_OS_LUXIFY_ENABLED: 'true', VIDEO_OS_LUXIFY_ACCOUNT_ID: ACCOUNT, VIDEO_OS_LUXIFY_720P_LUX_CREDITS: '41', VIDEO_OS_LUXIFY_1080P_LUX_CREDITS: '97' };
  const deps = reject => ({
    env,
    runtimePreflight: async () => ({ ready: true, reasons: [] }),
    authorizePremium: async () => true,
    resolveEligibility: async () => { throw reject; },
  });
  const approval = Object.assign(new Error('This look needs an active Lux staff creative approval.'), { code: 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', statusCode: 409, failureCategory: 'CONSENT' });
  await assert.rejects(requireLuxifyActivation(ACCOUNT, [IDENTITY], deps(approval)), { code: 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', statusCode: 409 });
  const other = Object.assign(new Error('x'), { code: 'LUXIFY_CONSENT_MISSING', statusCode: 409 });
  await assert.rejects(requireLuxifyActivation(ACCOUNT, [IDENTITY], deps(other)), { code: 'luxify_look_unavailable', statusCode: 409 });
  // Off by default: without the flag nothing below the static gates runs.
  await assert.rejects(requireLuxifyActivation(ACCOUNT, [IDENTITY], { ...deps(approval), env: {} }), { code: 'luxify_unavailable', statusCode: 503 });
});

// ---- 0019 migration (static) -------------------------------------------------
test('0019 adds single-use challenge storage and the grant-revoke cascade without editing 0018', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const [sql, journalText, snapshotText] = await Promise.all([
    read('../drizzle/0019_luxify_followup.sql'), read('../drizzle/meta/_journal.json'), read('../drizzle/meta/0019_snapshot.json'),
  ]);
  const text = sql.replace(/\r\n/g, '\n');
  assert.match(text, /CREATE TABLE "luxify_consent_challenge_uses"/);
  assert.match(text, /"challenge_sha256" text PRIMARY KEY NOT NULL/);
  assert.match(text, /BEFORE UPDATE OR DELETE ON luxify_consent_challenge_uses/);
  assert.match(text, /AFTER UPDATE OF revoked_at ON lux_staff_grants/);
  assert.match(text, /UPDATE luxify_look_creative_approvals\s+SET revoked_at = greatest\(NEW\.revoked_at, approved_at\)/);
  assert.match(text, /UPDATE luxify_creative_asset_approvals\s+SET revoked_at = greatest\(NEW\.revoked_at, approved_at\)/);
  assert.doesNotMatch(text, /DROP |ALTER TABLE "luxify_cinematic_consents"|CREATE OR REPLACE/);
  const journal = JSON.parse(journalText);
  assert.equal(journal.entries.at(-1).tag, '0019_luxify_followup');
  assert.equal(journal.entries.at(-2).tag, '0018_luxify_consent_lifecycle');
  assert.ok(JSON.parse(snapshotText).tables['public.luxify_consent_challenge_uses']);
});
