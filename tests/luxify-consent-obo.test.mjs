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
  luxifyConsentOboEnabled,
  issueLuxifyConsentChallenge,
  luxifyOboConfirmationTokenHash,
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

function fakeDb(queue, now = NOW, executeResults = null) {
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
  const tx = { execute: async () => (executeResults?.length ? executeResults.shift() : [{ now }]), select: () => chain('select'), update: () => chain('update'), insert: () => chain('insert') };
  return { log, tx, executor: { transaction: async callback => callback(tx) } };
}
const arg = (entry, method) => entry.calls.find(([name]) => name === method)?.[1]?.[0];
const writes = log => log.filter(entry => entry.kind !== 'select');
const echoInsert = entry => [{ ...arg(entry, 'values') }];

const operatorAccount = { id: OPERATOR, email: 'operator@luxmarketingcompany.com' };
const operatorGrant = (overrides = {}) => ({ id: GRANT_ID, staffAccountId: OPERATOR, staffEmail: 'operator@luxmarketingcompany.com', scope: 'consent_operator', explicitGrant: true, grantedByAccountId: CEO, revokedAt: null, ...overrides });
const verified = [{ usedAt: NOW }];
const ceoAccount = { id: CEO, email: 'ceo@luxmarketingcompany.com' };
// operator account, consent_operator grant, magic-link proof, grantor (QA M1 canonical-mailbox check)
const operatorQueue = (grant = operatorGrant(), grantor = ceoAccount) => [[operatorAccount], [grant], verified, [grantor]];
const subjectAccount = { id: SUBJECT, email: 'subject@example.test' };
const subjectQueue = () => [[subjectAccount], verified];
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
const bindingQueue = () => [[identityRow], [sourceRow], [spaceRow], [{ id: RESOURCE }]];
const happyQueue = (active = []) => [...operatorQueue(), [], ...subjectQueue(), ...bindingQueue(), active, [{ challengeSha256: CHALLENGE }], echoInsert, [{ id: 'audit-1' }], []];
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
  assert.equal(inserts.length, 4, 'challenge use + consent + audit + subject confirmation link');
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
  assert.equal(result.consent.status, 'pending_confirmation', 'H1b: on-behalf grants start pending');
  assert.equal(result.consent.consentMode, 'operator_on_behalf');
  // H1b: single-use link on auth_challenges, hash only, to the subject's verified email, 7 days.
  const link = arg(inserts[3], 'values');
  assert.equal(link.accountId, SUBJECT);
  assert.equal(link.email, 'subject@example.test');
  assert.equal(link.challengeType, `luxify-obo-confirm:${values.id}`);
  assert.equal(link.usedAt, null);
  assert.equal(link.expiresAt.toISOString(), '2026-11-16T15:00:00.000Z');
  assert.match(result.confirmation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(link.tokenHash, luxifyOboConfirmationTokenHash(result.confirmation.token));
  assert.equal(JSON.stringify(link).includes(result.confirmation.token), false, 'raw token never stored');
  assert.equal(result.confirmation.email, 'subject@example.test');
});

test('H1b: the subject account must have a magic-link-verified email; otherwise nothing is written', async () => {
  for (const subject of [[[]], [[subjectAccount], []], [[{ id: SUBJECT, email: 'not-an-email' }], verified]]) {
    const { executor, log } = fakeDb([...operatorQueue(), [], ...subject]);
    await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput()), { code: 'LUXIFY_SUBJECT_EMAIL_UNVERIFIED', statusCode: 409 });
    assert.equal(writes(log).length, 0);
  }
});

test('QA L1: an attestation inside the 5-minute forward skew gets an expiry capped at accepted + 365 days (no raw window_ck 503)', async () => {
  const attestedAt = '2026-11-09T15:04:00.000Z';
  const { executor, log } = fakeDb(happyQueue());
  await createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput({ attestedAt }));
  const values = arg(writes(log).filter(entry => entry.kind === 'insert')[1], 'values');
  const cap = NOW.getTime() + 365 * 86_400_000;
  assert.equal(values.expiresAt.getTime(), cap, 'min(attested + 12 months, accepted + 365 days)');
  assert.ok(values.expiresAt.getTime() <= new Date(attestedAt).getTime() + 8760 * 3_600_000, 'attestation_ck bound holds');
});

test('QA L3: renewal over an expired on-behalf row closes it AND audits consent.superseded; a lapsed pending row is closed as confirmation_expired and audited', async () => {
  const expiredObo = { id: CONSENT, accountId: SUBJECT, expiresAt: new Date('2026-11-01T00:00:00.000Z'), consentMode: 'operator_on_behalf', operatorStaffGrantId: GRANT_ID };
  // confirmed (audit row found) but expired -> revoked + superseded audit
  const queue = [...operatorQueue(), [], ...subjectQueue(), ...bindingQueue(), [expiredObo], [{ id: 'confirmed' }], [], [{ id: 'audit-s' }], [{ challengeSha256: CHALLENGE }], echoInsert, [{ id: 'audit-1' }], []];
  let fake = fakeDb(queue);
  await createLuxifyConsentRepository({ executor: fake.executor }).grantConsentOnBehalf(oboInput());
  const w = writes(fake.log);
  assert.deepEqual(arg(w[0], 'set'), { revokedAt: NOW, terminalReason: 'revoked' });
  const superseded = arg(w[1], 'values');
  assert.deepEqual([superseded.event, superseded.actorType, superseded.actorAccountId, superseded.consentId], ['consent.superseded', 'operator', OPERATOR, CONSENT]);

  // pending, link lapsed -> confirmation_expired + audit, then the new grant proceeds
  const pending = { ...expiredObo, expiresAt: new Date('2027-11-01T00:00:00.000Z') };
  const lapsedQueue = [...operatorQueue(), [], ...subjectQueue(), ...bindingQueue(), [pending], [], [{ expiresAt: new Date('2026-11-09T00:00:00.000Z'), usedAt: null }],
    entry => [{ ...pending, ...arg(entry, 'set') }], [{ id: 'audit-x' }], [{ challengeSha256: CHALLENGE }], echoInsert, [{ id: 'audit-1' }], []];
  fake = fakeDb(lapsedQueue);
  await createLuxifyConsentRepository({ executor: fake.executor }).grantConsentOnBehalf(oboInput());
  const lw = writes(fake.log);
  assert.deepEqual(arg(lw[0], 'set'), { revokedAt: NOW, terminalReason: 'confirmation_expired' });
  const expiry = arg(lw[1], 'values');
  assert.deepEqual([expiry.event, expiry.actorType, expiry.actorAccountId, expiry.consentId], ['consent.confirmation_expired', 'system', SUBJECT, CONSENT]);

  // pending with a live link -> still blocks renewal, nothing written
  fake = fakeDb([...operatorQueue(), [], ...subjectQueue(), ...bindingQueue(), [pending], [], [{ expiresAt: new Date('2026-11-12T00:00:00.000Z'), usedAt: null }]]);
  await assert.rejects(createLuxifyConsentRepository({ executor: fake.executor }).grantConsentOnBehalf(oboInput()), { code: 'LUXIFY_CONSENT_ALREADY_ACTIVE' });
  assert.equal(writes(fake.log).length, 0);

  // self subject renewal over an expired on-behalf row is audited too (actor subject)
  const selfQueue = [[], [identityRow], [sourceRow], [spaceRow], [expiredObo], [{ id: 'confirmed' }], [], [{ id: 'audit-ss' }], [{ challengeSha256: CHALLENGE }], echoInsert];
  fake = fakeDb(selfQueue);
  await createLuxifyConsentRepository({ executor: fake.executor }).grantConsent({ accountId: SUBJECT, identityId: IDENTITY, idempotencyKey: KEY, cinematicGenerationAuthorization: true, providerProcessingAuthorization: true, noticeSha256: LUXIFY_CONSENT_NOTICE_SHA256, challengeSha256: CHALLENGE });
  const sw = writes(fake.log);
  assert.equal(arg(sw[1], 'values').event, 'consent.superseded');
  assert.equal(arg(sw[1], 'values').actorType, 'subject');
});

test('non-operators are refused with nothing written: no grant (customer/CEO/creative-only), self-granted, unverified or mismatched email', async () => {
  for (const queue of [
    [[operatorAccount], []],
    [[operatorAccount], [operatorGrant({ grantedByAccountId: OPERATOR })]],
    [[operatorAccount], [operatorGrant()], []],
    [[{ ...operatorAccount, email: 'operator2@luxmarketingcompany.com' }], [operatorGrant()], verified],
    [[{ id: OPERATOR, email: 'operator@example.test' }], [operatorGrant()], verified],
    [[], [operatorGrant()]],
    // QA M1: a +tag alias never operates, and the grantor's own mailbox never operates.
    [[{ id: OPERATOR, email: 'ceo+op@luxmarketingcompany.com' }], [operatorGrant({ staffEmail: 'ceo+op@luxmarketingcompany.com' })], verified, [ceoAccount]],
    [[operatorAccount], [operatorGrant()], verified, [{ id: CEO, email: 'Operator+x@luxmarketingcompany.com' }]],
    [[operatorAccount], [operatorGrant()], verified, []],
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
    [[...operatorQueue(), [], ...subjectQueue(), []], { code: 'LUXIFY_CONSENT_SUBJECT_REQUIRED', statusCode: 403 }],
    [[...operatorQueue(), [], ...subjectQueue(), [{ ...identityRow, avatarStatus: 'PROCESSING' }]], { code: 'LUXIFY_IDENTITY_NOT_ELIGIBLE' }],
    [[...operatorQueue(), [], ...subjectQueue(), [identityRow], []], { code: 'LUXIFY_SOURCE_CONSENT_REQUIRED' }],
    [[...operatorQueue(), [], ...subjectQueue(), [identityRow], [sourceRow], []], { code: 'LUXIFY_PROVIDER_SPACE_UNAVAILABLE' }],
    [[...operatorQueue(), [], ...subjectQueue(), [identityRow], [sourceRow], [spaceRow], []], { code: 'LUXIFY_LOOK_OWNERSHIP_UNPROVEN', statusCode: 409 }],
    [[...operatorQueue(), [], ...subjectQueue(), ...bindingQueue(), [{ id: CONSENT, expiresAt: new Date('2027-01-01T00:00:00.000Z') }]], { code: 'LUXIFY_CONSENT_ALREADY_ACTIVE' }],
  ];
  for (const [queue, expected] of cases) {
    const { executor, log } = fakeDb(queue);
    await assert.rejects(createLuxifyConsentRepository({ executor }).grantConsentOnBehalf(oboInput()), expected);
    assert.equal(writes(log).length, 0, expected.code);
  }
});

test('idempotent submission: same operator + same attestation replays; any difference is a conflict', async () => {
  const replay = fakeDb([...operatorQueue(), [oboRow()], []]);
  const result = await createLuxifyConsentRepository({ executor: replay.executor }).grantConsentOnBehalf(oboInput());
  assert.equal(result.replayed, true);
  assert.equal(result.confirmation, null, 'a replay never issues or re-sends a confirmation link');
  assert.equal(result.consent.status, 'pending_confirmation');
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
  const confirmed = [{ id: 'audit-confirmed' }];
  const ok = await authority([[spaceRow], [identityRow], [oboRow()], confirmed, [{ revokedAt: null }], [resourceRow], [evidenceRow], [approvalRow]]);
  assert.deepEqual(ok.lookBindings, [{ identityId: IDENTITY, providerLookId: LOOK }]);
  // H1b: pending (no subject_confirmed audit row) counts for nothing at eligibility.
  await assert.rejects(authority([[spaceRow], [identityRow], [oboRow()], [], [{ revokedAt: null }], [resourceRow], [evidenceRow], [approvalRow]]), { code: 'LUXIFY_CONSENT_PENDING_CONFIRMATION', statusCode: 409 });
  await assert.rejects(authority([[spaceRow], [identityRow], [oboRow({ expiresAt: new Date('2026-11-09T00:00:00.000Z') })], confirmed, [{ revokedAt: null }], [resourceRow], [evidenceRow], [approvalRow]]), { code: 'LUXIFY_LOOK_NOT_ELIGIBLE', reason: 'CONSENT_INVALID' });
  // After withdraw the open-consent query returns nothing: the render is blocked.
  await assert.rejects(authority([[spaceRow], [identityRow], []]), { code: 'LUXIFY_CONSENT_MISSING' });
});

test('job consent link: resolved on the job account at enqueue; re-checked at provider submit (withdrawn, expired, cross-account or look mismatch -> refused)', async () => {
  const open = { id: CONSENT, accountId: SUBJECT, identityId: IDENTITY, providerLookId: LOOK, providerSpaceFingerprint: FP, consentMode: 'self', expiresAt: new Date('2027-11-09T00:00:00.000Z'), revokedAt: null };
  const obo = { ...open, consentMode: 'operator_on_behalf' };
  const binding = { identityId: IDENTITY, providerLookId: LOOK };
  const resolve = queue => resolveLuxifyJobConsentIdTx(fakeDb(queue).tx, { accountId: SUBJECT, lookBinding: binding, now: NOW });
  assert.equal(await resolve([[spaceRow], [open]]), CONSENT);
  assert.equal(await resolve([[spaceRow], [obo], [{ id: 'confirmed' }]]), CONSENT, 'a confirmed on-behalf grant links like a self grant');
  for (const rows of [[], [{ ...open, accountId: OTHER }], [{ ...open, expiresAt: NOW }], [{ ...open, revokedAt: NOW }], [{ ...open, providerSpaceFingerprint: 'a'.repeat(64) }]]) {
    await assert.rejects(resolve([[spaceRow], rows]), { code: 'LUXIFY_CONSENT_MISSING' });
  }
  await assert.rejects(resolve([[spaceRow], [obo], []]), { code: 'LUXIFY_CONSENT_PENDING_CONFIRMATION' }, 'H1b: pending never links at enqueue');
  await assert.rejects(resolve([[]]), { code: 'LUXIFY_PROVIDER_SPACE_UNAVAILABLE' });
  const job = { accountId: SUBJECT, luxifyConsentId: CONSENT, input: { lookBindings: [binding] } };
  const check = queue => assertLuxifyJobConsentTx(fakeDb(queue).tx, { job, now: NOW });
  assert.equal(await check([[open], [spaceRow]]), true);
  assert.equal(await check([[obo], [spaceRow], [{ id: 'confirmed' }]]), true);
  for (const queue of [[[]], [[{ ...open, revokedAt: NOW }]], [[{ ...open, expiresAt: NOW }]], [[{ ...open, accountId: OTHER }]], [[{ ...open, providerLookId: 'look_else' }]], [[{ ...open, identityId: SOURCE }]],
    [[open], []], [[open], [{ ...spaceRow, providerSpaceFingerprint: 'a'.repeat(64) }]], [[obo], [spaceRow], []]]) {
    await assert.rejects(check(queue), { code: 'LUXIFY_CONSENT_WITHDRAWN', statusCode: 409 });
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
  // QA M1: the CEO's +tag alias account cannot be made an operator, and no
  // account whose canonical mailbox is the CEO's can be either.
  const alias = fakeDb([[ceo], verified, [{ id: 'alias-account', email: 'ceo+op@luxmarketingcompany.com' }], verified]);
  await assert.rejects(createLuxifyConsentRepository({ executor: alias.executor }).grantConsentOperator({ grantorAccountId: CEO, staffAccountId: 'alias-account', explicitGrant: true }), { code: 'LUX_CONSENT_OPERATOR_ALIAS', statusCode: 403 });
  assert.equal(writes(alias.log).length, 0);
  const sameMailbox = fakeDb([[{ ...ceo, email: 'ceo+main@luxmarketingcompany.com' }], verified, [{ id: 'twin-account', email: 'ceo@luxmarketingcompany.com' }], verified]);
  await assert.rejects(createLuxifyConsentRepository({ executor: sameMailbox.executor }).grantConsentOperator({ grantorAccountId: CEO, staffAccountId: 'twin-account', explicitGrant: true }), { code: 'LUX_CONSENT_OPERATOR_SELF_GRANT' });
  assert.equal(writes(sameMailbox.log).length, 0);
});

// ---- H1b subject confirmation ---------------------------------------------
const TOKEN = 'A'.repeat(43);
const challengeRow = (overrides = {}) => ({ id: 'challenge-1', accountId: SUBJECT, email: 'subject@example.test', tokenHash: luxifyOboConfirmationTokenHash(TOKEN), challengeType: `luxify-obo-confirm:${CONSENT}`, expiresAt: new Date('2026-11-12T00:00:00.000Z'), usedAt: null, ...overrides });
const confirm = (queue, input = {}) => {
  const fake = fakeDb(queue);
  return { fake, run: createLuxifyConsentRepository({ executor: fake.executor }).confirmOnBehalfConsent({ accountId: SUBJECT, token: TOKEN, requestId: 'req-c', ...input }) };
};

test('H1b: the subject confirms with the single-use link; the link is consumed and consent.subject_confirmed is audited', async () => {
  const { fake, run } = confirm([[challengeRow()], [oboRow()], [subjectAccount], verified, [{ id: 'challenge-1' }], [{ id: 'audit-c' }]]);
  const result = await run;
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.consent.status, 'active');
  const [used, audit] = writes(fake.log);
  assert.deepEqual(arg(used, 'set'), { usedAt: NOW });
  const values = arg(audit, 'values');
  assert.deepEqual([values.event, values.actorType, values.actorAccountId, values.accountId, values.consentId, values.requestId], ['consent.subject_confirmed', 'subject', SUBJECT, SUBJECT, CONSENT, 'req-c']);
  assert.equal(JSON.stringify([arg(used, 'set'), values]).includes(TOKEN), false, 'raw token never written');
});

test('H1b: confirmation refuses a bad, foreign, used or closed link, a wrong mailbox and a lost race; nothing is written', async () => {
  const cases = [
    [[[]], 'LUXIFY_CONFIRMATION_INVALID', 404],
    [[[challengeRow({ accountId: OTHER })]], 'LUXIFY_CONFIRMATION_INVALID', 404],
    [[[challengeRow({ challengeType: 'magic_link' })]], 'LUXIFY_CONFIRMATION_INVALID', 404],
    [[[challengeRow()], [oboRow({ consentMode: 'self' })]], 'LUXIFY_CONFIRMATION_INVALID', 404],
    [[[challengeRow({ usedAt: NOW })], [oboRow()]], 'LUXIFY_CONFIRMATION_USED', 409],
    [[[challengeRow()], [oboRow({ revokedAt: NOW, terminalReason: 'withdrawn' })]], 'LUXIFY_CONFIRMATION_CLOSED', 409],
    [[[challengeRow()], [oboRow()], [subjectAccount], []], 'LUXIFY_CONFIRMATION_EMAIL_MISMATCH', 409],
    [[[challengeRow()], [oboRow()], [{ ...subjectAccount, email: 'changed@example.test' }], verified], 'LUXIFY_CONFIRMATION_EMAIL_MISMATCH', 409],
  ];
  for (const [queue, code, statusCode] of cases) {
    const { fake, run } = confirm(queue);
    await assert.rejects(run, { code, statusCode });
    assert.equal(writes(fake.log).length, 0, code);
  }
  const { run: bad } = confirm([], { token: 'short' });
  await assert.rejects(bad, { code: 'LUXIFY_CONFIRMATION_INVALID' });
  // Concurrent double-click: the conditional used_at update loses -> USED, no audit row.
  const race = confirm([[challengeRow()], [oboRow()], [subjectAccount], verified, []]);
  await assert.rejects(race.run, { code: 'LUXIFY_CONFIRMATION_USED' });
  assert.equal(writes(race.fake.log).filter(entry => entry.kind === 'insert').length, 0);
});

test('H1b: an expired link closes the pending consent as confirmation_expired and audits the expiry (committed, not thrown)', async () => {
  const { fake, run } = confirm([[challengeRow({ expiresAt: new Date('2026-11-09T14:00:00.000Z') })], [oboRow()], entry => [oboRow({ ...arg(entry, 'set') })], [{ id: 'audit-e' }]]);
  const result = await run;
  assert.equal(result.outcome, 'expired');
  assert.equal(result.consent.status, 'confirmation_expired');
  const [close, audit] = writes(fake.log);
  assert.deepEqual(arg(close, 'set'), { revokedAt: NOW, terminalReason: 'confirmation_expired' });
  assert.deepEqual([arg(audit, 'values').event, arg(audit, 'values').actorType], ['consent.confirmation_expired', 'system']);
});

test('H1b: the expiry sweep closes and audits each lapsed pending consent', async () => {
  const rows = [{ id: CONSENT, accountId: SUBJECT, operatorStaffGrantId: GRANT_ID }];
  const fake = fakeDb([entry => [{ ...oboRow(), ...arg(entry, 'set') }], [{ id: 'audit-sweep' }]], NOW, [[{ now: NOW }], rows]);
  assert.deepEqual(await createLuxifyConsentRepository({ executor: fake.executor }).expireUnconfirmedOnBehalfConsents(), { expired: 1 });
  const [close, audit] = writes(fake.log);
  assert.equal(arg(close, 'set').terminalReason, 'confirmation_expired');
  assert.equal(arg(audit, 'values').event, 'consent.confirmation_expired');
});

// ---- route --------------------------------------------------------------
const ORIGIN = 'https://video.example';
const ENV = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: 'consent-obo-route-test-secret-at-least-32-bytes', VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: 'true' };
const ENV_OFF = { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_SESSION_SECRET: ENV.VIDEO_OS_SESSION_SECRET };
const NOW_MS = NOW.getTime();
function response() { return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(raw) { this.body = raw ? JSON.parse(raw) : null; } }; }
function request(body, headers = {}) {
  return { method: 'POST', url: '/api/video-os-lite/luxify-consent', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, body };
}
function fixture({ session = { accountId: OPERATOR }, environment = ENV, mailer: mailerOverride, ...overrides } = {}) {
  const calls = [];
  const sent = [];
  const record = name => async input => { calls.push([name, input]); if (overrides[name]) return overrides[name](input); return { consent: { id: CONSENT, status: 'active' }, replayed: false, changed: true, identities: [{ id: IDENTITY, displayName: 'Look' }], consents: [], outcome: 'confirmed' }; };
  const repository = Object.fromEntries(['grantConsent', 'withdrawConsent', 'revokeConsent', 'grantConsentOnBehalf', 'operatorWithdrawConsent', 'operatorConsentContext', 'grantConsentOperator', 'confirmOnBehalfConsent'].map(name => [name, record(name)]));
  // Stub mailer: records messages, never sends (no real email can go out).
  const mailer = mailerOverride || { assertConfigured: () => {}, sendConfirmation: async message => { sent.push(message); return { sent: true }; } };
  const handler = createLuxifyConsentHandler({ authenticate: () => session, environment, repository, now: () => NOW_MS, mailer });
  return { handler, calls, sent };
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

test('H1a: with VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED unset, grant-consent-operator, operator-context, grant-on-behalf and confirm refuse with 503 CONFIG_MISSING; withdraw paths keep working', async () => {
  for (const body of [
    { action: 'grant-consent-operator', staffAccountId: OPERATOR, explicitGrant: true },
    { action: 'operator-context', onBehalfOfAccountId: SUBJECT },
    oboBody(),
    { action: 'confirm-on-behalf', token: 'A'.repeat(43) },
  ]) {
    for (const environment of [ENV_OFF, { ...ENV, VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: 'false' }, { ...ENV, VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: '1' }]) {
      const { handler, calls, sent } = fixture({ environment });
      const res = response();
      await handler(request(body), res);
      assert.equal(res.statusCode, 503, body.action);
      assert.equal(res.body.code, 'luxify_consent_obo_unavailable');
      assert.equal(calls.length, 0, 'refused before any repository call');
      assert.equal(sent.length, 0);
    }
  }
  for (const [body, expected] of [
    [{ action: 'operator-withdraw', consentId: CONSENT }, 'operatorWithdrawConsent'],
    [{ action: 'withdraw', consentId: CONSENT }, 'withdrawConsent'],
    [{ action: 'revoke', consentId: CONSENT }, 'revokeConsent'],
  ]) {
    const { handler, calls } = fixture({ environment: ENV_OFF });
    const res = response();
    await handler(request(body), res);
    assert.equal(res.statusCode, 200, body.action);
    assert.equal(calls[0][0], expected);
  }
});

test('H1b route: grant-on-behalf mails the single-use link to the subject (stubbed) and never returns or logs the token', async () => {
  const token = 'B'.repeat(43);
  const confirmation = { token, email: 'subject@example.test', expiresAt: '2026-11-16T15:00:00.000Z' };
  const { handler, sent } = fixture({ grantConsentOnBehalf: async () => ({ consent: { id: CONSENT, status: 'pending_confirmation' }, replayed: false, confirmation }) });
  const logs = [];
  const original = console.log;
  console.log = line => logs.push(String(line));
  const res = response();
  try { await handler(request(oboBody()), res); } finally { console.log = original; }
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.consent.status, 'pending_confirmation');
  assert.equal(res.body.confirmationEmail, 'sent');
  assert.equal(res.body.confirmationExpiresAt, confirmation.expiresAt);
  assert.equal(JSON.stringify(res.body).includes(token), false, 'token never in the response');
  assert.equal(JSON.stringify(res.body).includes('subject@example.test'), false, 'subject email never in the response');
  assert.equal(logs.join('\n').includes(token), false, 'token never logged');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, 'subject@example.test');
  assert.equal(sent[0].url, `${ORIGIN}/luxify-consent#confirm=${token}`);

  // Mail failure: the consent stays pending (nothing counts), response says so.
  const failing = fixture({ grantConsentOnBehalf: async () => ({ consent: { id: CONSENT, status: 'pending_confirmation' }, replayed: false, confirmation }),
    mailer: { assertConfigured: () => {}, sendConfirmation: async () => { throw new Error('provider down'); } } });
  const failRes = response();
  await failing.handler(request(oboBody()), failRes);
  assert.equal(failRes.statusCode, 201);
  assert.equal(failRes.body.confirmationEmail, 'failed');

  // Mail not configured: refused before any pending row is created.
  const unconfigured = fixture({ mailer: { assertConfigured: () => { throw Object.assign(new Error('Consent confirmation email is not configured.'), { statusCode: 503, code: 'luxify_confirmation_email_unavailable' }); }, sendConfirmation: async () => assert.fail('must not send') } });
  const unRes = response();
  await unconfigured.handler(request(oboBody()), unRes);
  assert.equal(unRes.statusCode, 503);
  assert.equal(unconfigured.calls.length, 0);
});

test('H1b route: confirm-on-behalf runs as the session subject; an expired link answers 409 LUXIFY_CONFIRMATION_EXPIRED', async () => {
  const { handler, calls } = fixture({ session: { accountId: SUBJECT } });
  const res = response();
  await handler(request({ action: 'confirm-on-behalf', token: 'C'.repeat(43) }, { 'x-request-id': 'req-confirm' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0], ['confirmOnBehalfConsent', { accountId: SUBJECT, token: 'C'.repeat(43), requestId: 'req-confirm' }]);
  const expired = fixture({ session: { accountId: SUBJECT }, confirmOnBehalfConsent: async () => ({ outcome: 'expired', consent: { id: CONSENT, status: 'confirmation_expired' } }) });
  const expiredRes = response();
  await expired.handler(request({ action: 'confirm-on-behalf', token: 'C'.repeat(43) }), expiredRes);
  assert.equal(expiredRes.statusCode, 409);
  assert.equal(expiredRes.body.code, 'LUXIFY_CONFIRMATION_EXPIRED');
  for (const body of [{ action: 'confirm-on-behalf', token: 'short' }, { action: 'confirm-on-behalf', token: 'C'.repeat(43), accountId: OTHER }]) {
    const bad = fixture({ session: { accountId: SUBJECT } });
    const badRes = response();
    await bad.handler(request(body), badRes);
    assert.equal(badRes.statusCode, 400);
    assert.equal(bad.calls.length, 0);
  }
});

test('H1b mailer: the real sender refuses when Resend is unconfigured and posts only to the subject with an https confirm link (fetch stubbed)', async () => {
  const { sendLuxifyConsentConfirmationEmail } = await import('../lib/video-os-notifications.js');
  await assert.rejects(sendLuxifyConsentConfirmationEmail({ email: 'subject@example.test', url: `${ORIGIN}/luxify-consent#confirm=x` }, { env: {}, fetchImpl: () => assert.fail('no fetch') }), { statusCode: 503 });
  const env = { RESEND_API_KEY: 'stub-key-not-real', AUTH_FROM_EMAIL: 'noreply@example.test' };
  await assert.rejects(sendLuxifyConsentConfirmationEmail({ email: 'subject@example.test', url: 'http://video.example/luxify-consent#confirm=x' }, { env, fetchImpl: () => assert.fail('no fetch') }), { statusCode: 400 });
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push([url, JSON.parse(init.body)]); return { ok: true, text: async () => '{}' }; };
  assert.deepEqual(await sendLuxifyConsentConfirmationEmail({ email: 'Subject@Example.test', url: `${ORIGIN}/luxify-consent#confirm=tok`, expiresAt: '2026-11-16T15:00:00.000Z' }, { env, fetchImpl }), { sent: true });
  assert.deepEqual(posted[0][1].to, ['subject@example.test']);
  assert.match(posted[0][1].text, /used once/);
});

test('H1a strict flag: only the exact lowercase string "true" enables on-behalf consent', async () => {
  assert.equal(luxifyConsentOboEnabled({ VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: 'true' }), true);
  const off = [undefined, null, '', ' ', 'TRUE', 'True', ' true ', 'true ', ' true', 'true\n', '1', 'yes', 'on', 'enabled', 'false', '0', 'tru', 'true1', '"true"', true, 1];
  for (const value of off) {
    assert.equal(luxifyConsentOboEnabled({ VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.equal(luxifyConsentOboEnabled({}), false);
  assert.equal(luxifyConsentOboEnabled(undefined), false);
  // Route level: a near-miss value refuses every gated action before the repository.
  for (const value of ['TRUE', ' true ', '1', 'yes']) {
    const { handler, calls } = fixture({ environment: { ...ENV, VIDEO_OS_LUXIFY_CONSENT_OBO_ENABLED: value } });
    const res = response();
    await handler(request({ action: 'confirm-on-behalf', token: 'A'.repeat(43) }), res);
    assert.equal(res.statusCode, 503, value);
    assert.equal(res.body.code, 'luxify_consent_obo_unavailable');
    assert.equal(calls.length, 0);
  }
});
