import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLuxifyJobConsentTx,
  createLuxifyConsentRepository,
  resolveLuxifyJobConsentIdTx,
  resolvePersistedLuxifyAuthority,
} from '../db/luxify-consent-repository.js';
import { createLuxifyConsentHandler } from '../routes/video-os-lite/luxify-consent.js';
import {
  LUXIFY_CONSENT_NOTICE_SHA256,
  issueLuxifyConsentChallenge,
  luxifyOperatorAttestationSha256,
  luxifyOperatorChallengeSubject,
  renderLuxifyOperatorAttestation,
  sha256Hex,
} from '../lib/luxify-consent-policy.js';

// CORE-CONSENT-OBO unit + route tests. Scripted fake transactions (same
// pattern as luxify-consent-repository.test.mjs); no DB, no provider calls.
const NOW = new Date('2026-11-09T15:00:00.000Z');
const ATTESTED = '2026-11-09T14:30:00.000Z';
const SUBJECT = 'subject-account-test';
const OTHER = 'other-account-test';
const OPERATOR = 'operator-account-test';
const CEO = 'ceo-account-test';
const IDENTITY = '0e0e0e0e-0000-4000-8000-000000000001';
const SOURCE = '0e0e0e0e-0000-4000-8000-000000000002';
const CONSENT = '0e0e0e0e-0000-4000-8000-000000000003';
const BINDING = '0e0e0e0e-0000-4000-8000-000000000004';
const SCOPE = '0e0e0e0e-0000-4000-8000-000000000005';
const RESOURCE = '0e0e0e0e-0000-4000-8000-000000000006';
const EVIDENCE_ID = '0e0e0e0e-0000-4000-8000-000000000007';
const KEY = '0e0e0e0e-0000-4000-8000-000000000008';
const GRANT_ID = '0e0e0e0e-0000-4000-8000-000000000009';
const FP = 'f'.repeat(64);
const LOOK = 'look_test_obo';
const CHALLENGE = 'c'.repeat(64);
const SUBJECT_NAME = 'Test Subject Person';
const EVIDENCE_REF = `video-os/consent-evidence/${sha256Hex(SUBJECT)}/0e0e0e0e-0000-4000-8000-0000000000ee.pdf`;

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
const echoInsert = entry => [{ ...arg(entry, 'values') }];

const operatorAccount = { id: OPERATOR, email: 'operator@luxmarketingcompany.com' };
const operatorGrant = (overrides = {}) => ({ id: GRANT_ID, staffAccountId: OPERATOR, staffEmail: 'operator@luxmarketingcompany.com', scope: 'consent_operator', explicitGrant: true, grantedByAccountId: CEO, revokedAt: null, ...overrides });
const verified = [{ usedAt: NOW }];
const operatorQueue = (grant = operatorGrant()) => [[operatorAccount], [grant], verified];
const identityRow = { id: IDENTITY, accountId: SUBJECT, archivedAt: null, provider: 'heygen', avatarStatus: 'READY', providerRenderableAvatarId: LOOK, displayName: 'Look' };
const sourceRow = { id: SOURCE, accountId: SUBJECT, identityId: IDENTITY, faceAuthorization: true, providerProcessingAuthorization: true, revokedAt: null };
const spaceRow = { bindingId: BINDING, originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: SCOPE, verifiedAt: new Date('2026-11-01T00:00:00.000Z'), providerSpaceFingerprint: FP };
const oboInput = (overrides = {}) => ({
  operatorAccountId: OPERATOR, onBehalfOfAccountId: SUBJECT, identityId: IDENTITY, idempotencyKey: KEY,
  noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, challengeSha256: CHALLENGE,
  cinematicGenerationAuthorization: true, providerProcessingAuthorization: true,
  subjectName: SUBJECT_NAME, attestationMethod: 'recorded_verbal', attestedAt: ATTESTED,
  attestationEvidenceRef: EVIDENCE_REF, attestationConfirmed: true, requestId: 'req_obo-1', ...overrides,
});
const happyQueue = () => [...operatorQueue(), [], [identityRow], [sourceRow], [spaceRow], [{ id: RESOURCE }], [], [{ challengeSha256: CHALLENGE }], echoInsert, [{ id: 'audit-1' }]];
const expectedAttestationSha = luxifyOperatorAttestationSha256(renderLuxifyOperatorAttestation({ subjectName: SUBJECT_NAME, method: 'recorded_verbal', attestedAt: new Date(ATTESTED), identityId: IDENTITY }));
const oboRow = (overrides = {}) => ({
  id: CONSENT, accountId: SUBJECT, identityId: IDENTITY, sourceIdentityConsentId: SOURCE, providerLookId: LOOK, providerSpaceFingerprint: FP,
  policyVersion: 'luxify-cinematic-consent/v1', purpose: 'luxify-cinematic-generation', cinematicGenerationAuthorization: true, providerProcessingAuthorization: true,
  acceptedAt: NOW, expiresAt: new Date('2027-11-09T14:30:00.000Z'), revokedAt: null, terminalReason: null,
  consentMode: 'operator_on_behalf', operatorUserId: OPERATOR, operatorStaffGrantId: GRANT_ID, attestationTextSha256: expectedAttestationSha, attestedAt: new Date(ATTESTED),
  idempotencyKey: KEY, ...overrides,
});

test('consent operator records an on-behalf grant owned by the subject account, bound to its identity/space, 12 months from attestation, with an audit row', async () => {
  const { executor, log } = fakeDb(happyQueue());
  const result = await createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput());
  const inserts = writes(log).filter(entry => entry.kind === 'insert');
  assert.equal(inserts.length, 3, 'challenge use + consent + audit');
  assert.equal(arg(inserts[0], 'values').accountId, SUBJECT, 'challenge consumed against the subject account');
  const values = arg(inserts[1], 'values');
  assert.equal(values.accountId, SUBJECT);
  assert.equal(values.consentMode, 'operator_on_behalf');
  assert.equal(values.operatorUserId, OPERATOR);
  assert.equal(values.operatorStaffGrantId, GRANT_ID);
  assert.equal(values.sourceIdentityConsentId, SOURCE, 'subject\'s own source identity consent');
  assert.equal(values.providerSpaceFingerprint, FP, 'subject account\'s own HeyGen space');
  assert.equal(values.providerLookId, LOOK);
  assert.equal(values.attestationTextVersion, 'luxify-operator-attestation/v1');
  assert.equal(values.attestationTextSha256, expectedAttestationSha);
  assert.equal(values.attestationMethod, 'recorded_verbal');
  assert.equal(values.attestationEvidenceRef, EVIDENCE_REF);
  assert.equal(values.attestedAt.toISOString(), ATTESTED);
  assert.equal(values.acceptedAt, NOW);
  assert.equal(values.expiresAt.toISOString(), '2027-11-09T14:30:00.000Z', 'same 12-month expiry, from the subject\'s attested consent');
  assert.equal(Object.hasOwn(values, 'subjectName'), false, 'no subject name column');
  const audit = arg(inserts[2], 'values');
  assert.equal(audit.event, 'consent.granted_on_behalf');
  assert.equal(audit.actorType, 'operator');
  assert.equal(audit.actorAccountId, OPERATOR);
  assert.equal(audit.onBehalfOfAccountId, SUBJECT);
  assert.equal(audit.accountId, SUBJECT);
  assert.equal(audit.staffGrantId, GRANT_ID);
  assert.equal(audit.attestationTextSha256, expectedAttestationSha);
  assert.equal(audit.requestId, 'req_obo-1');
  assert.equal(audit.occurredAt, NOW);
  assert.doesNotMatch(JSON.stringify(audit), /Test Subject Person|consent-evidence/, 'audit carries hashes and ids only');
  assert.equal(result.replayed, false);
  assert.equal(result.consent.status, 'active');
  assert.equal(result.consent.consentMode, 'operator_on_behalf');
  // Identity binding queries are scoped to the subject account, never the operator.
  const resourceQuery = log.filter(entry => entry.kind === 'select')[7];
  assert.ok(resourceQuery.calls.some(([name]) => name === 'where'));
});

test('non-operators are refused with nothing written: no grant (customer/CEO/creative-only), self-granted, unverified or mismatched email', async () => {
  for (const queue of [
    [[operatorAccount], []],
    [[operatorAccount], [operatorGrant({ grantedByAccountId: OPERATOR })]],
    [[operatorAccount], [operatorGrant()], []],
    [[{ ...operatorAccount, email: 'operator2@luxmarketingcompany.com' }], [operatorGrant()], verified],
    [[{ id: OPERATOR, email: 'operator@example.test' }], [operatorGrant()], verified],
    [[], [operatorGrant()]],
  ]) {
    const { executor, log } = fakeDb(queue);
    await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput()), error => error.statusCode === 403);
    assert.equal(writes(log).length, 0);
  }
  const self = fakeDb([]);
  await assert.rejects(createLuxifyConsentRepository({ executor: self.executor }).grantConsentOnBehalf(oboInput({ operatorAccountId: SUBJECT })), { code: 'LUXIFY_OPERATOR_SELF_SUBJECT', statusCode: 403 });
  assert.equal(self.log.length, 0);
});

test('attestation is required and validated before anything is written', async () => {
  const repo = () => createLuxifyConsentRepository({ executor: fakeDb([]).executor });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ attestationConfirmed: false })), { code: 'LUXIFY_ATTESTATION_REQUIRED', statusCode: 400 });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ subjectName: '' })), { code: 'LUXIFY_ATTESTATION_INVALID' });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ attestationMethod: 'telepathy' })), { code: 'LUXIFY_ATTESTATION_INVALID' });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ attestedAt: 'not a date' })), { code: 'LUXIFY_ATTESTATION_INVALID' });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ attestationEvidenceRef: 'https://example.test/e.pdf' })), { code: 'LUXIFY_ATTESTATION_EVIDENCE_INVALID' });
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ attestationEvidenceRef: EVIDENCE_REF.replace(sha256Hex(SUBJECT), sha256Hex(OTHER)) })), { code: 'LUXIFY_ATTESTATION_EVIDENCE_INVALID' }, 'evidence path belongs to another account');
  await assert.rejects(repo().grantConsentOnBehalf(oboInput({ providerProcessingAuthorization: false })), { code: 'LUXIFY_CONSENT_AUTHORIZATION_REQUIRED' });
  // Attested time window (DB time): older than 7 days or in the future -> refused, nothing written.
  for (const attestedAt of ['2026-11-01T00:00:00.000Z', '2026-11-09T16:00:00.000Z']) {
    const { executor, log } = fakeDb([...operatorQueue(), []]);
    await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput({ attestedAt })), { code: 'LUXIFY_ATTESTATION_TIME_INVALID' });
    assert.equal(writes(log).length, 0);
  }
});

test('identity binding: identity, source consent, HeyGen space and look resource must all belong to the on-behalf-of account', async () => {
  const cases = [
    [[...operatorQueue(), [], []], { code: 'LUXIFY_CONSENT_SUBJECT_REQUIRED', statusCode: 403 }],
    [[...operatorQueue(), [], [{ ...identityRow, avatarStatus: 'PROCESSING' }]], { code: 'LUXIFY_IDENTITY_NOT_ELIGIBLE' }],
    [[...operatorQueue(), [], [identityRow], []], { code: 'LUXIFY_SOURCE_CONSENT_REQUIRED' }],
    [[...operatorQueue(), [], [identityRow], [sourceRow], []], { code: 'LUXIFY_PROVIDER_SPACE_UNAVAILABLE' }],
    [[...operatorQueue(), [], [identityRow], [sourceRow], [spaceRow], []], { code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', statusCode: 409 }],
    [[...operatorQueue(), [], [identityRow], [sourceRow], [spaceRow], [{ id: RESOURCE }], [{ id: CONSENT, expiresAt: new Date('2027-01-01T00:00:00.000Z') }]], { code: 'LUXIFY_CONSENT_ALREADY_ACTIVE' }],
  ];
  for (const [queue, expected] of cases) {
    const { executor, log } = fakeDb(queue);
    await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput()), expected);
    assert.equal(writes(log).length, 0, expected.code);
  }
});

test('idempotent submission: same operator + same attestation replays; any difference is a conflict', async () => {
  const replay = fakeDb([...operatorQueue(), [oboRow()]]);
  const result = await createLuxifyConsentRepository({ executor: replay.executor }).grantConsentOnBehalf(oboInput());
  assert.equal(result.replayed, true);
  assert.equal(writes(replay.log).length, 0);
  for (const row of [oboRow({ operatorUserId: 'someone-else' }), oboRow({ consentMode: 'self' }), oboRow({ attestationTextSha256: '0'.repeat(64) }), oboRow({ identityId: SOURCE })]) {
    const conflict = fakeDb([...operatorQueue(), [row]]);
    await assert.rejects(createLuxifyConsentRepository({ executor: conflict.executor }).grantConsentOnBehalf(oboInput()), { code: 'LUXIFY_CONSENT_IDEMPOTENCY_CONFLICT' });
  }
});

test('withdraw works for on-behalf grants by the subject and by an operator, each audited; self rows are not audited and not operator-withdrawable', async () => {
  const subject = fakeDb([[oboRow()], entry => [oboRow({ ...arg(entry, 'set') })], [{ id: 'audit-2' }]]);
  const withdrawn = await createLuxifyConsentRepository({ executor: subject.executor }).withdrawConsent({ accountId: SUBJECT, consentId: CONSENT, requestId: 'req-w' });
  assert.equal(withdrawn.consent.status, 'withdrawn');
  const [close, audit] = writes(subject.log);
  assert.deepEqual(arg(close, 'set'), { revokedAt: NOW, terminalReason: 'withdrawn' });
  assert.equal(arg(audit, 'values').event, 'consent.withdrawn');
  assert.equal(arg(audit, 'values').actorType, 'subject');
  assert.equal(arg(audit, 'values').actorAccountId, SUBJECT);

  const operator = fakeDb([...operatorQueue(), [{ accountId: SUBJECT }], [oboRow()], entry => [oboRow({ ...arg(entry, 'set') })], [{ id: 'audit-3' }]]);
  const byOperator = await createLuxifyConsentRepository({ executor: operator.executor }).operatorWithdrawConsent({ operatorAccountId: OPERATOR, consentId: CONSENT });
  assert.equal(byOperator.consent.status, 'withdrawn');
  const operatorAudit = arg(writes(operator.log)[1], 'values');
  assert.deepEqual([operatorAudit.event, operatorAudit.actorType, operatorAudit.actorAccountId, operatorAudit.onBehalfOfAccountId, operatorAudit.staffGrantId], ['consent.withdrawn', 'operator', OPERATOR, SUBJECT, GRANT_ID]);

  const selfRow = { ...oboRow(), consentMode: 'self', operatorUserId: null };
  const selfByOperator = fakeDb([...operatorQueue(), [{ accountId: SUBJECT }], [selfRow]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: selfByOperator.executor }).operatorWithdrawConsent({ operatorAccountId: OPERATOR, consentId: CONSENT }), { code: 'LUXIFY_CONSENT_NOT_FOUND', statusCode: 404 });
  assert.equal(writes(selfByOperator.log).length, 0);

  const selfWithdraw = fakeDb([[selfRow], entry => [{ ...selfRow, ...arg(entry, 'set') }]]);
  await createLuxifyConsentRepository({ executor: selfWithdraw.executor }).withdrawConsent({ accountId: SUBJECT, consentId: CONSENT });
  assert.equal(writes(selfWithdraw.log).length, 1, 'self-consent withdraw path unchanged: close only, no audit');

  const nonOperator = fakeDb([[operatorAccount], []]);
  await assert.rejects(createLuxifyConsentRepository({ executor: nonOperator.executor }).operatorWithdrawConsent({ operatorAccountId: OPERATOR, consentId: CONSENT }), { code: 'LUX_CONSENT_OPERATOR_REQUIRED' });
  // Cross-account: another account cannot withdraw the subject's grant.
  const other = fakeDb([[]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: other.executor }).withdrawConsent({ accountId: OTHER, consentId: CONSENT }), { code: 'LUXIFY_CONSENT_NOT_FOUND' });
  assert.equal(writes(other.log).length, 0);
});

test('staff revoke of an on-behalf grant is audited as consent.revoked by staff', async () => {
  const staffGrant = { id: 'staff-grant', staffAccountId: 'staff-account', staffEmail: 'staff@luxmarketingcompany.com', explicitGrant: true };
  const { executor, log } = fakeDb([[{ id: 'staff-account', email: 'staff@luxmarketingcompany.com' }], [staffGrant], verified, [{ accountId: SUBJECT }], [oboRow()], entry => [oboRow({ ...arg(entry, 'set') })], [{ id: 'audit-4' }]]);
  const result = await createLuxifyConsentRepository({ executor }).revokeConsent({ staffAccountId: 'staff-account', consentId: CONSENT });
  assert.equal(result.consent.status, 'revoked');
  const audit = arg(writes(log)[1], 'values');
  assert.deepEqual([audit.event, audit.actorType, audit.actorAccountId, audit.staffGrantId], ['consent.revoked', 'staff', 'staff-account', 'staff-grant']);
});

// ---- downstream checks treat on-behalf grants identically --------------
const resourceRow = { id: RESOURCE, applicationAccountId: SUBJECT, bindingId: BINDING, originScopeKey: 'e'.repeat(64), verifiedAccountScopeId: SCOPE, kind: 'avatar_look', providerResourceId: LOOK, state: 'ready', tombstonedAt: null };
const evidenceRow = { id: EVIDENCE_ID, accountId: SUBJECT, providerLookId: LOOK, providerSpaceFingerprint: FP, capability: 'cinematic_avatar', eligible: true, avatarType: 'photo_avatar', supportedApiEngines: ['avatar_iv'], evidenceSha256: 'd'.repeat(64), observedAt: new Date('2026-11-08T00:00:00.000Z'), expiresAt: new Date('2026-11-30T00:00:00.000Z') };
const approvalRow = { approvedAt: new Date('2026-11-08T00:00:00.000Z'), expiresAt: new Date('2026-11-30T00:00:00.000Z'), revokedAt: null, grantRevokedAt: null };
const authority = queue => resolvePersistedLuxifyAuthority({ tx: fakeDb(queue).tx, accountId: SUBJECT, lookIdentityIds: [IDENTITY], intent: {} });

test('render authority accepts an active on-behalf grant and refuses it once expired or withdrawn', async () => {
  const ok = await authority([[spaceRow], [identityRow], [oboRow()], [{ revokedAt: null }], [resourceRow], [evidenceRow], [approvalRow]]);
  assert.deepEqual(ok.lookBindings, [{ identityId: IDENTITY, providerLookId: LOOK }]);
  await assert.rejects(authority([[spaceRow], [identityRow], [oboRow({ expiresAt: new Date('2026-11-09T00:00:00.000Z') })], [{ revokedAt: null }], [resourceRow], [evidenceRow], [approvalRow]]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE', reason: 'CONSENT_INVALID' });
  // After withdraw the open-consent query returns nothing: the render is blocked.
  await assert.rejects(authority([[spaceRow], [identityRow], []]), { code: 'LUXIFY_CONSENT_MISSING' });
});

test('job consent link: resolved on the job account at enqueue; re-checked at provider submit (withdrawn, expired, cross-account or look mismatch -> refused)', async () => {
  const open = { id: CONSENT, accountId: SUBJECT, identityId: IDENTITY, providerLookId: LOOK, expiresAt: new Date('2027-11-09T00:00:00.000Z'), revokedAt: null };
  const binding = { identityId: IDENTITY, providerLookId: LOOK };
  assert.equal(await resolveLuxifyJobConsentIdTx(fakeDb([[open]]).tx, { accountId: SUBJECT, lookBinding: binding, now: NOW }), CONSENT);
  for (const rows of [[], [{ ...open, accountId: OTHER }], [{ ...open, expiresAt: NOW }], [{ ...open, revokedAt: NOW }]]) {
    await assert.rejects(resolveLuxifyJobConsentIdTx(fakeDb([rows]).tx, { accountId: SUBJECT, lookBinding: binding, now: NOW }), { code: 'LUXIFY_CONSENT_MISSING' });
  }
  const job = { accountId: SUBJECT, luxifyConsentId: CONSENT, input: { lookBindings: [binding] } };
  assert.equal(await assertLuxifyJobConsentTx(fakeDb([[open]]).tx, { job, now: NOW }), true);
  for (const rows of [[], [{ ...open, revokedAt: NOW }], [{ ...open, expiresAt: NOW }], [{ ...open, accountId: OTHER }], [{ ...open, providerLookId: 'look_else' }], [{ ...open, identityId: SOURCE }]]) {
    await assert.rejects(assertLuxifyJobConsentTx(fakeDb([rows]).tx, { job, now: NOW }), { code: 'LUXIFY_CONSENT_WITHDRAWN', statusCode: 409 });
  }
});

test('consent_operator grants: verified CEO only, never self-granted, separate scope from creative_approval', async () => {
  const ceo = { id: CEO, email: 'ceo@luxmarketingcompany.com', role: 'ceo' };
  const repo = queue => createLuxifyConsentRepository({ executor: fakeDb(queue).executor });
  await assert.rejects(repo([]).grantConsentOperator({ grantorAccountId: CEO, staffAccountId: CEO, explicitGrant: true }), { code: 'LUX_CONSENT_OPERATOR_SELF_GRANT' });
  await assert.rejects(repo([[{ ...ceo, role: 'customer' }]]).grantConsentOperator({ grantorAccountId: CEO, staffAccountId: OPERATOR, explicitGrant: true }), { code: 'LUX_STAFF_GRANTOR_REQUIRED' });
  const ok = fakeDb([[ceo], verified, [operatorAccount], verified, [], [{ id: GRANT_ID }]]);
  assert.deepEqual(await createLuxifyConsentRepository({ executor: ok.executor }).grantConsentOperator({ grantorAccountId: CEO, staffAccountId: OPERATOR, explicitGrant: true }), { grantId: GRANT_ID, replayed: false });
  const values = arg(writes(ok.log)[0], 'values');
  assert.equal(values.scope, 'consent_operator');
  assert.equal(values.grantedByAccountId, CEO);
  assert.equal(values.staffAccountId, OPERATOR);
});

// ---- route --------------------------------------------------------------
const ORIGIN = 'https://video.example';
const ENV = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: 'consent-obo-route-test-secret-at-least-32-bytes' };
const NOW_MS = NOW.getTime();
function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = raw ? JSON.parse(raw) : null; } }; }
function request(body, headers = {}) {
  return { method: 'POST', url: '/api/video-os-lite/luxify-consent', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body };
}
function fixture({ session = { accountId: OPERATOR }, ...overrides } = {}) {
  const calls = [];
  const record = name => async input => { calls.push([name, input]); if (overrides[name]) return overrides[name](input); return { consent: { id: CONSENT, status: 'active' }, replayed: false, changed: true, identities: [{ id: IDENTITY, displayName: 'Look' }], consents: [] }; };
  const repository = Object.fromEntries(['grantConsent', 'withdrawConsent', 'grantConsentOnBehalf', 'operatorWithdrawConsent', 'operatorConsentContext', 'grantConsentOperator'].map(name => [name, record(name)]));
  const handler = createLuxifyConsentHandler({ authenticate: () => session, environment: ENV, repository, now: () => NOW_MS });
  return { handler, calls };
}
const operatorChallenge = (operator = OPERATOR, subject = SUBJECT) => issueLuxifyConsentChallenge({ accountId: luxifyOperatorChallengeSubject({ operatorAccountId: operator, onBehalfOfAccountId: subject }), identityId: IDENTITY, now: NOW_MS, env: ENV });
const oboBody = (overrides = {}) => ({
  action: 'grant-on-behalf', onBehalfOfAccountId: SUBJECT, identityId: IDENTITY, idempotencyKey: KEY, challenge: operatorChallenge(),
  noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true,
  subjectName: SUBJECT_NAME, attestationMethod: 'written', attestedAt: ATTESTED, attestationEvidenceRef: EVIDENCE_REF, attestationConfirmed: true, ...overrides,
});

test('route: grant-on-behalf takes the operator from the session; a body operator field is refused', async () => {
  const { handler, calls } = fixture();
  const logs = [];
  const original = console.log;
  console.log = line => logs.push(String(line));
  const res = response();
  try { await handler(request(oboBody(), { 'x-vercel-id': 'iad1::abc-123' }), res); } finally { console.log = original; }
  assert.equal(res.statusCode, 201);
  assert.equal(calls[0][0], 'grantConsentOnBehalf');
  assert.equal(calls[0][1].operatorAccountId, OPERATOR);
  assert.equal(calls[0][1].onBehalfOfAccountId, SUBJECT);
  assert.equal(calls[0][1].requestId, 'iad1::abc-123');
  assert.match(calls[0][1].challengeSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(logs.join('\n'), /Test Subject Person|consent-evidence|challenge/, 'secret-safe logs: no name, evidence path or challenge');

  for (const extra of [{ operatorAccountId: 'forged-operator' }, { operatorUserId: 'forged' }, { accountId: SUBJECT }]) {
    const forged = fixture();
    const forgedRes = response();
    await forged.handler(request(oboBody(extra)), forgedRes);
    assert.equal(forgedRes.statusCode, 400);
    assert.equal(forged.calls.length, 0);
  }
});

test('route: customer / non-operator sessions get 403 from the server-side grant check; anonymous gets 401', async () => {
  const denied = () => { throw Object.assign(new Error('Only a Lux consent operator can record consent on behalf of a subject.'), { code: 'LUX_CONSENT_OPERATOR_REQUIRED', statusCode: 403 }); };
  for (const action of [oboBody(), { action: 'operator-withdraw', consentId: CONSENT }, { action: 'operator-context', onBehalfOfAccountId: SUBJECT }]) {
    const customer = fixture({ session: { accountId: OTHER }, grantConsentOnBehalf: denied, operatorWithdrawConsent: denied, operatorConsentContext: denied });
    const res = response();
    // A customer cannot even get past the challenge for someone else's operator subject.
    await customer.handler(request(action.action === 'grant-on-behalf' ? oboBody({ challenge: operatorChallenge(OTHER) }) : action), res);
    assert.equal(res.statusCode, 403, action.action);
    assert.equal(res.body.code, 'LUX_CONSENT_OPERATOR_REQUIRED');
  }
  const anon = fixture({ session: null });
  const anonRes = response();
  await anon.handler(request(oboBody()), anonRes);
  assert.equal(anonRes.statusCode, 401);
  assert.equal(anon.calls.length, 0);
});

test('route: attestation fields are required by the schema', async () => {
  for (const body of [oboBody({ attestationConfirmed: false }), oboBody({ attestationConfirmed: undefined }), oboBody({ subjectName: '' }), oboBody({ attestedAt: undefined }), oboBody({ attestationMethod: 'email' }), oboBody({ attestationEvidenceRef: undefined }), oboBody({ expiryDays: 366 })]) {
    const { handler, calls } = fixture();
    const res = response();
    await handler(request(body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});

test('route: challenges are bound to operator + on-behalf account and never cross with the self-consent path', async () => {
  const selfChallenge = issueLuxifyConsentChallenge({ accountId: SUBJECT, identityId: IDENTITY, now: NOW_MS, env: ENV });
  for (const challenge of [selfChallenge, operatorChallenge('other-operator'), operatorChallenge(OPERATOR, OTHER)]) {
    const { handler, calls } = fixture();
    const res = response();
    await handler(request(oboBody({ challenge })), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'LUXIFY_CONSENT_CHALLENGE_INVALID');
    assert.equal(calls.length, 0);
  }
  // An operator challenge cannot be replayed by the subject through self 'grant'.
  const subject = fixture({ session: { accountId: SUBJECT } });
  const res = response();
  await subject.handler(request({ action: 'grant', identityId: IDENTITY, idempotencyKey: KEY, challenge: operatorChallenge(), noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(subject.calls.length, 0);
});

test('route: operator-context issues operator-bound challenges after the server-side grant check', async () => {
  const { handler, calls } = fixture();
  const res = response();
  await handler(request({ action: 'operator-context', onBehalfOfAccountId: SUBJECT }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], ['operatorConsentContext', { operatorAccountId: OPERATOR, onBehalfOfAccountId: SUBJECT }]);
  assert.equal(res.body.attestationVersion, 'luxify-operator-attestation/v1');
  const challenge = res.body.identities[0].challenge;
  const grant = fixture();
  const grantRes = response();
  await grant.handler(request(oboBody({ challenge })), grantRes);
  assert.equal(grantRes.statusCode, 201, 'the issued challenge verifies for the same operator and account');
});

test('route regression: self-consent grant and withdraw still act only as the signed-in subject', async () => {
  const { handler, calls } = fixture({ session: { accountId: SUBJECT } });
  const grantRes = response();
  await handler(request({ action: 'grant', identityId: IDENTITY, idempotencyKey: KEY, challenge: issueLuxifyConsentChallenge({ accountId: SUBJECT, identityId: IDENTITY, now: NOW_MS, env: ENV }), noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true }), grantRes);
  assert.equal(grantRes.statusCode, 201);
  await handler(request({ action: 'withdraw', consentId: CONSENT }), response());
  assert.deepEqual(calls.map(([name, input]) => [name, input.accountId]), [['grantConsent', SUBJECT], ['withdrawConsent', SUBJECT]]);
  assert.equal(Object.hasOwn(calls[0][1], 'operatorAccountId'), false);
});
