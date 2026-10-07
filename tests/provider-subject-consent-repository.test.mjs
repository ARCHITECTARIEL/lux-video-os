import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
  buildHostedAvatarConsentProjection,
  classifyHostedAvatarConsentReplay,
  hostedAvatarConsentRequestDigest,
  issueHostedSubjectNoticeChallengeTx,
  acceptHostedSubjectConsentNoticeTx,
  providerSubjectConsentActivationStatus,
} from '../db/provider-subject-consent-repository.js';

const SHA = character => character.repeat(64);

const REQUEST = Object.freeze({
  accountId: 'account-1',
  identityId: '11111111-1111-4111-8111-111111111111',
  identityConsentId: '22222222-2222-4222-8222-222222222222',
  policyVersion: 'identity-provider-subject-consent-v3',
  providerGroupId: 'group_123',
  providerBinding: Object.freeze({
    bindingId: '33333333-3333-4333-8333-333333333333',
    originScopeKey: SHA('a'),
    verifiedAccountScopeId: '44444444-4444-4444-8444-444444444444',
  }),
  idempotencyKey: '55555555-5555-4555-8555-555555555555',
  rerouteUrlDigest: SHA('b'),
});

test('hosted consent request digest is canonical and binds every authority dimension', () => {
  const first = hostedAvatarConsentRequestDigest(REQUEST);
  const reordered = hostedAvatarConsentRequestDigest({
    rerouteUrlDigest: REQUEST.rerouteUrlDigest,
    providerBinding: {
      verifiedAccountScopeId: REQUEST.providerBinding.verifiedAccountScopeId,
      originScopeKey: REQUEST.providerBinding.originScopeKey,
      bindingId: REQUEST.providerBinding.bindingId,
    },
    providerGroupId: REQUEST.providerGroupId,
    policyVersion: REQUEST.policyVersion,
    identityConsentId: REQUEST.identityConsentId,
    identityId: REQUEST.identityId,
    idempotencyKey: REQUEST.idempotencyKey,
    accountId: REQUEST.accountId,
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(reordered, first);

  for (const [key, value] of [
    ['accountId', 'account-2'],
    ['identityId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['identityConsentId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ['policyVersion', 'identity-provider-bridge-v3'],
    ['providerGroupId', 'group_456'],
    ['idempotencyKey', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['rerouteUrlDigest', SHA('c')],
  ]) {
    assert.notEqual(hostedAvatarConsentRequestDigest({ ...REQUEST, [key]: value }), first, key);
  }
  assert.notEqual(hostedAvatarConsentRequestDigest({
    ...REQUEST,
    providerBinding: { ...REQUEST.providerBinding, bindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  }), first, 'bindingId');
  assert.notEqual(hostedAvatarConsentRequestDigest({
    ...REQUEST,
    providerBinding: { ...REQUEST.providerBinding, originScopeKey: SHA('d') },
  }), first, 'originScopeKey');
  assert.notEqual(hostedAvatarConsentRequestDigest({
    ...REQUEST,
    providerBinding: { ...REQUEST.providerBinding, verifiedAccountScopeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
  }), first, 'verifiedAccountScopeId');
});

test('hosted consent remains default-off and requires the exact activation value', () => {
  assert.equal(HOSTED_SUBJECT_CONSENT_POLICY_VERSION, 'identity-provider-subject-consent-v3');
  assert.deepEqual(providerSubjectConsentActivationStatus({}), { enabled: false, reason: 'hosted_subject_consent_disabled' });
  assert.deepEqual(providerSubjectConsentActivationStatus({ VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED: 'TRUE' }), {
    enabled: true,
    reason: 'owner_authorized_hosted_subject_consent',
  });
  assert.deepEqual(providerSubjectConsentActivationStatus({ VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED: '1' }), {
    enabled: false,
    reason: 'hosted_subject_consent_disabled',
  });
});

test('subject notice acceptance writes a dedicated likeness-only identity consent receipt', async () => {
  const identityId = REQUEST.identityId;
  const accountId = REQUEST.accountId;
  const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const now = new Date('2026-10-07T14:00:00.000Z');
  const expiresAt = new Date('2026-10-07T15:00:00.000Z');
  const selects = [
    [{ id: identityId }],
    [{
      id: challengeId,
      accountId,
      tokenHash: SHA('1'),
      challengeType: `provider_subject_consent_notice:${identityId}`,
      expiresAt,
      usedAt: null,
    }],
    [],
    [{
      id: 'source-consent',
      accountId,
      identityId,
      policyVersion: 'identity-provider-bridge-v2',
      photoSha256: SHA('2'),
      sourceVideoSha256: SHA('3'),
      voiceSha256: SHA('4'),
      revokedAt: null,
    }],
    [],
  ];
  const inserts = [];
  const updates = [];
  const chain = rows => ({
    where() { return this; },
    orderBy() { return this; },
    for() { return this; },
    limit() { return Promise.resolve(rows); },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  });
  const tx = {
    select() { return { from() { return chain(selects.shift() || []); } }; },
    insert(table) {
      return {
        values(value) {
          inserts.push({ table, value });
          return {
            returning: async () => [{ ...value, id: value.challengeType ? challengeId : 'new-v3-consent' }],
          };
        },
      };
    },
    update(table) {
      return {
        set(value) {
          updates.push({ table, value });
          return { where() { return { returning: async () => [{ id: challengeId, ...value }] }; } };
        },
      };
    },
  };

  const issued = await issueHostedSubjectNoticeChallengeTx(tx, {
    accountId,
    identityId,
    subjectEmail: 'Subject@Example.com',
    tokenHash: SHA('1'),
    expiresAt,
    now,
  });
  assert.deepEqual(issued, { challengeId, expiresAt: expiresAt.toISOString() });
  assert.equal(inserts[0].value.challengeType, `provider_subject_consent_notice:${identityId}`);
  assert.equal(inserts[0].value.email, 'subject@example.com');

  const accepted = await acceptHostedSubjectConsentNoticeTx(tx, {
    accountId,
    identityId,
    noticeTokenHash: SHA('1'),
    policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
    now,
  });
  assert.equal(accepted.replayed, false);
  assert.equal(updates[0].value.usedAt, now);
  assert.deepEqual(inserts[1].value, {
    accountId,
    identityId,
    idempotencyKey: challengeId,
    audioExtractionAuthorization: false,
    faceAuthorization: true,
    voiceAuthorization: false,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: false,
    policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
    consentPurpose: 'hosted-avatar-consent',
    photoSha256: SHA('2'),
    sourceVideoSha256: SHA('3'),
    voiceSha256: SHA('4'),
    acceptedAt: now,
    revokedAt: null,
  });
});

test('schema migration adds a distinct consent-submit operation without repurposing avatar creation', async () => {
  const [migration, repository, subjectRepository] = await Promise.all([
    readFile(new URL('../drizzle/0011_concerned_micromacro.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/provider-reconciliation-repository.js', import.meta.url), 'utf8'),
    readFile(new URL('../db/provider-subject-consent-repository.js', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /'avatar_create', 'avatar_consent_submit', 'voice_clone'/);
  assert.match(migration, /identity-provider-subject-consent-v3/);
  assert.match(migration, /voice_authorization. = false/);
  assert.match(repository, /avatar_consent_submit: new Set\(\[\]\)/);
  assert.match(repository, /avatar_create: new Set\(\['avatar_group', 'avatar_look'\]\)/);
  assert.match(subjectRepository, /provider_subject_consent_notice:/);
  assert.match(subjectRepository, /eq\(authChallenges\.id, consent\.idempotencyKey\)/);
});

test('exact replay never submits twice and changed bodies fail locally', () => {
  const exact = classifyHostedAvatarConsentReplay({
    existing: {
      id: 'operation-1',
      applicationAccountId: REQUEST.accountId,
      identityId: REQUEST.identityId,
      kind: 'avatar_consent_submit',
      originOperationKey: REQUEST.idempotencyKey,
      requestDigest: SHA('f'),
      state: 'pending',
    },
    expected: {
      accountId: REQUEST.accountId,
      identityId: REQUEST.identityId,
      idempotencyKey: REQUEST.idempotencyKey,
      requestDigest: SHA('f'),
    },
  });
  assert.deepEqual(exact, { replayed: true, shouldSubmit: false });

  assert.throws(() => classifyHostedAvatarConsentReplay({
    existing: {
      id: 'operation-1', applicationAccountId: REQUEST.accountId, identityId: REQUEST.identityId,
      kind: 'avatar_consent_submit', originOperationKey: REQUEST.idempotencyKey,
      requestDigest: SHA('f'), state: 'pending',
    },
    expected: {
      accountId: REQUEST.accountId,
      identityId: REQUEST.identityId,
      idempotencyKey: REQUEST.idempotencyKey,
      requestDigest: SHA('0'),
    },
  }), { code: 'PROVIDER_OPERATION_CONFLICT' });
});

test('an ambiguous attempt blocks automatic replacement even under a new key', () => {
  assert.throws(() => classifyHostedAvatarConsentReplay({
    existing: null,
    unresolved: [{
      id: 'operation-ambiguous',
      state: 'ambiguous',
      kind: 'avatar_consent_submit',
      identityId: REQUEST.identityId,
    }],
    expected: {
      accountId: REQUEST.accountId,
      identityId: REQUEST.identityId,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
      requestDigest: SHA('9'),
    },
  }), { code: 'PROVIDER_CONSENT_RECONCILIATION_REQUIRED' });
});

test('projection separates return, provider readback, authorization, and URL custody', () => {
  const operation = {
    id: 'operation-1',
    state: 'pending',
    createdAt: new Date('2026-10-07T12:00:00.000Z'),
    updatedAt: new Date('2026-10-07T12:02:00.000Z'),
  };
  const events = [
    {
      eventType: 'provider.avatar_consent_session_issued',
      observedAt: new Date('2026-10-07T12:00:10.000Z'),
      details: {
        hostedSessionState: 'ISSUED',
        providerUrlDigest: SHA('7'),
        privateUrlEvidenceRef: 'video-os/auth/consent-url-operation-1.json',
        providerUrlExpiresAt: '2026-10-08T12:00:10.000Z',
      },
    },
    {
      eventType: 'provider.avatar_consent_returned',
      observedAt: new Date('2026-10-07T12:01:00.000Z'),
      details: { hostedSessionState: 'RETURNED' },
    },
    {
      eventType: 'provider.avatar_consent_readback',
      observedAt: new Date('2026-10-07T12:02:00.000Z'),
      details: { providerConsentStatus: 'PENDING' },
    },
  ];
  const projection = buildHostedAvatarConsentProjection({
    operation,
    events,
    authorization: { active: true, withdrawnAt: null },
  });
  assert.deepEqual(projection, {
    attemptId: 'operation-1',
    attemptState: 'SUBMITTED',
    terminalOutcome: null,
    hostedSessionState: 'RETURNED',
    providerConsentStatus: 'PENDING',
    luxAuthorizationStatus: 'ACTIVE',
    createdAt: '2026-10-07T12:00:00.000Z',
    updatedAt: '2026-10-07T12:02:00.000Z',
  });
  assert.equal(JSON.stringify(projection).includes('video-os/auth/'), false);
  assert.equal(JSON.stringify(projection).includes(SHA('7')), false);
  assert.notEqual(projection.providerConsentStatus, 'ACCEPTED', 'browser return cannot self-certify acceptance');
});

test('issued-session metadata rejects raw URLs before any database write', () => {
  assert.throws(() => buildHostedAvatarConsentProjection({
    operation: { id: 'operation-1', state: 'pending', createdAt: new Date(0), updatedAt: new Date(1) },
    events: [{
      eventType: 'provider.avatar_consent_session_issued',
      observedAt: new Date(1),
      details: { providerConsentUrl: 'https://app.heygen.com/consent/private' },
    }],
    authorization: { active: true, withdrawnAt: null },
  }), { code: 'PROVIDER_CONSENT_EVIDENCE_INVALID' });
});

test('accepted and rejected readbacks are explicit, while ambiguity remains visible', () => {
  const accepted = buildHostedAvatarConsentProjection({
    operation: { id: 'accepted', state: 'succeeded', createdAt: new Date(0), updatedAt: new Date(1) },
    events: [{
      eventType: 'provider.avatar_consent_readback', observedAt: new Date(1),
      details: { providerConsentStatus: 'ACCEPTED', terminalOutcome: 'SUCCEEDED' },
    }],
    authorization: { active: false, withdrawnAt: new Date(2) },
  });
  assert.equal(accepted.providerConsentStatus, 'ACCEPTED');
  assert.equal(accepted.terminalOutcome, 'SUCCEEDED');
  assert.equal(accepted.luxAuthorizationStatus, 'WITHDRAWN');

  const ambiguous = buildHostedAvatarConsentProjection({
    operation: { id: 'ambiguous', state: 'ambiguous', createdAt: new Date(0), updatedAt: new Date(1) },
    events: [{
      eventType: 'provider.avatar_consent_readback', observedAt: new Date(2),
      details: { providerConsentStatus: 'REJECTED', terminalOutcome: 'REJECTED' },
    }],
    authorization: { active: true, withdrawnAt: null },
  });
  assert.equal(ambiguous.attemptState, 'AMBIGUOUS');
  assert.equal(ambiguous.providerConsentStatus, 'REJECTED');
  assert.equal(ambiguous.terminalOutcome, 'REJECTED');
});
