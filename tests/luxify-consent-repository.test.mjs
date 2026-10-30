import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLuxifyCreativeAssetsApprovedTx,
  assertLuxifyLookCreativeApprovalTx,
  createLuxifyConsentRepository,
  resolvePersistedLuxifyAuthority,
} from '../db/luxify-consent-repository.js';
import { LUXIFY_CONSENT_NOTICE_SHA256 } from '../lib/luxify-consent-policy.js';

// Scripted fake transaction: every awaited query chain resolves the next
// queued result, so each test states exactly what the DB returns. No DB.
const NOW = new Date('2026-11-02T10:00:00.000Z');
const ACCOUNT = 'subject-account-test';
const STAFF = 'staff-account-test';
const IDENTITY = '0b0b0b0b-0000-4000-8000-000000000001';
const SOURCE = '0b0b0b0b-0000-4000-8000-000000000002';
const CONSENT = '0b0b0b0b-0000-4000-8000-000000000003';
const BINDING = '0b0b0b0b-0000-4000-8000-000000000004';
const SCOPE = '0b0b0b0b-0000-4000-8000-000000000005';
const RESOURCE = '0b0b0b0b-0000-4000-8000-000000000006';
const EVIDENCE = '0b0b0b0b-0000-4000-8000-000000000007';
const KEY = '0b0b0b0b-0000-4000-8000-000000000008';
const FP = 'f'.repeat(64);
const LOOK = 'look_test_1';
const CHALLENGE = 'c'.repeat(64);
const consumed = [{ challengeSha256: CHALLENGE }];

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
  const tx = {
    execute: async () => [{ now }],
    select: () => chain('select'),
    update: () => chain('update'),
    insert: () => chain('insert'),
  };
  return { log, tx, executor: { transaction: async callback => callback(tx) } };
}
const arg = (entry, method) => entry.calls.find(([name]) => name === method)?.[1]?.[0];
const writes = log => log.filter(entry => entry.kind !== 'select');

const identityRow = { id: IDENTITY, accountId: ACCOUNT, archivedAt: null, provider: 'heygen', avatarStatus: 'READY', providerRenderableAvatarId: LOOK, displayName: 'Test look' };
const sourceRow = { id: SOURCE, accountId: ACCOUNT, identityId: IDENTITY, faceAuthorization: true, providerProcessingAuthorization: true, revokedAt: null };
const spaceRow = { bindingId: BINDING, originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: SCOPE, verifiedAt: new Date('2026-10-30T00:00:00.000Z'), providerSpaceFingerprint: FP };
const consentRow = (overrides = {}) => ({
  id: CONSENT, accountId: ACCOUNT, identityId: IDENTITY, sourceIdentityConsentId: SOURCE, providerLookId: LOOK, providerSpaceFingerprint: FP,
  policyVersion: 'luxify-cinematic-consent/v1', purpose: 'luxify-cinematic-generation',
  cinematicGenerationAuthorization: true, providerProcessingAuthorization: true,
  acceptedAt: new Date('2026-10-31T00:00:00.000Z'), expiresAt: new Date('2027-10-31T00:00:00.000Z'), revokedAt: null, terminalReason: null,
  ...overrides,
});
const grantInput = (overrides = {}) => ({
  accountId: ACCOUNT, identityId: IDENTITY, idempotencyKey: KEY, noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, challengeSha256: CHALLENGE,
  cinematicGenerationAuthorization: true, providerProcessingAuthorization: true, ...overrides,
});
const echoInsert = entry => [{ ...arg(entry, 'values') }];

test('grant records a subject consent linked to the active source consent with a 12-month expiry and evidence hash', async () => {
  const { executor, log } = fakeDb([[], [identityRow], [sourceRow], [spaceRow], [], consumed, echoInsert]);
  const result = await createLuxifyConsentRepository({ executor }).grantConsent(grantInput());
  const inserts = writes(log).filter(entry => entry.kind === 'insert');
  assert.equal(inserts.length, 2, 'challenge use + consent');
  assert.deepEqual(arg(inserts[0], 'values'), { challengeSha256: CHALLENGE, accountId: ACCOUNT, identityId: IDENTITY, usedAt: NOW });
  const insert = inserts[1];
  const values = arg(insert, 'values');
  assert.equal(values.accountId, ACCOUNT);
  assert.equal(values.sourceIdentityConsentId, SOURCE);
  assert.equal(values.policyVersion, 'luxify-cinematic-consent/v1');
  assert.equal(values.purpose, 'luxify-cinematic-generation');
  assert.equal(values.cinematicGenerationAuthorization, true);
  assert.equal(values.providerProcessingAuthorization, true);
  assert.match(values.approvalEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(values.expiresAt.toISOString(), '2027-11-02T10:00:00.000Z');
  assert.equal(result.replayed, false);
  assert.equal(result.consent.status, 'active');
});

test('grant refuses a non-subject account (identity not owned) and writes nothing', async () => {
  const { executor, log } = fakeDb([[], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsent(grantInput({ accountId: 'other-account-test' })), { code: 'LUXIFY_CONSENT_SUBJECT_REQUIRED', statusCode: 403 });
  assert.equal(writes(log).length, 0);
});

test('grant fails closed without an active source identity consent or without both authorizations', async () => {
  const missing = fakeDb([[], [identityRow], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor: missing.executor }).grantConsent(grantInput()), { code: 'LUXIFY_SOURCE_CONSENT_REQUIRED' });
  assert.equal(writes(missing.log).length, 0);
  const none = fakeDb([]);
  await assert.rejects(createLuxifyConsentRepository({ executor: none.executor }).grantConsent(grantInput({ providerProcessingAuthorization: false })), { code: 'LUXIFY_CONSENT_AUTHORIZATION_REQUIRED', statusCode: 400 });
  await assert.rejects(createLuxifyConsentRepository({ executor: none.executor }).grantConsent(grantInput({ noticeSha256: '0'.repeat(64) })), { code: 'LUXIFY_CONSENT_CHALLENGE_INVALID' });
  assert.equal(none.log.length, 0);
});

test('grant refuses an expiry above the 365-day cap before writing', async () => {
  const { executor, log } = fakeDb([[], [identityRow], [sourceRow], [spaceRow], [], echoInsert]);
  await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsent(grantInput({ expiryDays: 366 })), { code: 'LUXIFY_CONSENT_EXPIRY_INVALID' });
  assert.equal(writes(log).length, 0);
});

test('grant refuses a duplicate while active, and closes (never deletes) an expired row on renewal', async () => {
  const active = fakeDb([[], [identityRow], [sourceRow], [spaceRow], [{ id: CONSENT, expiresAt: new Date('2027-01-01T00:00:00.000Z') }]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: active.executor }).grantConsent(grantInput()), { code: 'LUXIFY_CONSENT_ALREADY_ACTIVE' });
  assert.equal(writes(active.log).length, 0);

  const expired = fakeDb([[], [identityRow], [sourceRow], [spaceRow], [{ id: CONSENT, expiresAt: new Date('2026-11-01T00:00:00.000Z') }], [], consumed, echoInsert]);
  await createLuxifyConsentRepository({ executor: expired.executor }).grantConsent(grantInput());
  const [close, , insert] = writes(expired.log);
  assert.equal(close.kind, 'update');
  assert.deepEqual(arg(close, 'set'), { revokedAt: NOW, terminalReason: 'revoked' });
  assert.equal(insert.kind, 'insert');
});

test('subject withdraw closes the row as withdrawn and is idempotent', async () => {
  const open = fakeDb([[consentRow()], entry => [consentRow({ ...arg(entry, 'set') })]]);
  const result = await createLuxifyConsentRepository({ executor: open.executor }).withdrawConsent({ accountId: ACCOUNT, consentId: CONSENT });
  assert.deepEqual(arg(writes(open.log)[0], 'set'), { revokedAt: NOW, terminalReason: 'withdrawn' });
  assert.equal(result.consent.status, 'withdrawn');
  assert.equal(result.changed, true);

  const closed = fakeDb([[consentRow({ revokedAt: NOW, terminalReason: 'withdrawn' })]]);
  const again = await createLuxifyConsentRepository({ executor: closed.executor }).withdrawConsent({ accountId: ACCOUNT, consentId: CONSENT });
  assert.equal(again.changed, false);
  assert.equal(writes(closed.log).length, 0);

  const other = fakeDb([[]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: other.executor }).withdrawConsent({ accountId: 'other-account-test', consentId: CONSENT }), { code: 'LUXIFY_CONSENT_NOT_FOUND', statusCode: 404 });
});

test('staff revoke requires an active explicit staff grant and closes the row as revoked', async () => {
  const noGrant = fakeDb([[{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor: noGrant.executor }).revokeConsent({ staffAccountId: STAFF, consentId: CONSENT }), { code: 'LUX_STAFF_GRANT_REQUIRED', statusCode: 403 });
  assert.equal(writes(noGrant.log).length, 0);

  const grant = { id: 'grant-test', staffEmail: 'staff@luxmarketingcompany.com', explicitGrant: true };
  const unverified = fakeDb([[{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], [grant], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor: unverified.executor }).revokeConsent({ staffAccountId: STAFF, consentId: CONSENT }), { code: 'LUX_STAFF_EMAIL_UNVERIFIED' });

  const ok = fakeDb([
    [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], [grant], [{ usedAt: NOW }],
    [{ accountId: ACCOUNT }], [consentRow()], entry => [consentRow({ ...arg(entry, 'set') })],
  ]);
  const result = await createLuxifyConsentRepository({ executor: ok.executor }).revokeConsent({ staffAccountId: STAFF, consentId: CONSENT });
  assert.equal(result.consent.status, 'revoked');
});

test('revoking the source identity consent closes linked cinematic consents as source_revoked', async () => {
  const { executor, log } = fakeDb([[sourceRow], [{ id: CONSENT }, { id: 'another-consent' }], [], []]);
  const result = await createLuxifyConsentRepository({ executor }).revokeSourceIdentityConsent({ accountId: ACCOUNT, identityConsentId: SOURCE });
  assert.equal(result.closedCinematicConsents, 2);
  const [sourceUpdate, cascade] = writes(log);
  assert.deepEqual(arg(sourceUpdate, 'set'), { revokedAt: NOW });
  assert.deepEqual(arg(cascade, 'set'), { revokedAt: NOW, terminalReason: 'source_revoked' });

  const other = fakeDb([[]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: other.executor }).revokeSourceIdentityConsent({ accountId: 'other-account-test', identityConsentId: SOURCE }), { code: 'LUXIFY_CONSENT_SUBJECT_REQUIRED' });
  assert.equal(writes(other.log).length, 0);
});

test('staff grant needs the owner grantor, a verified Lux-domain staff email, and an explicit grant', async () => {
  const ceo = { id: 'owner-account-test', email: 'owner@luxmarketingcompany.com', role: 'ceo' };
  const repo = queue => createLuxifyConsentRepository({ executor: fakeDb(queue).executor });
  const call = (queue, explicitGrant = true) => repo(queue).grantStaff({ grantorAccountId: ceo.id, staffAccountId: STAFF, explicitGrant });
  await assert.rejects(call([[{ ...ceo, role: 'customer' }], [{ usedAt: NOW }]]), { code: 'LUX_STAFF_GRANTOR_REQUIRED' });
  await assert.rejects(call([[ceo], [{ usedAt: NOW }], [{ id: STAFF, email: 'staff@example.test' }], [{ usedAt: NOW }]]), { code: 'LUX_STAFF_DOMAIN_REQUIRED' });
  await assert.rejects(call([[ceo], [{ usedAt: NOW }], [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], []]), { code: 'LUX_STAFF_EMAIL_UNVERIFIED' });
  await assert.rejects(call([[ceo], [{ usedAt: NOW }], [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], [{ usedAt: NOW }]], false), { code: 'LUX_STAFF_EXPLICIT_GRANT_REQUIRED' });
  const ok = fakeDb([[ceo], [{ usedAt: NOW }], [{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], [{ usedAt: NOW }], [], [{ id: 'grant-test' }]]);
  const result = await createLuxifyConsentRepository({ executor: ok.executor }).grantStaff({ grantorAccountId: ceo.id, staffAccountId: STAFF, explicitGrant: true });
  assert.deepEqual(result, { grantId: 'grant-test', replayed: false });
  const values = arg(writes(ok.log)[0], 'values');
  assert.equal(values.staffEmail, 'staff@luxmarketingcompany.com');
  assert.equal(values.explicitGrant, true);
});

// ---- reserve/claim authority -----------------------------------------
const resourceRow = { id: RESOURCE, applicationAccountId: ACCOUNT, bindingId: BINDING, originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: SCOPE, kind: 'avatar_look', providerResourceId: LOOK, state: 'ready', tombstonedAt: null };
const evidenceRow = (overrides = {}) => ({
  id: EVIDENCE, accountId: ACCOUNT, providerLookId: LOOK, providerSpaceFingerprint: FP, capability: 'cinematic_avatar', eligible: true,
  avatarType: 'photo_avatar', supportedApiEngines: ['avatar_iv'], evidenceSha256: 'd'.repeat(64),
  observedAt: new Date('2026-11-01T00:00:00.000Z'), expiresAt: new Date('2026-11-20T00:00:00.000Z'), ...overrides,
});
const approvalRow = (overrides = {}) => ({ approvedAt: new Date('2026-11-01T00:00:00.000Z'), expiresAt: new Date('2026-11-15T00:00:00.000Z'), revokedAt: null, grantRevokedAt: null, ...overrides });
const authority = (queue, now = NOW) => resolvePersistedLuxifyAuthority({ tx: fakeDb(queue, now).tx, accountId: ACCOUNT, lookIdentityIds: [IDENTITY], intent: {} });

test('reserve/claim authority resolves from persisted consent, source consent, resource and capability evidence', async () => {
  const result = await authority([[spaceRow], [identityRow], [consentRow()], [{ revokedAt: null }], [resourceRow], [evidenceRow()], [approvalRow()]]);
  assert.deepEqual(Object.keys(result).sort(), ['eligibilityRevision', 'lookBindings']);
  assert.deepEqual(result.lookBindings, [{ identityId: IDENTITY, providerLookId: LOOK }]);
  assert.match(result.eligibilityRevision, /:db-[a-f0-9]{32}$/);
});

test('reserve/claim authority fails closed on missing, expired or source-revoked consent and missing evidence', async () => {
  await assert.rejects(authority([[]]), { code: 'LUXIFY_PROVIDER_SPACE_UNAVAILABLE' });
  await assert.rejects(authority([[spaceRow], [identityRow], []]), { code: 'LUXIFY_CONSENT_MISSING' });
  await assert.rejects(authority([[spaceRow], [identityRow], [consentRow()], [{ revokedAt: NOW }]]), { code: 'LUXIFY_SOURCE_CONSENT_REQUIRED' });
  await assert.rejects(authority([[spaceRow], [identityRow], [consentRow()], [{ revokedAt: null }], [resourceRow], []]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE' });
  await assert.rejects(authority([[spaceRow], [identityRow], [consentRow({ expiresAt: new Date('2026-11-01T00:00:00.000Z') })], [{ revokedAt: null }], [resourceRow], [evidenceRow()], [approvalRow()]]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE', reason: 'CONSENT_INVALID' });
  await assert.rejects(authority([[spaceRow], [identityRow], [consentRow()], [{ revokedAt: null }], [resourceRow], [evidenceRow({ expiresAt: new Date('2026-11-02T09:00:00.000Z') })], [approvalRow()]]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE' });
  await assert.rejects(authority([[spaceRow], [identityRow], [consentRow()], [{ revokedAt: null }], [resourceRow], [evidenceRow({ eligible: false })], [approvalRow()]]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE' });
});

test('reserve/claim authority turns unexpected storage failures into a closed 503', async () => {
  await assert.rejects(authority([new Error('connection reset')]), { code: 'LUXIFY_CINEMATIC_AUTHORITY_UNAVAILABLE', statusCode: 503, failureCategory: 'CONSENT' });
});

test('creative assets are blocked from LUXIFY until a Lux staff approval matches the current asset hash', async () => {
  const ASSET = '0b0b0b0b-0000-4000-8000-0000000000aa';
  const APPROVED_AT = new Date('2026-11-01T00:00:00.000Z');
  const check = rows => assertLuxifyCreativeAssetsApprovedTx(fakeDb([rows.map(row => ({ approvedAt: APPROVED_AT, ...row }))]).tx, { accountId: ACCOUNT, mediaAssetIds: [ASSET] });
  const blocked = { code: 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', statusCode: 409 };
  await assert.rejects(check([]), blocked);
  await assert.rejects(check([{ mediaAssetId: ASSET, assetSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64), quarantinedAt: null, grantRevokedAt: null }]), blocked);
  await assert.rejects(check([{ mediaAssetId: ASSET, assetSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), quarantinedAt: null, grantRevokedAt: NOW }]), blocked);
  assert.equal(await check([{ mediaAssetId: ASSET, assetSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), quarantinedAt: null, grantRevokedAt: null }]), true);
  // R2-L1: an approval dated after DB now() (or with no date) confers nothing.
  for (const approvedAt of [new Date(NOW.getTime() + 1), new Date('2027-01-01T00:00:00.000Z'), null]) {
    await assert.rejects(check([{ mediaAssetId: ASSET, assetSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), quarantinedAt: null, grantRevokedAt: null, approvedAt }]), blocked);
  }
  assert.equal(await check([{ mediaAssetId: ASSET, assetSha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64), quarantinedAt: null, grantRevokedAt: null, approvedAt: NOW }]), true, 'approved_at == now is in effect');
  await assert.rejects(resolvePersistedLuxifyAuthority({ tx: fakeDb([[]]).tx, accountId: ACCOUNT, lookIdentityIds: [IDENTITY], intent: { creativeAssetIds: [ASSET] } }), blocked);
});

test('every LUXIFY render needs an active, unexpired staff creative approval for each look (owner decision Oct 30)', async () => {
  const base = () => [[spaceRow], [identityRow], [consentRow()], [{ revokedAt: null }], [resourceRow], [evidenceRow()]];
  const blocked = { code: 'LUXIFY_CREATIVE_APPROVAL_REQUIRED', statusCode: 409 };
  // No approval: refused, even for a prompt-only intent with no creative assets.
  await assert.rejects(authority([...base(), []]), blocked);
  // Approval issued under a revoked staff grant, a revoked approval, or an expired approval: refused.
  await assert.rejects(authority([...base(), [approvalRow({ grantRevokedAt: new Date('2026-11-01T00:00:00.000Z') })]]), blocked);
  await assert.rejects(authority([...base(), [approvalRow({ revokedAt: new Date('2026-11-01T00:00:00.000Z') })]]), blocked);
  await assert.rejects(authority([...base(), [approvalRow({ expiresAt: NOW })]]), blocked);
  await assert.rejects(authority([...base(), [approvalRow({ expiresAt: new Date('2026-11-01T00:00:00.000Z') })]]), blocked);
  // R2-L1: route, reservation and claim all need approved_at <= now (DB time).
  await assert.rejects(authority([...base(), [approvalRow({ approvedAt: new Date(NOW.getTime() + 1) })]]), blocked);
  await assert.rejects(authority([...base(), [approvalRow({ approvedAt: new Date('2026-11-10T00:00:00.000Z') })]]), blocked);
  await assert.rejects(authority([...base(), [approvalRow({ approvedAt: null })]]), blocked);
  assert.deepEqual((await authority([...base(), [approvalRow({ approvedAt: NOW })]])).lookBindings, [{ identityId: IDENTITY, providerLookId: LOOK }]);
  // Valid approval passes the gate.
  const result = await authority([...base(), [approvalRow()]]);
  assert.deepEqual(result.lookBindings, [{ identityId: IDENTITY, providerLookId: LOOK }]);
  // The gate itself queries by account, identity, look and space, and returns the approval expiry.
  const db = fakeDb([[approvalRow()]]);
  const expiry = await assertLuxifyLookCreativeApprovalTx(db.tx, { accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, now: NOW });
  assert.equal(expiry, new Date('2026-11-15T00:00:00.000Z').getTime());
  assert.ok(db.log[0].calls.some(([name]) => name === 'for'), 'approval row is locked FOR SHARE');
  await assert.rejects(assertLuxifyLookCreativeApprovalTx(fakeDb([[approvalRow()]]).tx, { accountId: ACCOUNT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, now: Number.NaN }), blocked);
});

test('staff look approval needs an active staff grant and binds the current look and space with a 30-day cap', async () => {
  const repo = createLuxifyConsentRepository({ executor: fakeDb([]).executor });
  await assert.rejects(repo.approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY, expiresInDays: 31 }), { code: 'LUXIFY_LOOK_APPROVAL_INVALID' });
  await assert.rejects(repo.approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: 'nope' }), { code: 'LUXIFY_CONSENT_INVALID_REQUEST' });
  const denied = fakeDb([[{ id: STAFF, email: 'staff@luxmarketingcompany.com' }], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor: denied.executor }).approveLookCreative({ staffAccountId: STAFF, accountId: ACCOUNT, identityId: IDENTITY }), { code: 'LUX_STAFF_GRANT_REQUIRED' });
  assert.equal(writes(denied.log).length, 0);
});
