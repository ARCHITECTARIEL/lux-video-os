import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import {
  authChallenges,
  identityConsents,
  providerLifecycleEvents,
  providerLifecycleOperations,
  providerResources,
  userIdentities,
} from './schema.js';
import {
  assertProviderReceiptOperationTx,
  providerOperationRequestDigest,
  recordProviderOperationFailureTx,
  reserveProviderOperationTx,
} from './provider-reconciliation-repository.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_.:@-]{1,255}$/;
const SAFE_INTERNAL_REF = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const URL_TEXT = /https?:\/\//i;
const CONSENT_KIND = 'avatar_consent_submit';
const LAUNCH_CHALLENGE = 'provider_subject_consent_launch';
const RETURN_CHALLENGE = 'provider_subject_consent_return';
const PROVIDER_CONSENT_STATUSES = new Set(['PENDING', 'ACCEPTED', 'REJECTED']);

export const HOSTED_SUBJECT_CONSENT_POLICY_VERSION = 'identity-provider-subject-consent-v3';

function failure(message, statusCode = 409, code = 'PROVIDER_SUBJECT_CONSENT') {
  return Object.assign(new Error(message), { statusCode, failureCategory: code, code });
}

function exactText(value, label, max = 512) {
  const result = String(value || '');
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw failure(`${label} is invalid.`, 400, 'VALIDATION');
  }
  return result;
}

function digest(value, label) {
  const result = String(value || '');
  if (!SHA256.test(result)) throw failure(`${label} must be a lowercase SHA-256 digest.`, 400, 'VALIDATION');
  return result;
}

function providerId(value, label) {
  const result = exactText(value, label, 255);
  if (!SAFE_PROVIDER_ID.test(result) || result === '.' || result.includes('..') || result.includes('://')) {
    throw failure(`${label} is invalid.`, 400, 'VALIDATION');
  }
  return result;
}

function internalEvidenceRef(value, label) {
  const result = exactText(value, label, 1024);
  if (!SAFE_INTERNAL_REF.test(result) || result.includes('..') || result.includes('\\') || URL_TEXT.test(result)) {
    throw failure(`${label} must be an internal evidence reference.`, 400, 'VALIDATION');
  }
  return result;
}

function validDate(value, label) {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw failure(`${label} is invalid.`, 400, 'VALIDATION');
  return result;
}

function challenge(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(`${label} is required.`, 400, 'VALIDATION');
  }
  return {
    tokenHash: digest(value.tokenHash, `${label}.tokenHash`),
    subjectEmail: exactText(value.subjectEmail, `${label}.subjectEmail`, 320).toLowerCase(),
    expiresAt: validDate(value.expiresAt, `${label}.expiresAt`),
  };
}

function bindingDigestFields(providerBinding) {
  if (!providerBinding || typeof providerBinding !== 'object' || Array.isArray(providerBinding)) {
    throw failure('providerBinding is required.', 400, 'VALIDATION');
  }
  return {
    bindingId: exactText(providerBinding.bindingId, 'providerBinding.bindingId', 255),
    originScopeKey: digest(providerBinding.originScopeKey, 'providerBinding.originScopeKey'),
    verifiedAccountScopeId: exactText(providerBinding.verifiedAccountScopeId, 'providerBinding.verifiedAccountScopeId', 255),
  };
}

function subjectNoticeChallengeType(identityId) {
  return `provider_subject_consent_notice:${exactText(identityId, 'identityId', 255)}`;
}

export function providerSubjectConsentActivationStatus(env = process.env) {
  const enabled = String(env.VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED || '').trim().toLowerCase() === 'true';
  return Object.freeze({
    enabled,
    reason: enabled ? 'owner_authorized_hosted_subject_consent' : 'hosted_subject_consent_disabled',
  });
}

export function hostedAvatarConsentRequestDigest(input) {
  return providerOperationRequestDigest({
    version: 'hosted-avatar-consent-request/v1',
    transport: 'LEVEL1_HOSTED',
    accountId: exactText(input?.accountId, 'accountId'),
    identityId: exactText(input?.identityId, 'identityId', 255),
    identityConsentId: exactText(input?.identityConsentId, 'identityConsentId', 255),
    policyVersion: exactText(input?.policyVersion, 'policyVersion', 255),
    providerGroupId: providerId(input?.providerGroupId, 'providerGroupId'),
    providerBinding: bindingDigestFields(input?.providerBinding),
    idempotencyKey: exactText(input?.idempotencyKey, 'idempotencyKey', 255),
    rerouteUrlDigest: digest(input?.rerouteUrlDigest, 'rerouteUrlDigest'),
  });
}

export async function issueHostedSubjectNoticeChallengeTx(tx, input) {
  const accountId = exactText(input.accountId, 'accountId');
  const identityId = exactText(input.identityId, 'identityId', 255);
  const tokenHash = digest(input.tokenHash, 'tokenHash');
  const subjectEmail = exactText(input.subjectEmail, 'subjectEmail', 320).toLowerCase();
  const expiresAt = validDate(input.expiresAt, 'expiresAt');
  const now = validDate(input.now || new Date(), 'now');
  if (expiresAt <= now) throw failure('Subject notice challenge is already expired.', 400, 'VALIDATION');
  const [identity] = await tx.select({ id: userIdentities.id }).from(userIdentities).where(and(
    eq(userIdentities.id, identityId),
    eq(userIdentities.accountId, accountId),
    isNull(userIdentities.archivedAt),
  )).for('share').limit(1);
  if (!identity) throw failure('Identity was not found for subject notice.', 404, 'OWNERSHIP');
  const [created] = await tx.insert(authChallenges).values({
    accountId,
    email: subjectEmail,
    tokenHash,
    challengeType: subjectNoticeChallengeType(identityId),
    expiresAt,
    usedAt: null,
    createdAt: now,
  }).returning();
  return Object.freeze({ challengeId: created.id, expiresAt: expiresAt.toISOString() });
}

export async function acceptHostedSubjectConsentNoticeTx(tx, input) {
  const accountId = exactText(input.accountId, 'accountId');
  const identityId = exactText(input.identityId, 'identityId', 255);
  const policyVersion = exactText(input.policyVersion, 'policyVersion', 255);
  if (policyVersion !== HOSTED_SUBJECT_CONSENT_POLICY_VERSION) {
    throw failure('Hosted subject notice policy version is not supported.', 409, 'SUBJECT_CONSENT_POLICY_REQUIRED');
  }
  const tokenHash = digest(input.noticeTokenHash, 'noticeTokenHash');
  const now = validDate(input.now || new Date(), 'now');
  const [notice] = await tx.select().from(authChallenges).where(and(
    eq(authChallenges.accountId, accountId),
    eq(authChallenges.tokenHash, tokenHash),
    eq(authChallenges.challengeType, subjectNoticeChallengeType(identityId)),
  )).for('update').limit(1);
  if (!notice) throw failure('Subject notice challenge is invalid.', 404, 'SUBJECT_CONSENT_CHALLENGE_INVALID');

  const [replay] = await tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.idempotencyKey, notice.id),
  )).limit(1);
  if (replay) {
    const exact = replay.identityId === identityId
      && replay.policyVersion === HOSTED_SUBJECT_CONSENT_POLICY_VERSION
      && replay.consentPurpose === 'hosted-avatar-consent'
      && replay.faceAuthorization === true
      && replay.voiceAuthorization === false
      && replay.providerProcessingAuthorization === true
      && replay.archiveDeleteAcknowledgment === true
      && replay.audioExtractionAuthorization === false
      && replay.temporaryPublicProviderExposureAuthorization === false;
    if (!exact) throw failure('Subject notice replay conflicts with its consent receipt.', 409, 'PROVIDER_OPERATION_CONFLICT');
    return Object.freeze({ consent: replay, replayed: true });
  }
  if (notice.usedAt || notice.expiresAt <= now) {
    throw failure('Subject notice challenge is used or expired.', 410, 'SUBJECT_CONSENT_CHALLENGE_EXPIRED');
  }
  const source = await resolveHostedSubjectSourceConsentTx(tx, { accountId, identityId });
  if (!source) throw failure('Active source consent was not found.', 409, 'SUBJECT_CONSENT_REQUIRED');
  const [activeV3] = await tx.select({ id: identityConsents.id }).from(identityConsents).where(and(
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.identityId, identityId),
    eq(identityConsents.policyVersion, HOSTED_SUBJECT_CONSENT_POLICY_VERSION),
    isNull(identityConsents.revokedAt),
  )).for('share').limit(1);
  if (activeV3) throw failure('An active hosted subject consent receipt already exists.', 409, 'SUBJECT_CONSENT_ALREADY_ACTIVE');

  const [consumed] = await tx.update(authChallenges).set({ usedAt: now }).where(and(
    eq(authChallenges.id, notice.id),
    isNull(authChallenges.usedAt),
  )).returning();
  if (!consumed) throw failure('Subject notice challenge was already consumed.', 409, 'SUBJECT_CONSENT_CHALLENGE_REPLAYED');
  const [consent] = await tx.insert(identityConsents).values({
    accountId,
    identityId,
    idempotencyKey: notice.id,
    audioExtractionAuthorization: false,
    faceAuthorization: true,
    voiceAuthorization: false,
    providerProcessingAuthorization: true,
    archiveDeleteAcknowledgment: true,
    temporaryPublicProviderExposureAuthorization: false,
    policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
    consentPurpose: 'hosted-avatar-consent',
    photoSha256: source.photoSha256,
    sourceVideoSha256: source.sourceVideoSha256,
    voiceSha256: source.voiceSha256,
    acceptedAt: now,
    revokedAt: null,
  }).returning();
  return Object.freeze({ consent, replayed: false });
}

export async function resolveHostedSubjectSourceConsentTx(tx, input) {
  const accountId = exactText(input.accountId, 'accountId');
  const identityId = exactText(input.identityId, 'identityId', 255);
  let query = tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.identityId, identityId),
    eq(identityConsents.policyVersion, 'identity-provider-bridge-v2'),
    isNull(identityConsents.revokedAt),
  )).orderBy(desc(identityConsents.acceptedAt));
  if (input.lock !== false) query = query.for('share');
  const [source] = await query.limit(1);
  return source || null;
}

export function classifyHostedAvatarConsentReplay({ existing, unresolved = [], expected }) {
  if (existing) {
    const exact = existing.kind === CONSENT_KIND
      && existing.applicationAccountId === expected.accountId
      && existing.identityId === expected.identityId
      && existing.originOperationKey === expected.idempotencyKey
      && existing.requestDigest === expected.requestDigest;
    if (!exact) {
      throw failure('Hosted consent replay conflicts with its immutable request.', 409, 'PROVIDER_OPERATION_CONFLICT');
    }
    return Object.freeze({ replayed: true, shouldSubmit: false });
  }
  if (unresolved.some(item => item.kind === CONSENT_KIND && ['pending', 'ambiguous', 'reserved'].includes(item.state))) {
    throw failure('Hosted consent requires reconciliation before another provider attempt.', 409, 'PROVIDER_CONSENT_RECONCILIATION_REQUIRED');
  }
  return Object.freeze({ replayed: false, shouldSubmit: true });
}

function assertNoUrlText(value) {
  if (URL_TEXT.test(JSON.stringify(value || {}))) {
    throw failure('Raw provider consent URLs cannot be stored in the lifecycle ledger.', 400, 'PROVIDER_CONSENT_EVIDENCE_INVALID');
  }
}

function latestEvent(events, eventType) {
  return [...events]
    .filter(item => item.eventType === eventType)
    .sort((left, right) => validDate(right.observedAt, 'event.observedAt') - validDate(left.observedAt, 'event.observedAt'))[0] || null;
}

function iso(value) {
  return value == null ? null : validDate(value, 'timestamp').toISOString();
}

export function buildHostedAvatarConsentProjection({ operation, events = [], authorization, now = new Date() }) {
  if (!operation || operation.kind && operation.kind !== CONSENT_KIND) {
    throw failure('Hosted consent operation is invalid.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  for (const event of events) assertNoUrlText(event.details);
  const issued = latestEvent(events, 'provider.avatar_consent_session_issued');
  const returned = latestEvent(events, 'provider.avatar_consent_returned');
  const abandoned = latestEvent(events, 'provider.avatar_consent_abandoned');
  const readback = latestEvent(events, 'provider.avatar_consent_readback');
  const providerExpiry = issued?.details?.providerUrlExpiresAt == null
    ? null
    : validDate(issued.details.providerUrlExpiresAt, 'providerUrlExpiresAt');
  let hostedSessionState = issued ? 'ISSUED' : null;
  if (providerExpiry && providerExpiry <= validDate(now, 'now')) hostedSessionState = 'EXPIRED';
  if (returned) hostedSessionState = 'RETURNED';
  if (abandoned && (!returned || validDate(abandoned.observedAt, 'abandoned.observedAt') > validDate(returned.observedAt, 'returned.observedAt'))) {
    hostedSessionState = 'ABANDONED';
  }
  const attemptState = {
    reserved: 'RESERVED',
    pending: 'SUBMITTED',
    ambiguous: 'AMBIGUOUS',
    succeeded: 'TERMINAL',
    failed: 'TERMINAL',
  }[operation.state] || 'AMBIGUOUS';
  const providerConsentStatus = PROVIDER_CONSENT_STATUSES.has(readback?.details?.providerConsentStatus)
    ? readback.details.providerConsentStatus
    : 'UNKNOWN';
  const terminalOutcome = operation.state === 'succeeded'
    ? 'SUCCEEDED'
    : operation.state === 'failed'
      ? providerConsentStatus === 'REJECTED' ? 'REJECTED' : 'FAILED'
      : readback?.details?.terminalOutcome || null;
  return Object.freeze({
    attemptId: operation.id,
    attemptState,
    terminalOutcome,
    hostedSessionState,
    providerConsentStatus,
    luxAuthorizationStatus: authorization?.active === true && !authorization?.withdrawnAt ? 'ACTIVE' : 'WITHDRAWN',
    createdAt: iso(operation.createdAt),
    updatedAt: iso(operation.updatedAt),
  });
}

async function activeConsentTx(tx, { accountId, identityId, identityConsentId, policyVersion, lock = true }) {
  if (policyVersion !== HOSTED_SUBJECT_CONSENT_POLICY_VERSION) {
    throw failure('Dedicated subject notice acceptance is required for hosted consent.', 409, 'SUBJECT_CONSENT_POLICY_REQUIRED');
  }
  let query = tx.select().from(identityConsents).where(and(
    eq(identityConsents.id, identityConsentId),
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.identityId, identityId),
    eq(identityConsents.policyVersion, policyVersion),
    isNull(identityConsents.revokedAt),
  ));
  if (lock) query = query.for('share');
  const [consent] = await query.limit(1);
  if (!consent || consent.faceAuthorization !== true || consent.voiceAuthorization !== false
    || consent.providerProcessingAuthorization !== true || consent.archiveDeleteAcknowledgment !== true
    || consent.audioExtractionAuthorization !== false
    || consent.temporaryPublicProviderExposureAuthorization !== false
    || consent.consentPurpose !== 'hosted-avatar-consent' || !consent.idempotencyKey) {
    throw failure('Active subject authorization is required.', 409, 'SUBJECT_CONSENT_REQUIRED');
  }
  const [notice] = await tx.select().from(authChallenges).where(and(
    eq(authChallenges.id, consent.idempotencyKey),
    eq(authChallenges.accountId, accountId),
    eq(authChallenges.challengeType, subjectNoticeChallengeType(identityId)),
    isNotNull(authChallenges.usedAt),
  )).limit(1);
  if (!notice || validDate(notice.usedAt, 'notice.usedAt') > validDate(consent.acceptedAt, 'consent.acceptedAt')) {
    throw failure('Subject notice acceptance evidence is missing or inconsistent.', 409, 'SUBJECT_CONSENT_REQUIRED');
  }
  return consent;
}

async function exactGroupTx(tx, { accountId, providerBinding, providerGroupId, lock = true }) {
  const binding = bindingDigestFields(providerBinding);
  let query = tx.select().from(providerResources).where(and(
    eq(providerResources.applicationAccountId, accountId),
    eq(providerResources.bindingId, binding.bindingId),
    eq(providerResources.originScopeKey, binding.originScopeKey),
    eq(providerResources.verifiedAccountScopeId, binding.verifiedAccountScopeId),
    eq(providerResources.kind, 'avatar_group'),
    eq(providerResources.providerResourceId, providerGroupId),
  ));
  if (lock) query = query.for('share');
  const groups = await query.limit(2);
  if (groups.length !== 1) {
    throw failure('Provider avatar group is missing, ambiguous, or belongs to another provider space.', 409, 'PROVIDER_RESOURCE_UNVERIFIED');
  }
  return groups[0];
}

async function operationEventsTx(tx, operationId) {
  return tx.select().from(providerLifecycleEvents)
    .where(eq(providerLifecycleEvents.operationId, operationId))
    .orderBy(desc(providerLifecycleEvents.observedAt));
}

async function operationProjectionTx(tx, operation, { identityConsentId, policyVersion, now = new Date() } = {}) {
  const events = await operationEventsTx(tx, operation.id);
  const authorityEvent = latestEvent(events, 'provider.avatar_consent_authority_bound');
  const consentId = identityConsentId || authorityEvent?.details?.identityConsentId;
  const version = policyVersion || authorityEvent?.details?.policyVersion;
  let consent = null;
  if (consentId && version) {
    [consent] = await tx.select().from(identityConsents).where(and(
      eq(identityConsents.id, consentId),
      eq(identityConsents.accountId, operation.applicationAccountId),
      eq(identityConsents.identityId, operation.identityId),
      eq(identityConsents.policyVersion, version),
    )).limit(1);
  }
  return buildHostedAvatarConsentProjection({
    operation,
    events,
    authorization: { active: Boolean(consent && !consent.revokedAt), withdrawnAt: consent?.revokedAt || null },
    now,
  });
}

export async function reserveHostedAvatarConsentAttemptTx(tx, input) {
  const accountId = exactText(input.accountId, 'accountId');
  const identityId = exactText(input.identityId, 'identityId', 255);
  const identityConsentId = exactText(input.identityConsentId, 'identityConsentId', 255);
  const policyVersion = exactText(input.policyVersion, 'policyVersion', 255);
  const providerGroupId = providerId(input.providerGroupId, 'providerGroupId');
  const idempotencyKey = exactText(input.idempotencyKey, 'idempotencyKey', 255);
  const correlationId = exactText(input.correlationId, 'correlationId', 512);
  const returnState = challenge(input.returnChallenge, 'returnChallenge');
  const now = validDate(input.now || new Date(), 'now');
  if (returnState.expiresAt <= now) throw failure('Return challenge is already expired.', 400, 'VALIDATION');
  const requestDigest = hostedAvatarConsentRequestDigest({ ...input, accountId, identityId, identityConsentId, policyVersion, providerGroupId, idempotencyKey });
  const binding = bindingDigestFields(input.providerBinding);
  const providerOperation = {
    accountId,
    providerBinding: input.providerBinding,
    kind: CONSENT_KIND,
    originOperationKey: idempotencyKey,
    attempt: 1,
    correlationId,
    identityId,
    requestDigest,
  };

  const [existing] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.originScopeKey, binding.originScopeKey),
    eq(providerLifecycleOperations.kind, CONSENT_KIND),
    eq(providerLifecycleOperations.originOperationKey, idempotencyKey),
    eq(providerLifecycleOperations.attempt, 1),
  )).for('update').limit(1);
  if (existing) {
    const decision = classifyHostedAvatarConsentReplay({
      existing,
      expected: { accountId, identityId, idempotencyKey, requestDigest },
    });
    const ledger = await reserveProviderOperationTx(tx, providerOperation);
    return {
      attempt: await operationProjectionTx(tx, ledger.operation, { identityConsentId, policyVersion, now }),
      operation: ledger.operation,
      ...decision,
    };
  }

  const unresolved = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.bindingId, binding.bindingId),
    eq(providerLifecycleOperations.originScopeKey, binding.originScopeKey),
    eq(providerLifecycleOperations.identityId, identityId),
    eq(providerLifecycleOperations.kind, CONSENT_KIND),
    inArray(providerLifecycleOperations.state, ['reserved', 'pending', 'ambiguous']),
  )).for('update');
  classifyHostedAvatarConsentReplay({
    existing: null,
    unresolved,
    expected: { accountId, identityId, idempotencyKey, requestDigest },
  });

  await activeConsentTx(tx, { accountId, identityId, identityConsentId, policyVersion });
  const group = await exactGroupTx(tx, { accountId, providerBinding: input.providerBinding, providerGroupId });
  const ledger = await reserveProviderOperationTx(tx, providerOperation);
  const [returnChallenge] = await tx.insert(authChallenges).values({
    accountId,
    email: returnState.subjectEmail,
    tokenHash: returnState.tokenHash,
    challengeType: RETURN_CHALLENGE,
    expiresAt: returnState.expiresAt,
    usedAt: null,
    createdAt: now,
  }).returning();
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: ledger.operation.originScopeKey,
    operationId: ledger.operation.id,
    resourceId: group.id,
    eventType: 'provider.avatar_consent_authority_bound',
    correlationId,
    method: 'POST',
    pathTemplate: '/v2/avatar_group/create_consent',
    observedResourceKind: 'avatar_group',
    observedProviderResourceId: providerGroupId,
    details: {
      transport: 'LEVEL1_HOSTED',
      identityConsentId,
      policyVersion,
      returnChallengeId: returnChallenge.id,
      rerouteUrlDigest: digest(input.rerouteUrlDigest, 'rerouteUrlDigest'),
    },
    observedAt: now,
  });
  return {
    attempt: await operationProjectionTx(tx, ledger.operation, { identityConsentId, policyVersion, now }),
    operation: ledger.operation,
    replayed: false,
    shouldSubmit: true,
  };
}

export async function recordHostedAvatarConsentIssuedTx(tx, input) {
  const now = validDate(input.now || new Date(), 'now');
  const providerUrlExpiresAt = validDate(input.providerUrlExpiresAt, 'providerUrlExpiresAt');
  if (providerUrlExpiresAt <= now) throw failure('Provider consent session is already expired.', 400, 'VALIDATION');
  const providerUrlDigest = digest(input.providerUrlDigest, 'providerUrlDigest');
  const privateUrlEvidenceRef = internalEvidenceRef(input.privateUrlEvidenceRef, 'privateUrlEvidenceRef');
  if (!privateUrlEvidenceRef.startsWith('video-os/auth/')) {
    throw failure('Provider consent URL must use authentication-state private storage.', 400, 'PROVIDER_CONSENT_EVIDENCE_INVALID');
  }
  const launchState = challenge(input.launchChallenge, 'launchChallenge');
  if (launchState.expiresAt > providerUrlExpiresAt) {
    throw failure('Launch challenge cannot outlive the provider consent URL.', 400, 'VALIDATION');
  }
  const operation = await assertProviderReceiptOperationTx(tx, input);
  if (operation.kind !== CONSENT_KIND || operation.state !== 'pending') {
    throw failure('Hosted consent operation cannot accept a session receipt.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  const events = await operationEventsTx(tx, operation.id);
  const issued = latestEvent(events, 'provider.avatar_consent_session_issued');
  if (issued && (issued.evidenceDigest !== providerUrlDigest
    || issued.privateEvidenceRef !== privateUrlEvidenceRef
    || iso(issued.details?.providerUrlExpiresAt) !== providerUrlExpiresAt.toISOString())) {
    throw failure('Hosted consent session receipt conflicts with the immutable provider URL evidence.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  const authority = latestEvent(events, 'provider.avatar_consent_authority_bound');
  const [returnState] = authority?.details?.returnChallengeId
    ? await tx.select().from(authChallenges).where(eq(authChallenges.id, authority.details.returnChallengeId)).limit(1)
    : [];
  if (!returnState || returnState.expiresAt > providerUrlExpiresAt) {
    throw failure('Return challenge cannot outlive the provider consent URL.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  const [launchChallenge] = await tx.insert(authChallenges).values({
    accountId: operation.applicationAccountId,
    email: launchState.subjectEmail,
    tokenHash: launchState.tokenHash,
    challengeType: LAUNCH_CHALLENGE,
    expiresAt: launchState.expiresAt,
    usedAt: null,
    createdAt: now,
  }).returning();
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: operation.applicationAccountId,
    originScopeKey: operation.originScopeKey,
    operationId: operation.id,
    eventType: issued ? 'provider.avatar_consent_session_reissued' : 'provider.avatar_consent_session_issued',
    correlationId: operation.correlationId,
    method: 'POST',
    pathTemplate: '/v2/avatar_group/create_consent',
    evidenceDigest: providerUrlDigest,
    privateEvidenceRef: privateUrlEvidenceRef,
    details: {
      hostedSessionState: 'ISSUED',
      launchChallengeId: launchChallenge.id,
      providerUrlExpiresAt: providerUrlExpiresAt.toISOString(),
    },
    observedAt: now,
  });
  return operationProjectionTx(tx, operation, { now });
}

async function consumeChallengeTx(tx, { accountId, operationId, tokenHash, challengeType, eventType, now }) {
  const [operation] = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.id, operationId),
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.kind, CONSENT_KIND),
  )).for('share').limit(1);
  if (!operation) throw failure('Hosted consent attempt was not found.', 404, 'OWNERSHIP');
  const [state] = await tx.select().from(authChallenges).where(and(
    eq(authChallenges.accountId, accountId),
    eq(authChallenges.tokenHash, digest(tokenHash, 'tokenHash')),
    eq(authChallenges.challengeType, challengeType),
    isNull(authChallenges.usedAt),
  )).for('update').limit(1);
  if (!state || state.expiresAt <= now) throw failure('Hosted consent state is invalid or expired.', 410, 'PROVIDER_CONSENT_STATE_EXPIRED');
  const events = await operationEventsTx(tx, operation.id);
  const linked = events.find(event => event.details?.[challengeType === LAUNCH_CHALLENGE ? 'launchChallengeId' : 'returnChallengeId'] === state.id);
  if (!linked) throw failure('Hosted consent state does not belong to this attempt.', 409, 'PROVIDER_OPERATION_CONFLICT');
  const [consumed] = await tx.update(authChallenges).set({ usedAt: now }).where(and(
    eq(authChallenges.id, state.id),
    isNull(authChallenges.usedAt),
  )).returning();
  if (!consumed) throw failure('Hosted consent state was already consumed.', 409, 'PROVIDER_CONSENT_STATE_REPLAYED');
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: accountId,
    originScopeKey: operation.originScopeKey,
    operationId: operation.id,
    eventType,
    correlationId: operation.correlationId,
    details: { hostedSessionState: eventType.endsWith('_returned') ? 'RETURNED' : 'ISSUED', challengeId: state.id },
    observedAt: now,
  });
  return { operation, linked };
}

export async function consumeHostedAvatarConsentLaunchTx(tx, input) {
  const now = validDate(input.now || new Date(), 'now');
  const { operation, linked } = await consumeChallengeTx(tx, {
    accountId: exactText(input.accountId, 'accountId'),
    operationId: exactText(input.operationId, 'operationId', 255),
    tokenHash: input.launchTokenHash,
    challengeType: LAUNCH_CHALLENGE,
    eventType: 'provider.avatar_consent_launch_consumed',
    now,
  });
  if (!linked.privateEvidenceRef || !linked.evidenceDigest) {
    throw failure('Hosted consent URL evidence is unavailable.', 503, 'PROVIDER_CONSENT_EVIDENCE_UNAVAILABLE');
  }
  return Object.freeze({
    attemptId: operation.id,
    privateUrlEvidenceRef: linked.privateEvidenceRef,
    providerUrlDigest: linked.evidenceDigest,
    expiresAt: iso(linked.details?.providerUrlExpiresAt),
  });
}

export async function recordHostedAvatarConsentReturnTx(tx, input) {
  const now = validDate(input.now || new Date(), 'now');
  const operation = await assertProviderReceiptOperationTx(tx, input);
  if (operation.kind !== CONSENT_KIND) throw failure('Hosted consent operation is invalid.', 409, 'PROVIDER_OPERATION_CONFLICT');
  await consumeChallengeTx(tx, {
    accountId: exactText(input.accountId, 'accountId'),
    operationId: operation.id,
    tokenHash: input.returnTokenHash,
    challengeType: RETURN_CHALLENGE,
    eventType: 'provider.avatar_consent_returned',
    now,
  });
  return operationProjectionTx(tx, operation, { now });
}

export async function recordHostedAvatarConsentSubmissionUnknownTx(tx, input) {
  const now = validDate(input.now || new Date(), 'now');
  const operation = await assertProviderReceiptOperationTx(tx, input);
  if (operation.kind !== CONSENT_KIND) throw failure('Hosted consent operation is invalid.', 409, 'PROVIDER_OPERATION_CONFLICT');
  const updated = await recordProviderOperationFailureTx(tx, {
    accountId: input.accountId,
    operationId: operation.id,
    ambiguous: true,
    code: input.code || 'PROVIDER_RESULT_UNKNOWN',
    now,
  });
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: operation.applicationAccountId,
    originScopeKey: operation.originScopeKey,
    operationId: operation.id,
    eventType: 'provider.avatar_consent_submit_unknown',
    correlationId: operation.correlationId,
    providerCode: String(input.code || 'PROVIDER_RESULT_UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80),
    details: {},
    observedAt: now,
  });
  return operationProjectionTx(tx, updated, { now });
}

export async function recordHostedAvatarConsentReadbackTx(tx, input) {
  const now = validDate(input.observedAt || new Date(), 'observedAt');
  const status = exactText(input.providerConsentStatus, 'providerConsentStatus', 40).toUpperCase();
  if (!PROVIDER_CONSENT_STATUSES.has(status)) throw failure('Provider consent status is invalid.', 400, 'VALIDATION');
  const providerGroupId = providerId(input.providerGroupId, 'providerGroupId');
  let operation = await assertProviderReceiptOperationTx(tx, input);
  if (operation.kind !== CONSENT_KIND) throw failure('Hosted consent operation is invalid.', 409, 'PROVIDER_OPERATION_CONFLICT');
  const group = await exactGroupTx(tx, {
    accountId: input.accountId,
    providerBinding: input.providerBinding,
    providerGroupId,
  });
  const events = await operationEventsTx(tx, operation.id);
  const authority = latestEvent(events, 'provider.avatar_consent_authority_bound');
  if (!authority || authority.resourceId !== group.id || authority.observedProviderResourceId !== providerGroupId) {
    throw failure('Provider consent readback does not match the bound avatar group.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  const evidenceDigest = input.evidenceDigest == null ? null : digest(input.evidenceDigest, 'evidenceDigest');
  const privateEvidenceRef = input.privateEvidenceRef == null ? null : internalEvidenceRef(input.privateEvidenceRef, 'privateEvidenceRef');
  await tx.insert(providerLifecycleEvents).values({
    applicationAccountId: operation.applicationAccountId,
    originScopeKey: operation.originScopeKey,
    operationId: operation.id,
    resourceId: group.id,
    eventType: 'provider.avatar_consent_readback',
    correlationId: operation.correlationId,
    method: 'GET',
    pathTemplate: '/v2/avatar_group/:group_id',
    observedResourceKind: 'avatar_group',
    observedProviderResourceId: providerGroupId,
    evidenceDigest,
    privateEvidenceRef,
    details: { providerConsentStatus: status },
    observedAt: now,
  });
  if (operation.state === 'pending' && status !== 'PENDING') {
    const state = status === 'ACCEPTED' ? 'succeeded' : 'failed';
    [operation] = await tx.update(providerLifecycleOperations).set({ state, completedAt: now, updatedAt: now })
      .where(and(eq(providerLifecycleOperations.id, operation.id), eq(providerLifecycleOperations.state, 'pending'))).returning();
    if (!operation) throw failure('Hosted consent terminal readback lost its lifecycle claim.', 409, 'PROVIDER_OPERATION_CONFLICT');
  }
  return operationProjectionTx(tx, operation, { now });
}

export async function getHostedAvatarConsentStatusTx(tx, input) {
  const accountId = exactText(input.accountId, 'accountId');
  const identityId = exactText(input.identityId, 'identityId', 255);
  const providerGroupId = providerId(input.providerGroupId, 'providerGroupId');
  const binding = bindingDigestFields(input.providerBinding);
  await exactGroupTx(tx, { accountId, providerBinding: input.providerBinding, providerGroupId, lock: false });
  const operations = await tx.select().from(providerLifecycleOperations).where(and(
    eq(providerLifecycleOperations.applicationAccountId, accountId),
    eq(providerLifecycleOperations.bindingId, binding.bindingId),
    eq(providerLifecycleOperations.originScopeKey, binding.originScopeKey),
    eq(providerLifecycleOperations.identityId, identityId),
    eq(providerLifecycleOperations.kind, CONSENT_KIND),
  )).orderBy(desc(providerLifecycleOperations.createdAt)).limit(20);
  for (const operation of operations) {
    const events = await operationEventsTx(tx, operation.id);
    const authority = latestEvent(events, 'provider.avatar_consent_authority_bound');
    if (authority?.observedProviderResourceId === providerGroupId) {
      await assertProviderReceiptOperationTx(tx, { accountId, providerBinding: input.providerBinding, operationId: operation.id });
      return operationProjectionTx(tx, operation, { now: input.now });
    }
  }
  return null;
}
