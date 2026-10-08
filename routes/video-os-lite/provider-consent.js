import crypto from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { database } from '../../db/client.js';
import {
  resolveFreshHeygenSpaceBinding,
  assertFreshHeygenSpaceBinding,
  withFreshHeygenSpaceBindingTransaction,
  withHeygenSpaceBindingReceiptTransaction,
} from '../../db/heygen-space-binding-repository.js';
import {
  HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
  acceptHostedSubjectConsentNoticeTx,
  consumeHostedAvatarConsentLaunchTx,
  getHostedAvatarConsentStatusTx,
  issueHostedSubjectNoticeChallengeTx,
  recordHostedAvatarConsentIssuedTx,
  recordHostedAvatarConsentReadbackTx,
  recordHostedAvatarConsentReturnTx,
  recordHostedAvatarConsentSubmissionUnknownTx,
  reserveHostedAvatarConsentAttemptTx,
  providerSubjectConsentActivationStatus,
} from '../../db/provider-subject-consent-repository.js';
import { identityConsents, providerLifecycleEvents, providerLifecycleOperations } from '../../db/schema.js';
import { consumeRateLimit, getOwnedIdentity } from '../../db/repositories.js';
import { handleOptions, readJson, send, sessionFromRequest } from '../../lib/video-os-account.js';
import { assertProviderConsentInvitationEmailConfigured, sendProviderConsentInvitationEmail } from '../../lib/video-os-notifications.js';
import { saveProviderConsentUrl, readProviderConsentUrl } from '../../lib/provider-consent-url-store.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../../lib/video-os-private-blob.js';
import {
  issueProviderSubjectInvitation,
  verifyProviderSubjectInvitation,
} from '../../lib/provider-subject-invitation.js';
import { createHeygenHostedConsent, getHeygenPhotoAvatarStatus } from '../../services/heygen.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_TTL_MS = 15 * 60 * 1000;
const PROVIDER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-f0-9]{64})$/i;

function routeError(code, message, statusCode = 400, failureCategory = 'VALIDATION') {
  return Object.assign(new Error(message), { code, statusCode, failureCategory });
}

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function deterministicReturnState({ invitationTokenHash, accountId, identityId, idempotencyKey }, env) {
  const key = String(env.VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET || '').trim();
  if (Buffer.byteLength(key) < 32) throw routeError('subject_invitation_authority_unconfigured', 'Hosted consent invitation authority is not configured.', 503, 'CONFIG_MISSING');
  return crypto.createHmac('sha256', key)
    .update('video-os/hosted-consent-return/v1\0')
    .update(invitationTokenHash).update('\0')
    .update(accountId).update('\0')
    .update(identityId).update('\0')
    .update(idempotencyKey)
    .digest('base64url');
}
function returnLocator(accountId, idempotencyKey, env) {
  const key = String(env.VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET || '').trim();
  if (Buffer.byteLength(key) < 32) throw routeError('subject_invitation_authority_unconfigured', 'Hosted consent invitation authority is not configured.', 503, 'CONFIG_MISSING');
  return crypto.createHmac('sha256', key).update('video-os/hosted-consent-return-locator/v1\0').update(accountId).update('\0').update(idempotencyKey).digest('base64url');
}
function normalizedEmail(value) { return String(value || '').trim().toLowerCase(); }
function publicOrigin(env) {
  let value;
  try { value = new URL(String(env.VIDEO_OS_PUBLIC_ORIGIN || '')); } catch { throw routeError('public_origin_unconfigured', 'Hosted consent public origin is not configured.', 503, 'CONFIG_MISSING'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.port || value.pathname !== '/' || value.search || value.hash) {
    throw routeError('public_origin_unconfigured', 'Hosted consent public origin is not configured.', 503, 'CONFIG_MISSING');
  }
  return value.origin;
}

function assertEnabled(env) {
  const status = providerSubjectConsentActivationStatus(env);
  if (!status.enabled) throw routeError(status.reason, 'Hosted subject consent is disabled.', 503, 'PROVIDER_SUBJECT_CONSENT_DISABLED');
  return status;
}

function assertJsonTransport(req, env) {
  if (!env.VIDEO_OS_PUBLIC_ORIGIN || req.headers?.origin !== env.VIDEO_OS_PUBLIC_ORIGIN
    || !['same-origin', 'none', undefined].includes(req.headers?.['sec-fetch-site'])) {
    throw routeError('origin_not_allowed', 'Origin not allowed.', 403);
  }
  if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw routeError('json_required', 'JSON required.', 400);
  }
}

async function body(req) {
  try { return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? await readJson(req)); }
  catch { throw routeError('invalid_request', 'Invalid JSON request.'); }
}

function requireIdentityId(value) {
  if (!UUID.test(String(value || ''))) throw routeError('invalid_request', 'Identity is invalid.');
  return String(value);
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end();
}

async function exactIdentity(accountId, identityId, lookup) {
  const identity = await lookup(accountId, requireIdentityId(identityId));
  if (!identity || identity.archivedAt || !identity.providerAvatarGroupId || !identity.providerRenderableAvatarId) {
    throw routeError('identity_not_found', 'Consent-ready identity was not found.', 404, 'OWNERSHIP');
  }
  return identity;
}

async function activeSubjectConsent(tx, accountId, identityId) {
  const [consent] = await tx.select().from(identityConsents).where(and(
    eq(identityConsents.accountId, accountId),
    eq(identityConsents.identityId, identityId),
    eq(identityConsents.policyVersion, HOSTED_SUBJECT_CONSENT_POLICY_VERSION),
    isNull(identityConsents.revokedAt),
  )).orderBy(desc(identityConsents.acceptedAt)).limit(1);
  if (!consent) throw routeError('subject_consent_required', 'Subject notice acceptance is required.', 409, 'SUBJECT_CONSENT_REQUIRED');
  return consent;
}

async function recoverIssuedEvidence(tx, operationId, currentTime = Date.now()) {
  const [event] = await tx.select().from(providerLifecycleEvents).where(and(
    eq(providerLifecycleEvents.operationId, operationId),
    inArray(providerLifecycleEvents.eventType, ['provider.avatar_consent_session_issued', 'provider.avatar_consent_session_reissued']),
  )).orderBy(desc(providerLifecycleEvents.observedAt)).limit(1);
  const expiresAt = event?.details?.providerUrlExpiresAt;
  if (!event?.privateEvidenceRef || !event?.evidenceDigest || !expiresAt || Date.parse(expiresAt) <= currentTime) {
    throw routeError('provider_consent_reconciliation_required', 'Hosted consent submission requires reconciliation before it can be retried.', 409, 'PROVIDER_CONSENT_RECONCILIATION_REQUIRED');
  }
  return { privateUrlEvidenceRef: event.privateEvidenceRef, providerUrlDigest: event.evidenceDigest, providerUrlExpiresAt: new Date(expiresAt) };
}

export async function persistProviderReadbackEvidence({ accountId, identity, providerBinding, observed, observedAt }, { put = putPrivateBlob } = {}) {
  const group = observed?.avatarGroup;
  const look = observed?.avatarLook;
  if (group?.providerGroupId !== identity.providerAvatarGroupId
    || look?.providerGroupId !== identity.providerAvatarGroupId
    || look?.providerLookId !== identity.providerRenderableAvatarId) {
    throw routeError('provider_readback_mismatch', 'Provider consent status could not be verified.', 502, 'PROVIDER_POLL');
  }
  const providerConsentStatus = group.consentStatus;
  if (!['pending', 'accepted', 'rejected'].includes(providerConsentStatus)) {
    throw routeError('provider_readback_invalid', 'Provider consent status could not be verified.', 502, 'PROVIDER_POLL');
  }
  if (!['processing', 'completed', 'failed'].includes(group.status)
    || !['processing', 'completed', 'failed'].includes(look.status)) {
    throw routeError('provider_readback_invalid', 'Provider processing status could not be verified.', 502, 'PROVIDER_POLL');
  }
  const bindingDigest = sha(JSON.stringify({
    bindingId: providerBinding.bindingId,
    originScopeKey: providerBinding.originScopeKey,
    verifiedAccountScopeId: providerBinding.verifiedAccountScopeId,
  }));
  const receipt = JSON.stringify({
    version: 1,
    accountIdDigest: sha(accountId),
    identityId: identity.id,
    providerGroupId: group.providerGroupId,
    providerLookId: look.providerLookId,
    avatarType: look.avatarType || 'unknown',
    providerGroupStatus: group.status.toUpperCase(),
    providerLookStatus: look.status.toUpperCase(),
    providerConsentStatus: providerConsentStatus.toUpperCase(),
    bindingDigest,
    observedAt: new Date(observedAt).toISOString(),
  });
  const evidenceDigest = sha(receipt);
  const privateEvidenceRef = `video-os/auth/provider-consent-readback/${evidenceDigest}.json`;
  await put(PRIVATE_BLOB_CLASSIFICATIONS.AUTHENTICATION_STATE, privateEvidenceRef, receipt, {
    contentType: 'application/json', allowOverwrite: true,
  });
  return { providerConsentStatus, evidenceDigest, privateEvidenceRef };
}

function session(req, authenticate) {
  try { return authenticate(req); } catch { throw routeError('sign_in_required', 'Sign in to continue.', 401, 'AUTH'); }
}

export function createProviderConsentHandler(dependencies = {}) {
  const env = dependencies.environment || process.env;
  const db = dependencies.database || database;
  const authenticate = dependencies.authenticate || sessionFromRequest;
  const lookupIdentity = dependencies.getOwnedIdentity || getOwnedIdentity;
  const resolveBinding = dependencies.resolveBinding || resolveFreshHeygenSpaceBinding;
  const assertBinding = dependencies.assertBinding || assertFreshHeygenSpaceBinding;
  const claimTransaction = dependencies.claimTransaction || ((accountId, providerBinding, callback) => withFreshHeygenSpaceBindingTransaction({ accountId, providerBinding }, callback));
  const receiptTransaction = dependencies.receiptTransaction || ((accountId, providerBinding, callback) => withHeygenSpaceBindingReceiptTransaction({ accountId, providerBinding }, callback));
  const createHostedConsent = dependencies.createHostedConsent || createHeygenHostedConsent;
  const readAvatarStatus = dependencies.readAvatarStatus || getHeygenPhotoAvatarStatus;
  const saveUrl = dependencies.saveUrl || saveProviderConsentUrl;
  const readUrl = dependencies.readUrl || readProviderConsentUrl;
  const now = dependencies.now || Date.now;
  const issueNoticeTx = dependencies.issueNoticeTx || issueHostedSubjectNoticeChallengeTx;
  const acceptNoticeTx = dependencies.acceptNoticeTx || acceptHostedSubjectConsentNoticeTx;
  const reserveAttemptTx = dependencies.reserveAttemptTx || reserveHostedAvatarConsentAttemptTx;
  const recordIssuedTx = dependencies.recordIssuedTx || recordHostedAvatarConsentIssuedTx;
  const consumeLaunchTx = dependencies.consumeLaunchTx || consumeHostedAvatarConsentLaunchTx;
  const recordReturnTx = dependencies.recordReturnTx || recordHostedAvatarConsentReturnTx;
  const recordUnknownTx = dependencies.recordUnknownTx || recordHostedAvatarConsentSubmissionUnknownTx;
  const recordReadbackTx = dependencies.recordReadbackTx || recordHostedAvatarConsentReadbackTx;
  const getStatusTx = dependencies.getStatusTx || getHostedAvatarConsentStatusTx;
  const findActiveSubjectConsent = dependencies.activeSubjectConsent || activeSubjectConsent;
  const findReturnOperation = dependencies.resolveReturnOperation || resolveReturnOperation;
  const findLaunchOperation = dependencies.resolveLaunchOperation || resolveLaunchOperation;
  const findIssuedEvidence = dependencies.recoverIssuedEvidence || ((tx, operationId) => recoverIssuedEvidence(tx, operationId, now()));
  const persistReadbackEvidence = dependencies.persistReadbackEvidence || persistProviderReadbackEvidence;
  const assertInvitationEmailConfigured = dependencies.assertInvitationEmailConfigured || assertProviderConsentInvitationEmailConfigured;
  const sendInvitation = dependencies.sendInvitation || sendProviderConsentInvitationEmail;
  const rateLimit = dependencies.consumeRateLimit || consumeRateLimit;

  async function issueNotice(req, res, input) {
    assertEnabled(env);
    const actor = session(req, authenticate);
    const identity = await exactIdentity(actor.accountId, input.identityId, lookupIdentity);
    const subjectEmail = normalizedEmail(input.subjectEmail);
    if (!EMAIL.test(subjectEmail) || subjectEmail.length > 320) throw routeError('invalid_request', 'Subject email is invalid.');
    assertInvitationEmailConfigured(env);
    const allowed = await rateLimit({ accountId: actor.accountId, key: `hosted-consent-invite:${actor.accountId}:${identity.id}`, limit: 5, windowMs: 60 * 60 * 1000 });
    if (!allowed) throw routeError('rate_limited', 'Presenter invitation limit reached. Try again later.', 429, 'RATE_LIMIT');
    const expiresAt = new Date(now() + INVITATION_TTL_MS);
    const invitation = issueProviderSubjectInvitation({ accountId: actor.accountId, identityId: identity.id, subjectEmail, expiresAt }, { env, now });
    await db().transaction(tx => issueNoticeTx(tx, {
      accountId: actor.accountId, identityId: identity.id, subjectEmail,
      tokenHash: invitation.tokenHash, expiresAt,
    }));
    const url = `${publicOrigin(env)}/provider-consent#invite=${encodeURIComponent(invitation.token)}`;
    await sendInvitation({ email: subjectEmail, url, expiresAt: invitation.expiresAt }, { env });
    return send(res, 201, { ok: true, invitation: { delivered: true, expiresAt: invitation.expiresAt } });
  }

  async function acceptNotice(req, res, input) {
    assertEnabled(env);
    if (input.affirmativeNotice !== true) throw routeError('affirmative_notice_required', 'Affirmative subject notice acceptance is required.', 409, 'SUBJECT_CONSENT_REQUIRED');
    const invitation = verifyProviderSubjectInvitation(input.invitationToken, { env, now });
    const actor = session(req, authenticate);
    if (normalizedEmail(actor.email) !== invitation.subjectEmail) throw routeError('subject_session_mismatch', 'Sign in as the invited subject.', 403, 'OWNERSHIP');
    const result = await db().transaction(tx => acceptNoticeTx(tx, {
      accountId: invitation.accountId,
      identityId: invitation.identityId,
      noticeTokenHash: invitation.tokenHash,
      policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
    }));
    return send(res, result.replayed ? 200 : 201, { ok: true, subjectConsent: {
      accepted: true, replayed: result.replayed, policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
      expiresAt: invitation.expiresAt,
    } });
  }

  async function createSession(req, res, input) {
    assertEnabled(env);
    const invitation = verifyProviderSubjectInvitation(input.invitationToken, { env, now });
    const actor = session(req, authenticate);
    if (normalizedEmail(actor.email) !== invitation.subjectEmail) throw routeError('subject_session_mismatch', 'Sign in as the invited subject.', 403, 'OWNERSHIP');
    if (!IDEMPOTENCY_KEY.test(String(input.idempotencyKey || ''))) throw routeError('invalid_request', 'Idempotency key is invalid.');
    const identity = await exactIdentity(invitation.accountId, invitation.identityId, lookupIdentity);
    const providerBinding = await resolveBinding({ accountId: invitation.accountId });
    assertBinding(providerBinding);
    const returnState = deterministicReturnState({
      invitationTokenHash: invitation.tokenHash,
      accountId: invitation.accountId,
      identityId: invitation.identityId,
      idempotencyKey: input.idempotencyKey,
    }, env);
    const returnExpiresAt = new Date(now() + PROVIDER_SESSION_TTL_MS);
    const returnUrl = `${publicOrigin(env)}/api/video-os-lite/provider-consent?action=return&request=${encodeURIComponent(input.idempotencyKey)}&locator=${encodeURIComponent(returnLocator(invitation.accountId, input.idempotencyKey, env))}&state=${encodeURIComponent(returnState)}`;
    const reserved = await claimTransaction(invitation.accountId, providerBinding, async tx => {
      const consent = await findActiveSubjectConsent(tx, invitation.accountId, invitation.identityId);
      return reserveAttemptTx(tx, {
        accountId: invitation.accountId,
        identityId: invitation.identityId,
        identityConsentId: consent.id,
        policyVersion: HOSTED_SUBJECT_CONSENT_POLICY_VERSION,
        providerGroupId: identity.providerAvatarGroupId,
        providerBinding,
        idempotencyKey: input.idempotencyKey,
        correlationId: crypto.randomUUID(),
        rerouteUrlDigest: sha(returnUrl),
        returnChallenge: { tokenHash: sha(returnState), subjectEmail: invitation.subjectEmail, expiresAt: returnExpiresAt },
      });
    });
    if (!reserved.shouldSubmit) {
      const launchState = token();
      const attempt = await receiptTransaction(invitation.accountId, providerBinding, async tx => {
        const evidence = await findIssuedEvidence(tx, reserved.operation.id);
        return recordIssuedTx(tx, {
          accountId: invitation.accountId,
          operationId: reserved.operation.id,
          providerBinding,
          providerUrlDigest: evidence.providerUrlDigest,
          privateUrlEvidenceRef: evidence.privateUrlEvidenceRef,
          providerUrlExpiresAt: evidence.providerUrlExpiresAt,
          launchChallenge: {
            tokenHash: sha(launchState),
            subjectEmail: invitation.subjectEmail,
            expiresAt: evidence.providerUrlExpiresAt,
          },
        });
      });
      const launchUrl = `${publicOrigin(env)}/api/video-os-lite/provider-consent?action=launch&attempt=${encodeURIComponent(reserved.operation.id)}&state=${encodeURIComponent(launchState)}`;
      return send(res, 200, { ok: true, attempt, launchUrl });
    }
    let hosted;
    try {
      assertBinding(providerBinding);
      hosted = await createHostedConsent({
        groupId: identity.providerAvatarGroupId,
        rerouteUrl: returnUrl,
        publicOrigin: publicOrigin(env),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      await receiptTransaction(invitation.accountId, providerBinding, tx => recordUnknownTx(tx, {
        accountId: invitation.accountId, operationId: reserved.operation.id, providerBinding,
        code: error?.failureCategory || 'PROVIDER_RESULT_UNKNOWN',
      })).catch(() => {});
      throw error;
    }
    const providerUrlExpiresAt = new Date(now() + PROVIDER_SESSION_TTL_MS);
    const stored = await saveUrl({ operationId: reserved.operation.id, url: hosted.url, expiresAt: providerUrlExpiresAt });
    const launchState = token();
    const attempt = await receiptTransaction(invitation.accountId, providerBinding, tx => recordIssuedTx(tx, {
      accountId: invitation.accountId,
      operationId: reserved.operation.id,
      providerBinding,
      providerUrlDigest: stored.urlDigest,
      privateUrlEvidenceRef: stored.pathname,
      providerUrlExpiresAt,
      launchChallenge: { tokenHash: sha(launchState), subjectEmail: invitation.subjectEmail, expiresAt: providerUrlExpiresAt },
    }));
    const launchUrl = `${publicOrigin(env)}/api/video-os-lite/provider-consent?action=launch&attempt=${encodeURIComponent(reserved.operation.id)}&state=${encodeURIComponent(launchState)}`;
    return send(res, 201, { ok: true, attempt, launchUrl });
  }

  async function launch(res, query) {
    assertEnabled(env);
    const operationId = String(query.get('attempt') || '');
    const launchState = String(query.get('state') || '');
    const operation = await db().transaction(tx => findLaunchOperation(tx, operationId));
    const accountId = operation.applicationAccountId;
    const providerBinding = await resolveBinding({ accountId });
    const receipt = await receiptTransaction(accountId, providerBinding, tx => consumeLaunchTx(tx, {
      accountId, operationId, providerBinding, launchTokenHash: sha(launchState),
    }));
    const providerUrl = await readUrl({ path: receipt.privateUrlEvidenceRef, operationId });
    if (sha(providerUrl) !== receipt.providerUrlDigest) throw routeError('consent_url_mismatch', 'Hosted consent link is unavailable.', 409, 'PROVIDER_CONSENT_EVIDENCE_INVALID');
    return redirect(res, providerUrl);
  }

  async function resolveLaunchOperation(tx, operationId) {
    const rows = await tx.select().from(providerLifecycleOperations).where(and(
      eq(providerLifecycleOperations.id, operationId),
      eq(providerLifecycleOperations.kind, 'avatar_consent_submit'),
    )).limit(2);
    if (rows.length !== 1) throw routeError('consent_launch_invalid', 'Hosted consent launch is invalid.', 404, 'OWNERSHIP');
    return rows[0];
  }

  async function resolveReturnOperation(tx, idempotencyKey, locator) {
    const rows = await tx.select().from(providerLifecycleOperations).where(and(
      eq(providerLifecycleOperations.kind, 'avatar_consent_submit'),
      eq(providerLifecycleOperations.originOperationKey, idempotencyKey),
    )).limit(20);
    const matches = rows.filter(row => {
      const expected = Buffer.from(returnLocator(row.applicationAccountId, idempotencyKey, env));
      const actual = Buffer.from(String(locator || ''));
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
    if (matches.length !== 1) throw routeError('consent_return_invalid', 'Hosted consent return is invalid.', 404, 'OWNERSHIP');
    return matches[0];
  }

  async function returned(res, query) {
    assertEnabled(env);
    const idempotencyKey = String(query.get('request') || '');
    const locator = String(query.get('locator') || '');
    const returnState = String(query.get('state') || '');
    const operation = await db().transaction(tx => findReturnOperation(tx, idempotencyKey, locator));
    const accountId = operation.applicationAccountId;
    const identity = await exactIdentity(accountId, operation.identityId, lookupIdentity);
    const providerBinding = await resolveBinding({ accountId });
    await receiptTransaction(accountId, providerBinding, tx => recordReturnTx(tx, {
      accountId, operationId: operation.id, providerBinding, returnTokenHash: sha(returnState),
    }));
    assertBinding(providerBinding);
    const observed = await readAvatarStatus({ groupId: identity.providerAvatarGroupId, lookId: identity.providerRenderableAvatarId });
    const readback = await persistReadbackEvidence({ accountId, identity, providerBinding, observed, observedAt: now() });
    await receiptTransaction(accountId, providerBinding, tx => recordReadbackTx(tx, {
      accountId, operationId: operation.id, providerBinding,
      providerGroupId: identity.providerAvatarGroupId,
      providerConsentStatus: readback.providerConsentStatus.toUpperCase(),
      evidenceDigest: readback.evidenceDigest,
      privateEvidenceRef: readback.privateEvidenceRef,
    }));
    return redirect(res, '/provider-consent?returned=1');
  }

  async function status(req, res, query) {
    const availability = providerSubjectConsentActivationStatus(env);
    const actor = session(req, authenticate);
    const identity = await exactIdentity(actor.accountId, query.get('identityId'), lookupIdentity);
    if (!availability.enabled) return send(res, 200, { ok: true, availability, consent: null });
    const providerBinding = await resolveBinding({ accountId: actor.accountId });
    let consent = await db().transaction(tx => getStatusTx(tx, {
      accountId: actor.accountId, identityId: identity.id,
      providerGroupId: identity.providerAvatarGroupId, providerBinding,
    }));
    if (consent && !consent.terminalOutcome && ['UNKNOWN', 'PENDING', null].includes(consent.providerConsentStatus)) {
      assertBinding(providerBinding);
      const observed = await readAvatarStatus({ groupId: identity.providerAvatarGroupId, lookId: identity.providerRenderableAvatarId });
      const readback = await persistReadbackEvidence({ accountId: actor.accountId, identity, providerBinding, observed, observedAt: now() });
      consent = await receiptTransaction(actor.accountId, providerBinding, tx => recordReadbackTx(tx, {
        accountId: actor.accountId,
        operationId: consent.attemptId,
        providerBinding,
        providerGroupId: identity.providerAvatarGroupId,
        providerConsentStatus: readback.providerConsentStatus.toUpperCase(),
        evidenceDigest: readback.evidenceDigest,
        privateEvidenceRef: readback.privateEvidenceRef,
      }));
    }
    return send(res, 200, { ok: true, availability, consent });
  }

  return async function providerConsentHandler(req, res) {
    if (handleOptions(req, res)) return;
    try {
      const url = new URL(req.url, 'https://video-os.invalid');
      const action = url.searchParams.get('action');
      if (req.method === 'GET') {
        if (action === 'launch') return await launch(res, url.searchParams);
        if (action === 'return') return await returned(res, url.searchParams);
        if (action === 'status') return await status(req, res, url.searchParams);
        return send(res, 400, { ok: false, code: 'invalid_request', error: 'Hosted consent action is invalid.' });
      }
      if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST.' });
      assertJsonTransport(req, env);
      const input = await body(req);
      if (input.action === 'issue-notice') return await issueNotice(req, res, input);
      if (input.action === 'accept-notice') return await acceptNotice(req, res, input);
      if (input.action === 'create-session') return await createSession(req, res, input);
      return send(res, 400, { ok: false, code: 'invalid_request', error: 'Hosted consent action is invalid.' });
    } catch (error) {
      const statusCode = error.statusCode || 400;
      const publicMessage = statusCode >= 500 ? 'Hosted consent is temporarily unavailable.' : (error.message || 'Hosted consent request failed.');
      return send(res, statusCode, { ok: false, code: error.code || error.failureCategory || 'hosted_consent_failed', error: publicMessage });
    }
  };
}

export default createProviderConsentHandler();
