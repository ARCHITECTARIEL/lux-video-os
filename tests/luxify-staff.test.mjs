// Unit tests for LUXIFY-STAFF-1031: magic-link email proof, the /luxify-staff
// page actions, and the run-time capability check. No DB, no network: HeyGen
// and the space binding are always mocked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createLuxifyConsentRepository } from '../db/luxify-consent-repository.js';
import { magicLinkProofTokenHash, recordMagicLinkEmailProof } from '../db/auth-email-proof.js';
import { createLuxifyConsentHandler } from '../routes/video-os-lite/luxify-consent.js';
import { requireLuxifyActivation } from '../routes/video-os-lite/luxify.js';
import { handleAuthRequest } from '../api/video-os-lite/auth.js';
import { readHeygenAvatarLookRaw } from '../services/heygen.js';
import {
  LUXIFY_CAPABILITY_OWNERSHIP_FIELD,
  LUXIFY_CAPABILITY_REQUIRED_STATUS,
  deriveLuxifyLookCapability,
} from '../lib/luxify-look-capability.js';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const DAY = 86_400_000;
const ACCOUNT = 'subject-account-test';
const STAFF = 'staff-account-test';
const CEO = 'owner-account-test';
const IDENTITY = '0d0d0d0d-0000-4000-8000-000000000001';
const GRANT = '0d0d0d0d-0000-4000-8000-000000000004';
const EVIDENCE = '0d0d0d0d-0000-4000-8000-000000000005';
const FP = 'f'.repeat(64);
const LOOK = 'look_test_1234';
const GROUP = 'group_test_5678';
const ORIGIN = 'https://video.example';
const ENV = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: 'staff-route-test-secret-at-least-32-bytes-long' };

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
  return { log, tx, executor: { transaction: async callback => callback(tx), insert: () => chain('insert') } };
}
const arg = (entry, method) => entry.calls.find(([name]) => name === method)?.[1]?.[0];
const writes = log => log.filter(entry => entry.kind !== 'select');
const repoFor = queue => { const db = fakeDb(queue); return { db, repo: createLuxifyConsentRepository({ executor: db.executor }) }; };

const staffUser = [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }];
const staffGrant = [{ id: GRANT, staffAccountId: STAFF, staffEmail: 'staff@luxmarketingcompany.com', explicitGrant: true }];
const verified = [{ usedAt: NOW }];
const staffOk = () => [staffUser, staffGrant, verified];
const identity = (overrides = {}) => ({ id: IDENTITY, accountId: ACCOUNT, archivedAt: null, provider: 'heygen', avatarStatus: 'READY', providerRenderableAvatarId: LOOK, providerAvatarGroupId: GROUP, ...overrides });
const space = { bindingId: 'b', originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: 's', verifiedAt: NOW, providerSpaceFingerprint: FP };

// Mirrors the real GET /v3/avatars/looks/{id} shape observed in LUXIFY-LOOK-READ-1101
// (ids and URLs synthetic): photo_avatar, engines avatar_v/avatar_iv/avatar_iii.
const lookBody = (overrides = {}) => JSON.stringify({ data: {
  avatar_type: 'photo_avatar', group_id: GROUP, id: LOOK, image_height: 1920, image_width: 1080, name: 'Look',
  preferred_orientation: 'portrait', preview_image_url: 'https://media.example/preview.webp', status: 'completed',
  supported_api_engines: ['avatar_v', 'avatar_iv', 'avatar_iii'], tags: [], ...overrides,
} });
const derive = (overrides, expectedGroupId = GROUP) => { const text = lookBody(overrides); return deriveLuxifyLookCapability({ providerLookId: LOOK, expectedGroupId, responseText: text, payload: JSON.parse(text) }); };
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');

// ---- capability derivation (owner rule Nov 1: completed + owned, no engine check)
test('capability: a completed look in the pinned account\'s avatar group is eligible; engines never decide', () => {
  assert.equal(LUXIFY_CAPABILITY_REQUIRED_STATUS, 'completed');
  assert.equal(LUXIFY_CAPABILITY_OWNERSHIP_FIELD, 'data.group_id');
  const text = lookBody();
  const ok = deriveLuxifyLookCapability({ providerLookId: LOOK, expectedGroupId: GROUP, responseText: text, payload: JSON.parse(text) });
  assert.equal(ok.eligible, true);
  assert.equal(ok.ineligibleReason, null);
  assert.equal(ok.avatarType, 'photo_avatar');
  assert.deepEqual([...ok.supportedApiEngines], ['avatar_v', 'avatar_iv', 'avatar_iii']);
  assert.equal(ok.evidenceSha256, sha(text), 'evidence hash is the hash of the exact response body');
  // No engine requirement: any engine list, an empty list or no field at all.
  for (const overrides of [{ supported_api_engines: ['avatar_iv'] }, { supported_api_engines: [] }, { supported_api_engines: undefined }, { avatar_type: 'digital_twin' }]) {
    assert.equal(derive(overrides).eligible, true, JSON.stringify(overrides));
  }
  assert.deepEqual([...derive({ supported_api_engines: ['avatar_v', 'avatar_v'] }).supportedApiEngines], ['avatar_v']);
});

test('capability: not completed or another owner is recorded as eligible=false', () => {
  for (const status of ['processing', 'pending', 'failed', 'COMPLETED']) {
    const d = derive({ status });
    assert.equal(d.eligible, false, status);
    assert.equal(d.ineligibleReason, 'NOT_COMPLETED');
  }
  const other = derive({ group_id: 'group_someone_else' });
  assert.equal(other.eligible, false);
  assert.equal(other.ineligibleReason, 'OWNER_MISMATCH');
  assert.equal(derive({ group_id: 'group_someone_else', status: 'processing' }).ineligibleReason, 'OWNER_MISMATCH');
});

test('capability: fails closed (no evidence) on a wrong look id, unprovable ownership or a malformed read', () => {
  const cases = [
    [{ id: 'look_other' }, 'LOOK_MISMATCH'],
    [{ group_id: undefined }, 'OWNERSHIP_FIELD_MISSING'],
    [{ group_id: '' }, 'OWNERSHIP_FIELD_MISSING'],
    [{ status: undefined }, 'STATUS_MISSING'],
    [{ avatar_type: undefined }, 'AVATAR_TYPE_MISSING'],
    [{ supported_api_engines: 'avatar_v' }, 'ENGINES_FIELD_INVALID'],
    [{ supported_api_engines: ['ok', 7] }, 'ENGINES_FIELD_INVALID'],
    [{ supported_api_engines: Array.from({ length: 21 }, (_, i) => `e${i}`) }, 'ENGINES_FIELD_INVALID'],
  ];
  for (const [overrides, reason] of cases) {
    assert.throws(() => derive(overrides), { code: 'LUXIFY_CAPABILITY_UNPROVEN', statusCode: 409, reason }, JSON.stringify(overrides));
  }
  for (const expected of [undefined, null, '', 'bad group']) {
    const text = lookBody();
    assert.throws(() => deriveLuxifyLookCapability({ providerLookId: LOOK, expectedGroupId: expected, responseText: text, payload: JSON.parse(text) }), { reason: 'OWNERSHIP_UNPROVEN' });
  }
  for (const text of [JSON.stringify({ data: [] }), JSON.stringify({})]) {
    assert.throws(() => deriveLuxifyLookCapability({ providerLookId: LOOK, expectedGroupId: GROUP, responseText: text, payload: JSON.parse(text) }), { reason: 'RESPONSE_SHAPE' });
  }
  assert.throws(() => deriveLuxifyLookCapability({ providerLookId: LOOK, expectedGroupId: GROUP, responseText: '', payload: JSON.parse(lookBody()) }), { reason: 'RESPONSE_EMPTY' });
  assert.throws(() => deriveLuxifyLookCapability({ providerLookId: 'bad id', expectedGroupId: GROUP, responseText: lookBody(), payload: JSON.parse(lookBody()) }), { reason: 'LOOK_ID_INVALID' });
});

// ---- repository: capability check steps ------------------------------------
test('prepareLookCapabilityCheck needs a staff grant and a READY look and writes nothing', async () => {
  const ok = repoFor([...staffOk(), [identity()], [space]]);
  assert.deepEqual(await ok.repo.prepareLookCapabilityCheck({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }),
    { accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, providerAvatarGroupId: GROUP });
  assert.equal(writes(ok.db.log).length, 0);
  for (const providerAvatarGroupId of [null, '', 'bad group']) {
    const noGroup = repoFor([...staffOk(), [identity({ providerAvatarGroupId })], [space]]);
    await assert.rejects(noGroup.repo.prepareLookCapabilityCheck({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', statusCode: 409 });
    assert.equal(writes(noGroup.db.log).length, 0);
  }
  const noGrant = repoFor([staffUser, []]);
  await assert.rejects(noGrant.repo.prepareLookCapabilityCheck({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUX_STAFF_GRANT_REQUIRED', statusCode: 403 });
  const unverified = repoFor([staffUser, staffGrant, []]);
  await assert.rejects(unverified.repo.prepareLookCapabilityCheck({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUX_STAFF_EMAIL_UNVERIFIED' });
  const notReady = repoFor([...staffOk(), [identity({ avatarStatus: 'PROCESSING' })]]);
  await assert.rejects(notReady.repo.prepareLookCapabilityCheck({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUXIFY_LOOK_NOT_READY' });
});

test('recordCheckedLookCapability uses DB now and an exact 30-day window, superseding older evidence', async () => {
  const { repo, db } = repoFor([...staffOk(), [identity()], [space], [], [{ id: EVIDENCE }]]);
  const result = await repo.recordCheckedLookCapability({
    staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, providerAvatarGroupId: GROUP,
    eligible: true, avatarType: 'photo_avatar', supportedApiEngines: ['avatar_v', 'avatar_iv', 'avatar_iii'], evidenceSha256: 'a'.repeat(64),
  });
  assert.deepEqual(result, { evidenceId: EVIDENCE, eligible: true, observedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString() });
  const [update, insert] = writes(db.log);
  assert.equal(update.kind, 'update');
  assert.ok(arg(update, 'set').revokedAt instanceof Date);
  const values = arg(insert, 'values');
  assert.equal(values.staffGrantId, GRANT);
  assert.equal(values.capability, 'cinematic_avatar');
  assert.equal(values.providerSpaceFingerprint, FP);
  assert.equal(values.source, 'heygen_check', 'L5: the check path is the writer of source=heygen_check');
  assert.equal(values.expiresAt.getTime() - values.observedAt.getTime(), 30 * DAY);
});

test('recordCheckedLookCapability fails closed when the look or space changed, or input is invalid', async () => {
  const input = { staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, providerAvatarGroupId: GROUP, eligible: true, avatarType: 'photo_avatar', supportedApiEngines: ['avatar_v'], evidenceSha256: 'a'.repeat(64) };
  const moved = repoFor([...staffOk(), [identity({ providerRenderableAvatarId: 'look_new_9999' })], [space]]);
  await assert.rejects(moved.repo.recordCheckedLookCapability(input), { code: 'LUXIFY_CAPABILITY_STALE', statusCode: 409 });
  assert.equal(writes(moved.db.log).length, 0);
  const otherSpace = repoFor([...staffOk(), [identity()], [{ ...space, providerSpaceFingerprint: 'd'.repeat(64) }]]);
  await assert.rejects(otherSpace.repo.recordCheckedLookCapability(input), { code: 'LUXIFY_CAPABILITY_STALE' });
  assert.equal(writes(otherSpace.db.log).length, 0);
  const regrouped = repoFor([...staffOk(), [identity({ providerAvatarGroupId: 'group_changed_0000' })], [space]]);
  await assert.rejects(regrouped.repo.recordCheckedLookCapability(input), { code: 'LUXIFY_CAPABILITY_STALE' });
  assert.equal(writes(regrouped.db.log).length, 0);
  for (const bad of [{ providerAvatarGroupId: undefined }, { providerAvatarGroupId: 'bad group' }, { evidenceSha256: 'x' }, { eligible: 'true' }, { avatarType: 'bad type' }, { supportedApiEngines: ['ok', 'bad engine'] }, { providerSpaceFingerprint: 'f' }]) {
    const r = repoFor([]);
    await assert.rejects(r.repo.recordCheckedLookCapability({ ...input, ...bad }), { code: 'LUXIFY_CAPABILITY_EVIDENCE_INVALID', statusCode: 400 });
    assert.equal(r.db.log.length, 0);
  }
});

// ---- repository: staff page access -----------------------------------------
test('staff page context: CEO or active staff only; everyone else is refused', async () => {
  const customer = repoFor([[{ id: ACCOUNT, email: 'a@example.test', role: 'customer' }], [{ id: ACCOUNT, email: 'a@example.test' }], []]);
  await assert.rejects(customer.repo.staffContext({ accountId: ACCOUNT }), { code: 'LUX_STAFF_PAGE_FORBIDDEN', statusCode: 403 });
  const ceoUnverified = repoFor([[{ id: CEO, email: 'ceo@luxmarketingcompany.com', role: 'ceo' }], [], [{ id: CEO, email: 'ceo@luxmarketingcompany.com' }], []]);
  assert.deepEqual(await ceoUnverified.repo.staffContext({ accountId: CEO }), { isCeo: true, ceoEmailVerified: false, canManageStaff: false, hasStaffGrant: false });
  const ceo = repoFor([[{ id: CEO, email: 'ceo@luxmarketingcompany.com', role: 'ceo' }], verified, [{ id: CEO, email: 'ceo@luxmarketingcompany.com' }], []]);
  assert.deepEqual(await ceo.repo.staffContext({ accountId: CEO }), { isCeo: true, ceoEmailVerified: true, canManageStaff: true, hasStaffGrant: false });
  const staff = repoFor([[{ id: STAFF, email: 'staff@luxmarketingcompany.com', role: 'customer' }], ...staffOk()]);
  assert.deepEqual(await staff.repo.staffContext({ accountId: STAFF }), { isCeo: false, ceoEmailVerified: false, canManageStaff: false, hasStaffGrant: true });
  for (const r of [customer, ceoUnverified, ceo, staff]) assert.equal(writes(r.db.log).length, 0);
});

test('list-staff is CEO-only and masks ids and emails; staff-lookup refuses non-staff', async () => {
  const ceoRows = [[{ id: CEO, email: 'ceo@luxmarketingcompany.com', role: 'ceo' }], verified];
  const { repo } = repoFor([...ceoRows, [{ id: GRANT, staffAccountId: 'user-abcdef123456', staffEmail: 'staff@luxmarketingcompany.com', grantedAt: NOW, revokedAt: null }]]);
  const { grants } = await repo.listStaffGrants({ grantorAccountId: CEO });
  assert.deepEqual(grants[0], { staffAccountId: 'user-abcdef123456', staffRef: '…3456', emailRef: 's…@luxmarketingcompany.com', active: true, grantedAt: NOW.toISOString() });
  const notCeo = repoFor([[{ id: STAFF, email: 'staff@luxmarketingcompany.com', role: 'customer' }]]);
  await assert.rejects(notCeo.repo.listStaffGrants({ grantorAccountId: STAFF }), { code: 'LUX_STAFF_GRANTOR_REQUIRED', statusCode: 403 });
  const outsider = repoFor([[{ id: ACCOUNT, email: 'a@example.test', role: 'customer' }], [{ id: ACCOUNT, email: 'a@example.test' }], []]);
  await assert.rejects(outsider.repo.lookupStaffTarget({ actorAccountId: ACCOUNT, email: 'x@example.test' }), { code: 'LUX_STAFF_PAGE_FORBIDDEN' });
  const found = repoFor([...ceoRows, [{ id: 'user-target-0001', email: 'Subject@Example.test' }], [], [{ id: IDENTITY, displayName: 'Look A', providerRenderableAvatarId: LOOK }]]);
  const target = await found.repo.lookupStaffTarget({ actorAccountId: CEO, email: ' subject@example.test ' });
  assert.deepEqual(target, { accountId: 'user-target-0001', accountRef: '…0001', emailVerified: false, identities: [{ identityId: IDENTITY, identityRef: '…0001', displayName: 'Look A', lookRef: '…1234' }] });
  const ambiguous = repoFor([...ceoRows, [{ id: 'u1', email: 'x@example.test' }, { id: 'u2', email: 'X@example.test' }]]);
  await assert.rejects(ambiguous.repo.lookupStaffTarget({ actorAccountId: CEO, email: 'x@example.test' }), { code: 'LUX_STAFF_ACCOUNT_NOT_FOUND', statusCode: 404 });
  await assert.rejects(repoFor([]).repo.lookupStaffTarget({ actorAccountId: CEO, email: 'not-an-email' }), { statusCode: 400 });
});

// ---- route: run-time capability check --------------------------------------
function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { try { this.body = raw ? JSON.parse(raw) : null; } catch { this.body = raw; } } };
}
function request(body, headers = {}) {
  return { method: 'POST', url: '/api/video-os-lite/luxify-consent', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body };
}
const FLAG_ON = { ...ENV, VIDEO_OS_LUXIFY_ENABLED: 'true' };
function capabilityFixture({ binding = { providerSpaceFingerprint: FP }, read, resolveThrows = false, prepare, environment = FLAG_ON, allow = true } = {}) {
  const calls = [];
  const rateLimit = async input => { calls.push(['rate', input]); return typeof allow === 'function' ? allow(input) : allow; };
  const repository = {
    prepareLookCapabilityCheck: async input => { calls.push(['prepare', input]); if (prepare) return prepare(input); return { accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, providerAvatarGroupId: GROUP }; },
    recordCheckedLookCapability: async input => { calls.push(['record', input]); return { evidenceId: EVIDENCE, eligible: input.eligible, observedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString() }; },
    staffContext: async input => { calls.push(['context', input]); return { isCeo: false, ceoEmailVerified: false, canManageStaff: false, hasStaffGrant: true }; },
  };
  const capabilityReader = {
    resolveBinding: async input => { calls.push(['binding', input]); if (resolveThrows) throw new Error('binding unavailable'); return binding; },
    assertBinding: () => { calls.push(['assert']); },
    readLook: async lookId => { calls.push(['read', lookId]); if (read) return read(lookId); const text = lookBody(); return { text, payload: JSON.parse(text) }; },
  };
  const handler = createLuxifyConsentHandler({ authenticate: () => ({ accountId: STAFF }), environment, repository, now: () => NOW.getTime(), capabilityReader, rateLimit });
  return { handler, calls };
}

test('route check-capability: DB prep, binding, ONE HeyGen read, server-derived evidence, then the write', async () => {
  const { handler, calls } = capabilityFixture();
  const res = response();
  await handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls.map(([name]) => name), ['rate', 'prepare', 'binding', 'assert', 'read', 'record']);
  assert.deepEqual(calls[0][1], { accountId: STAFF, key: `luxify-capability:hourly:${STAFF}`, limit: 5, windowMs: 60 * 60 * 1000 });
  assert.deepEqual(calls[2][1], { accountId: ACCOUNT });
  assert.equal(calls[4][1], LOOK);
  const record = calls[5][1];
  assert.equal(record.staffAccountId, STAFF);
  assert.equal(record.eligible, true);
  assert.equal(record.evidenceSha256, sha(lookBody()));
  assert.equal(record.providerSpaceFingerprint, FP);
  assert.equal(record.providerAvatarGroupId, GROUP);
  assert.deepEqual(record.supportedApiEngines, ['avatar_v', 'avatar_iv', 'avatar_iii']);
  assert.equal(res.body.eligible, true);
  assert.equal(res.body.ineligibleReason, undefined);
  assert.equal(res.body.evidenceRef, `…${sha(lookBody()).slice(-8)}`);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${LOOK}|${GROUP}|${FP}|${ACCOUNT}|${sha(lookBody())}`), 'no raw ids or full hashes in the response');
});

test('route check-capability: staff-supplied evidence is rejected; failures before the write record nothing', async () => {
  const extra = capabilityFixture();
  const bad = response();
  await extra.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY, eligible: true, evidenceSha256: 'a'.repeat(64) }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(extra.calls.length, 0);

  const noBinding = capabilityFixture({ resolveThrows: true });
  const r1 = response();
  await noBinding.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r1);
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.body.code, 'LUXIFY_PROVIDER_SPACE_UNAVAILABLE');
  assert.deepEqual(noBinding.calls.map(([name]) => name), ['rate', 'prepare', 'binding']);

  const mismatch = capabilityFixture({ binding: { providerSpaceFingerprint: 'd'.repeat(64) } });
  const r2 = response();
  await mismatch.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r2);
  assert.equal(r2.body.code, 'LUXIFY_PROVIDER_SPACE_MISMATCH');
  assert.ok(!mismatch.calls.some(([name]) => name === 'read' || name === 'record'));

  const readFails = capabilityFixture({ read: () => { throw new Error('HTTP 500'); } });
  const r3 = response();
  await readFails.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r3);
  assert.equal(r3.statusCode, 503);
  assert.equal(r3.body.code, 'LUXIFY_CAPABILITY_READ_FAILED');
  assert.ok(!readFails.calls.some(([name]) => name === 'record'));

  const readOf = overrides => () => { const text = lookBody(overrides); return { text, payload: JSON.parse(text) }; };
  for (const [overrides, reason] of [[{ group_id: undefined }, 'OWNERSHIP_FIELD_MISSING'], [{ id: 'look_other' }, 'LOOK_MISMATCH']]) {
    const f = capabilityFixture({ read: readOf(overrides) });
    const r = response();
    await f.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r);
    assert.equal(r.statusCode, 409, reason);
    assert.equal(r.body.code, 'LUXIFY_CAPABILITY_UNPROVEN');
    assert.ok(!f.calls.some(([name]) => name === 'record'), reason);
  }

  const noGroup = capabilityFixture({ prepare: () => { throw Object.assign(new Error('no group'), { code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', statusCode: 409 }); } });
  const r6 = response();
  await noGroup.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r6);
  assert.equal(r6.statusCode, 409);
  assert.equal(r6.body.code, 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN');
  assert.deepEqual(noGroup.calls.map(([name]) => name), ['rate', 'prepare']);
});

test('route check-capability: not completed or wrong owner records eligible=false (superseding); engines never matter', async () => {
  const readOf = overrides => () => { const text = lookBody(overrides); return { text, payload: JSON.parse(text) }; };
  for (const [overrides, reason] of [[{ status: 'processing' }, 'NOT_COMPLETED'], [{ group_id: 'group_someone_else' }, 'OWNER_MISMATCH']]) {
    const f = capabilityFixture({ read: readOf(overrides) });
    const r = response();
    await f.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r);
    assert.equal(r.statusCode, 201, reason);
    assert.equal(r.body.eligible, false);
    assert.equal(r.body.ineligibleReason, reason);
    assert.equal(f.calls.find(([name]) => name === 'record')[1].eligible, false);
    assert.doesNotMatch(JSON.stringify(r.body), /group_someone_else/);
  }
  for (const overrides of [{ supported_api_engines: ['avatar_iv'] }, { supported_api_engines: [] }, { supported_api_engines: undefined }]) {
    const f = capabilityFixture({ read: readOf(overrides) });
    const r = response();
    await f.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), r);
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.eligible, true, JSON.stringify(overrides));
  }
});

test('route staff actions keep the strict Origin/JSON rules and require sign-in', async () => {
  const { handler, calls } = capabilityFixture();
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }, { origin: undefined }]) {
    const res = response();
    await handler(request({ action: 'staff-context' }, headers), res);
    assert.ok([400, 403].includes(res.statusCode), JSON.stringify(headers));
  }
  assert.equal(calls.length, 0);
  const anon = createLuxifyConsentHandler({ authenticate: () => null, environment: ENV, repository: {}, capabilityReader: {} });
  const res = response();
  await anon(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), res);
  assert.equal(res.statusCode, 401);
  const ok = response();
  await handler(request({ action: 'staff-context' }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls.at(-1), ['context', { accountId: STAFF }]);
});

// ---- QA follow-ups (LUXIFY-STAFF-1101) ----------------------------------------
test('M1: the legacy record-capability action is gone from the route and the repository', async () => {
  const { handler, calls } = capabilityFixture();
  const res = response();
  await handler(request({ action: 'record-capability', accountId: ACCOUNT, providerLookId: LOOK, eligible: true, avatarType: 'studio', supportedApiEngines: ['cinematic_avatar'], observedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + DAY).toISOString(), evidenceSha256: 'a'.repeat(64) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_request');
  assert.equal(calls.length, 0);
  const { repo } = repoFor([]);
  assert.equal(repo.recordLookCapabilityEvidence, undefined);
  for (const file of ['../routes/video-os-lite/luxify-consent.js', '../db/luxify-consent-repository.js', '../public/luxify-staff.js', '../public/luxify-consent.js']) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /recordLookCapabilityEvidence|'record-capability'/, file);
  }
});

test('M1: checked evidence is written with created_at = observed_at, and eligibility reads only such rows', async () => {
  const r = repoFor([...staffOk(), [identity()], [space], [], [{ id: EVIDENCE }]]);
  await r.repo.recordCheckedLookCapability({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, providerAvatarGroupId: GROUP, eligible: false, avatarType: 'photo_avatar', supportedApiEngines: [], evidenceSha256: 'b'.repeat(64) });
  const insert = r.db.log.find(entry => entry.kind === 'insert');
  const values = arg(insert, 'values');
  assert.equal(values.createdAt.getTime(), values.observedAt.getTime());
  assert.equal(values.observedAt.getTime(), NOW.getTime());
  const source = await readFile(new URL('../db/luxify-consent-repository.js', import.meta.url), 'utf8');
  const eligibility = source.slice(source.indexOf('export async function resolveLuxifyEligibilityTx'));
  assert.match(eligibility, /luxifyLookCapabilityEvidence\.createdAt\} = \$\{luxifyLookCapabilityEvidence\.observedAt\}/);
  // L5: eligibility also requires source = 'heygen_check', which only the check path writes.
  assert.match(eligibility, /eq\(luxifyLookCapabilityEvidence\.source, LUXIFY_EVIDENCE_SOURCE\)/);
  assert.equal(values.source, 'heygen_check');
  const writers = source.match(/source: LUXIFY_EVIDENCE_SOURCE/g) || [];
  assert.equal(writers.length, 1, 'exactly one writer of source=heygen_check (insertCapabilityEvidenceTx)');
});

test('L2: the HeyGen look read refuses redirects (no X-Api-Key forwarding)', async () => {
  const seen = [];
  const text = lookBody();
  const fetchImpl = async (url, init) => { seen.push([url, init]); return { ok: true, status: 200, text: async () => text }; };
  const out = await readHeygenAvatarLookRaw(LOOK, { fetchImpl, env: { HEYGEN_API_KEY: 'test-key-not-real' } });
  assert.equal(out.text, text);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].method, 'GET');
  assert.equal(seen[0][1].redirect, 'error');
  const failing = async () => { throw new TypeError('fetch failed: redirect mode is set to error'); };
  await assert.rejects(readHeygenAvatarLookRaw(LOOK, { fetchImpl: failing, env: { HEYGEN_API_KEY: 'test-key-not-real' } }), error => !String(error.message).includes('test-key-not-real'));
});

test('L3: capability checks are rate limited per staff actor (5/hour); over the limit nothing is read or written', async () => {
  let used = 0;
  const { handler, calls } = capabilityFixture({ allow: () => { used += 1; return used <= 5; } });
  const codes = [];
  for (let i = 0; i < 7; i += 1) {
    const res = response();
    await handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), res);
    codes.push(res.statusCode);
    if (i === 6) assert.equal(res.body.code, 'rate_limited');
  }
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  assert.equal(calls.filter(([name]) => name === 'read').length, 5);
  assert.equal(calls.filter(([name]) => name === 'record').length, 5);
  assert.ok(calls.filter(([name]) => name === 'rate').every(([, input]) => input.accountId === STAFF && input.key === `luxify-capability:hourly:${STAFF}`));
});

test('L4: with LUXIFY off the capability check refuses before any DB, rate-limit or HeyGen call; staff actions stay available', async () => {
  for (const environment of [ENV, { ...ENV, VIDEO_OS_LUXIFY_ENABLED: 'false' }, { ...ENV, VIDEO_OS_LUXIFY_ENABLED: '1' }]) {
    const { handler, calls } = capabilityFixture({ environment });
    const res = response();
    await handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'luxify_unavailable');
    assert.equal(calls.length, 0);
    const ctx = response();
    await handler(request({ action: 'staff-context' }), ctx);
    assert.equal(ctx.statusCode, 200);
  }
  const on = capabilityFixture({ environment: { ...ENV, VIDEO_OS_LUXIFY_ENABLED: ' TRUE ' } });
  const res = response();
  await on.handler(request({ action: 'check-capability', accountId: ACCOUNT, identityId: IDENTITY }), res);
  assert.equal(res.statusCode, 201);
});

// ---- magic-link verified email proof ----------------------------------------
test('magic-link proof row: used auth_challenges row, domain-separated token hash, idempotent', async () => {
  const db = fakeDb([[{ id: 'row' }], []]);
  const tokenHash = sha('magic-token');
  assert.deepEqual(await recordMagicLinkEmailProof({ accountId: STAFF, email: ' Staff@LuxMarketingCompany.com ', magicTokenHash: tokenHash, usedAt: NOW, executor: db.executor }), { recorded: true });
  const values = arg(db.log[0], 'values');
  assert.deepEqual(values, { accountId: STAFF, email: 'staff@luxmarketingcompany.com', tokenHash: magicLinkProofTokenHash(tokenHash), challengeType: 'magic_link', expiresAt: NOW, usedAt: NOW });
  assert.notEqual(values.tokenHash, tokenHash, 'never equal to the Blob magic-token hash');
  assert.ok(db.log[0].calls.some(([name]) => name === 'onConflictDoNothing'));
  assert.deepEqual(await recordMagicLinkEmailProof({ accountId: STAFF, email: 'staff@luxmarketingcompany.com', magicTokenHash: tokenHash, usedAt: NOW, executor: db.executor }), { recorded: false });
  for (const bad of [{ accountId: '' }, { email: 'nope' }, { magicTokenHash: 'abc' }, { usedAt: 'never' }]) {
    const empty = fakeDb([]);
    await assert.rejects(recordMagicLinkEmailProof({ accountId: STAFF, email: 'staff@luxmarketingcompany.com', magicTokenHash: tokenHash, usedAt: NOW, executor: empty.executor, ...bad }), { statusCode: 400 });
    assert.equal(empty.log.length, 0);
  }
});

function authFixture({ consumeThrows = false, proofThrows = false, consumedEmail } = {}) {
  const calls = [];
  const magicLink = {
    validate: async token => { calls.push(['validate', token]); return { accountId: 'user-token-id', email: 'staff@luxmarketingcompany.com' }; },
    authenticatedAccountId: async id => { calls.push(['resolve', id]); return STAFF; },
    updateAuthenticatedAccount: async input => { calls.push(['update', input.accountId]); return {}; },
    consume: async token => { calls.push(['consume', token]); if (consumeThrows) throw Object.assign(new Error('This sign-in link was already used.'), { statusCode: 401 }); return { accountId: 'user-token-id', email: consumedEmail ?? 'staff@luxmarketingcompany.com' }; },
    recordSignIn: async id => { calls.push(['signin', id]); },
    recordEmailProof: async input => { calls.push(['proof', input]); if (proofThrows) throw new Error('db down'); return { recorded: true }; },
  };
  return { calls, deps: { magicLink, env: { ...process.env, ...ENV } } };
}
const verifyRequest = () => ({ method: 'GET', url: '/api/video-os-lite/auth-verify?token=tok-123', headers: { host: 'video.example' }, async *[Symbol.asyncIterator]() {} });

test('auth-verify records the verified-email proof only after the link was consumed', async (t) => {
  const previous = process.env.VIDEO_OS_SESSION_SECRET;
  process.env.VIDEO_OS_SESSION_SECRET = ENV.VIDEO_OS_SESSION_SECRET;
  t.after(() => { if (previous === undefined) delete process.env.VIDEO_OS_SESSION_SECRET; else process.env.VIDEO_OS_SESSION_SECRET = previous; });
  const errors = t.mock.method(console, 'error', () => {});

  const ok = authFixture();
  const res = response();
  await handleAuthRequest(verifyRequest(), res, ok.deps);
  assert.equal(res.statusCode, 302);
  assert.deepEqual(ok.calls.map(([name]) => name), ['validate', 'resolve', 'update', 'consume', 'proof', 'signin']);
  assert.deepEqual(ok.calls[4][1], { accountId: STAFF, email: 'staff@luxmarketingcompany.com', magicTokenHash: sha('tok-123') });

  const replay = authFixture({ consumeThrows: true });
  const replayRes = response();
  await handleAuthRequest(verifyRequest(), replayRes, replay.deps);
  assert.equal(replayRes.statusCode, 401);
  assert.ok(!replay.calls.some(([name]) => name === 'proof'), 'a link that was not consumed proves nothing');

  const mismatch = authFixture({ consumedEmail: 'other@luxmarketingcompany.com' });
  const mismatchRes = response();
  await handleAuthRequest(verifyRequest(), mismatchRes, mismatch.deps);
  assert.equal(mismatchRes.statusCode, 302);
  assert.ok(!mismatch.calls.some(([name]) => name === 'proof'), 'an email that differs from the consumed record is never recorded');

  const down = authFixture({ proofThrows: true });
  const downRes = response();
  await handleAuthRequest(verifyRequest(), downRes, down.deps);
  assert.equal(downRes.statusCode, 302, 'sign-in still succeeds when the proof write fails');
  assert.ok(errors.mock.calls.every(call => !JSON.stringify(call.arguments).includes('staff@')), 'no email in error logs');
});

// ---- LUXIFY stays off -------------------------------------------------------
test('LUXIFY stays off by default: no flag means unavailable before any look or DB check', async () => {
  const touched = [];
  const deps = {
    env: {},
    runtimePreflight: async () => { touched.push('runtime'); return { ready: true, reasons: [] }; },
    authorizePremium: async () => { touched.push('premium'); return true; },
    resolveEligibility: async () => { touched.push('eligibility'); return []; },
  };
  await assert.rejects(requireLuxifyActivation(ACCOUNT, [IDENTITY], deps), { code: 'luxify_unavailable', statusCode: 503 });
  await assert.rejects(requireLuxifyActivation(ACCOUNT, [IDENTITY], { ...deps, env: { VIDEO_OS_LUXIFY_ENABLED: 'false' } }), { code: 'luxify_unavailable' });
  assert.deepEqual(touched, []);
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(vercel), /VIDEO_OS_LUXIFY_/);
  // The consent route reads the flag only to refuse check-capability (QA L4); see the L4 test.
  for (const file of ['../public/luxify-staff.js', '../db/luxify-consent-repository.js', '../lib/luxify-look-capability.js']) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), /(env|environment)\??\.VIDEO_OS_LUXIFY_ENABLED|\[\s*['"]VIDEO_OS_LUXIFY_ENABLED/, `${file} must not touch the LUXIFY flag`);
  }
});

// ---- page, route and Studio link (static) -----------------------------------
test('/luxify-staff is served no-store and no-referrer, and the page shows only masked refs', async () => {
  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const route = vercel.routes.find(entry => entry.src === '/luxify-staff');
  assert.deepEqual(route, { src: '/luxify-staff', dest: '/luxify-staff.html', headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  const html = await readFile(new URL('../public/luxify-staff.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /id="explicit-grant" type="checkbox"/);
  const js = await readFile(new URL('../public/luxify-staff.js', import.meta.url), 'utf8');
  assert.match(js, /const endpoint = '\/api\/video-os-lite\/luxify-consent';/);
  assert.doesNotMatch(js, /innerHTML/);
  assert.doesNotMatch(js, /record-capability|evidenceSha256|supportedApiEngines:/, 'the page never supplies evidence values');
  for (const field of ['grant.staffAccountId', 'subject.accountId', 'look.identityId', 'approval.approvalId']) {
    assert.ok(!js.includes('${' + field + '}'), `${field} must not be displayed`);
  }
});

test('Studio LUXIFY panel links to /luxify-consent, including the no-eligible-looks message', async () => {
  const studio = await readFile(new URL('../public/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /link\.href = '\/luxify-consent';/);
  assert.match(studio, /function luxifyNoEligibleLooks\(\)[\s\S]*No eligible LUXIFY looks are available\. [\s\S]*luxifyConsentLink\(/);
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(index, /<a class="text-link" href="\/luxify-consent">Manage LUXIFY consent for your looks<\/a>/);
});
