import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createProviderConsentHandler, persistProviderReadbackEvidence } from '../routes/video-os-lite/provider-consent.js';

const ORIGIN = 'https://video.example';
const identityId = '11111111-1111-4111-8111-111111111111';
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const secret = 'i'.repeat(48);
const identity = { id: identityId, archivedAt: null, providerAvatarGroupId: 'private-group', providerRenderableAvatarId: 'private-look' };
const binding = { bindingId: 'binding-1', originScopeKey: 'a'.repeat(64), verifiedAccountScopeId: 'scope-1' };
const digest = value => createHash('sha256').update(value).digest('hex');
let sentInvitation;

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value ? JSON.parse(value) : undefined; } };
}

function request(body, { method = 'POST', url = '/api/video-os-lite/provider-consent', origin = ORIGIN } = {}) {
  return { method, url, headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body };
}

function db() { return { transaction: callback => callback({}) }; }
function base(overrides = {}) {
  return createProviderConsentHandler({
    environment: {
      VIDEO_OS_PUBLIC_ORIGIN: ORIGIN,
      VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED: 'true',
      VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET: secret,
    },
    database: db,
    authenticate: () => ({ accountId: 'owner-account', email: 'owner@example.test' }),
    getOwnedIdentity: async () => identity,
    resolveBinding: async () => binding,
    assertBinding: () => true,
    claimTransaction: (_accountId, _binding, callback) => callback({}),
    receiptTransaction: (_accountId, _binding, callback) => callback({}),
    resolveLaunchOperation: async () => ({ id: 'operation-1', applicationAccountId: 'owner-account' }),
    persistReadbackEvidence: async ({ observed }) => {
      const status = observed.avatarGroup?.consentStatus;
      if (!['pending', 'accepted', 'rejected'].includes(status)) throw Object.assign(new Error('Provider consent status could not be verified.'), { statusCode: 502, code: 'provider_readback_invalid' });
      return { providerConsentStatus: status, evidenceDigest: 'e'.repeat(64), privateEvidenceRef: 'video-os/auth/provider-consent-readback/evidence.json' };
    },
    now: () => Date.parse('2026-10-07T18:00:00Z'),
    assertInvitationEmailConfigured: () => {},
    consumeRateLimit: async () => true,
    sendInvitation: async input => { sentInvitation = input; return { sent: true }; },
    ...overrides,
  });
}

test('route is default-off before invitation state or provider work', async () => {
  let touched = false;
  const handler = base({
    environment: { VIDEO_OS_PUBLIC_ORIGIN: ORIGIN, VIDEO_OS_HOSTED_SUBJECT_CONSENT_INVITATION_SECRET: secret },
    issueNoticeTx: async () => { touched = true; },
  });
  const res = response();
  await handler(request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'hosted_subject_consent_disabled');
  assert.equal(touched, false);
});

test('owner issues one rate-limited email invitation without exposing its bearer in the response', async () => {
  let challenge;
  const handler = base({ issueNoticeTx: async (_tx, input) => { challenge = input; return {}; } });
  const res = response();
  await handler(request({ action: 'issue-notice', identityId, subjectEmail: 'Subject@Example.test' }), res);
  assert.equal(res.statusCode, 201);
  assert.ok(sentInvitation.url.startsWith(`${ORIGIN}/provider-consent#invite=`));
  assert.equal(res.body.invitation.delivered, true);
  assert.equal(JSON.stringify(res.body).includes('invite='), false);
  assert.equal(JSON.stringify(res.body).includes('private-group'), false);
  assert.equal(challenge.subjectEmail, 'subject@example.test');
  assert.match(challenge.tokenHash, /^[a-f0-9]{64}$/);
});

test('invitation sender configuration and rate limit fail before a challenge is created', async () => {
  let created = 0;
  const req = request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' });
  const unconfigured = response();
  await base({ assertInvitationEmailConfigured: () => { throw Object.assign(new Error('Email unavailable.'), { statusCode: 503 }); }, issueNoticeTx: async () => { created += 1; } })(req, unconfigured);
  assert.equal(unconfigured.statusCode, 503);
  const limited = response();
  await base({ consumeRateLimit: async () => false, issueNoticeTx: async () => { created += 1; } })(req, limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(created, 0);
});

test('failed email delivery never reports an invitation as delivered', async () => {
  const res = response();
  await base({ issueNoticeTx: async () => ({}), sendInvitation: async () => { throw Object.assign(new Error('Provider details hidden.'), { statusCode: 502 }); } })(
    request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(JSON.stringify(res.body).includes('invite='), false);
});

test('affirmative notice requires the invited subject session', async () => {
  let invitationUrl;
  const issuer = base({ issueNoticeTx: async () => {} });
  const issued = response();
  await issuer(request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' }), issued);
  invitationUrl = sentInvitation.url;
  const invitationToken = new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('invite');
  let accepted = false;
  const wrongActor = base({ acceptNoticeTx: async () => { accepted = true; } });
  const denied = response();
  await wrongActor(request({ action: 'accept-notice', invitationToken, affirmativeNotice: true }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(accepted, false);

  const subject = base({
    authenticate: () => ({ accountId: 'subject-account', email: 'subject@example.test' }),
    acceptNoticeTx: async (_tx, input) => { accepted = input.accountId === 'owner-account'; return { consent: {}, replayed: false }; },
  });
  const ok = response();
  await subject(request({ action: 'accept-notice', invitationToken, affirmativeNotice: true }), ok);
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.body.subjectConsent.accepted, true);
  assert.equal(accepted, true);
  assert.equal('consentId' in ok.body.subjectConsent, false);
});

test('subject session reserves before one provider POST and receives only a local one-time launch URL', async () => {
  const issuer = base({ issueNoticeTx: async () => {} });
  const issued = response();
  await issuer(request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' }), issued);
  const invitationToken = new URLSearchParams(new URL(sentInvitation.url).hash.slice(1)).get('invite');
  const order = [];
  let providerInput;
  const handler = base({
    authenticate: () => ({ accountId: 'subject-account', email: 'subject@example.test' }),
    activeSubjectConsent: async () => ({ id: 'consent-v3' }),
    reserveAttemptTx: async (_tx, input) => { order.push('reserve'); return { shouldSubmit: true, operation: { id: 'operation-1' }, attempt: { attemptId: 'operation-1', attemptState: 'RESERVED' } }; },
    createHostedConsent: async input => { order.push('provider'); providerInput = input; return { providerGroupId: 'private-group', consentStatus: 'pending', url: 'https://app.heygen.com/private?token=secret' }; },
    saveUrl: async () => ({ pathname: 'video-os/auth/provider-consent/evidence.json', urlDigest: 'b'.repeat(64), expiresAt: '2026-10-07T18:15:00.000Z' }),
    recordIssuedTx: async () => ({ attemptId: 'operation-1', attemptState: 'SUBMITTED', hostedSessionState: 'ISSUED' }),
  });
  const res = response();
  await handler(request({ action: 'create-session', invitationToken, idempotencyKey }), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(order, ['reserve', 'provider']);
  assert.equal(providerInput.groupId, 'private-group');
  assert.equal(providerInput.rerouteUrl.includes('owner-account'), false);
  assert.equal(new URL(providerInput.rerouteUrl).searchParams.has('account'), false);
  assert.ok(res.body.launchUrl.startsWith(`${ORIGIN}/api/video-os-lite/provider-consent?action=launch`));
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes('private-group'), false);
  assert.equal(serialized.includes('app.heygen.com'), false);
});

test('launch verifies the private URL digest before issuing its one-time 303', async () => {
  const providerUrl = 'https://app.heygen.com/private?token=secret';
  const urlDigest = digest(providerUrl);
  const handler = base({
    consumeLaunchTx: async () => ({ privateUrlEvidenceRef: 'video-os/auth/provider-consent/evidence.json', providerUrlDigest: urlDigest }),
    readUrl: async () => providerUrl,
  });
  const res = response();
  await handler(request(undefined, { method: 'GET', url: '/api/video-os-lite/provider-consent?action=launch&attempt=operation-1&state=one-time' }), res);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.Location, providerUrl);

  const mismatch = base({
    consumeLaunchTx: async () => ({ privateUrlEvidenceRef: 'video-os/auth/provider-consent/evidence.json', providerUrlDigest: '0'.repeat(64) }),
    readUrl: async () => providerUrl,
  });
  const denied = response();
  await mismatch(request(undefined, { method: 'GET', url: '/api/video-os-lite/provider-consent?action=launch&attempt=operation-1&state=one-time' }), denied);
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.headers.Location, undefined);
  assert.equal(JSON.stringify(denied.body).includes(providerUrl), false);
});

test('provider return refuses to invent pending when exact readback omits consent status', async () => {
  let recorded = false;
  const handler = base({
    resolveReturnOperation: async () => ({ id: 'operation-1', identityId }),
    recordReturnTx: async () => ({}),
    readAvatarStatus: async () => ({ avatarGroup: { consentStatus: null }, avatarLook: {} }),
    recordReadbackTx: async () => { recorded = true; },
  });
  const res = response();
  await handler(request(undefined, { method: 'GET', url: `/api/video-os-lite/provider-consent?action=return&request=${idempotencyKey}&locator=opaque&state=return-state` }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Hosted consent is temporarily unavailable.');
  assert.equal(recorded, false);
});

test('authenticated status refreshes a pending attempt from the exact group and returns only the projection', async () => {
  let readInput;
  let receiptInput;
  const handler = base({
    getStatusTx: async () => ({ attemptId: 'operation-1', attemptState: 'SUBMITTED', terminalOutcome: null, providerConsentStatus: 'UNKNOWN' }),
    readAvatarStatus: async input => { readInput = input; return {
      avatarGroup: { providerGroupId: 'private-group', status: 'completed', consentStatus: 'accepted' },
      avatarLook: { providerGroupId: 'private-group', providerLookId: 'private-look', avatarType: 'photo_avatar', status: 'completed' },
    }; },
    recordReadbackTx: async (_tx, input) => {
      receiptInput = input;
      return { attemptId: 'operation-1', attemptState: 'SUCCEEDED', terminalOutcome: 'SUCCEEDED', providerConsentStatus: 'ACCEPTED' };
    },
  });
  const res = response();
  await handler(request(undefined, { method: 'GET', url: `/api/video-os-lite/provider-consent?action=status&identityId=${identityId}` }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(readInput, { groupId: 'private-group', lookId: 'private-look' });
  assert.equal(receiptInput.providerConsentStatus, 'ACCEPTED');
  assert.equal(receiptInput.evidenceDigest, 'e'.repeat(64));
  assert.equal(receiptInput.privateEvidenceRef, 'video-os/auth/provider-consent-readback/evidence.json');
  assert.equal(res.body.consent.providerConsentStatus, 'ACCEPTED');
  assert.equal(JSON.stringify(res.body).includes('private-group'), false);
  assert.equal(JSON.stringify(res.body).includes('private-look'), false);
});

test('readback evidence stores only the exact reduced observation in private authentication storage', async () => {
  let saved;
  const result = await persistProviderReadbackEvidence({
    accountId: 'owner-account', identity, providerBinding: binding,
    observed: {
      avatarGroup: { providerGroupId: 'private-group', status: 'completed', consentStatus: 'accepted', unsafeRaw: 'drop-me' },
      avatarLook: { providerGroupId: 'private-group', providerLookId: 'private-look', avatarType: 'photo_avatar', status: 'completed', previewImageUrl: 'https://secret.example' },
      rawProviderPayload: { token: 'drop-me' },
    },
    observedAt: '2026-10-07T18:00:00.000Z',
  }, { put: async (...args) => { saved = args; } });
  assert.equal(saved[0], 'authentication-state');
  assert.match(saved[1], /^video-os\/auth\/provider-consent-readback\/[a-f0-9]{64}\.json$/);
  assert.equal(result.evidenceDigest, saved[1].match(/[a-f0-9]{64}/)[0]);
  const receipt = JSON.parse(saved[2]);
  assert.equal(receipt.providerGroupId, 'private-group');
  assert.equal(receipt.providerLookId, 'private-look');
  assert.equal(receipt.providerConsentStatus, 'ACCEPTED');
  assert.equal(receipt.providerGroupStatus, 'COMPLETED');
  assert.equal(receipt.providerLookStatus, 'COMPLETED');
  assert.equal(saved[3].allowOverwrite, true);
  assert.equal(JSON.stringify(receipt).includes('drop-me'), false);
  assert.equal(JSON.stringify(receipt).includes('secret.example'), false);
});

test('exact create-session retry keeps the return digest stable and reissues launch without a second provider POST', async () => {
  const issuer = base({ issueNoticeTx: async () => {} });
  const issued = response();
  await issuer(request({ action: 'issue-notice', identityId, subjectEmail: 'subject@example.test' }), issued);
  const invitationToken = new URLSearchParams(new URL(sentInvitation.url).hash.slice(1)).get('invite');
  const reservations = [];
  let providerPosts = 0;
  let providerUrlReads = 0;
  const retainedProviderUrl = 'https://app.heygen.com/private?token=secret';
  const retainedProviderUrlDigest = digest(retainedProviderUrl);
  let reserveCalls = 0;
  const handler = base({
    authenticate: () => ({ accountId: 'subject-account', email: 'subject@example.test' }),
    activeSubjectConsent: async () => ({ id: 'consent-v3' }),
    reserveAttemptTx: async (_tx, input) => {
      reservations.push(input);
      reserveCalls += 1;
      return { shouldSubmit: reserveCalls === 1, operation: { id: 'operation-1' }, attempt: { attemptId: 'operation-1' } };
    },
    createHostedConsent: async () => { providerPosts += 1; return { url: 'https://app.heygen.com/private?token=secret' }; },
    saveUrl: async () => ({ pathname: 'video-os/auth/provider-consent/evidence.json', urlDigest: retainedProviderUrlDigest }),
    recoverIssuedEvidence: async () => ({
      privateUrlEvidenceRef: 'video-os/auth/provider-consent/evidence.json',
      providerUrlDigest: retainedProviderUrlDigest,
      providerUrlExpiresAt: new Date('2026-10-08T18:00:00Z'),
    }),
    recordIssuedTx: async () => ({ attemptId: 'operation-1', attemptState: 'SUBMITTED', hostedSessionState: 'ISSUED' }),
    consumeLaunchTx: async () => ({ privateUrlEvidenceRef: 'video-os/auth/provider-consent/evidence.json', providerUrlDigest: retainedProviderUrlDigest }),
    readUrl: async () => { providerUrlReads += 1; return retainedProviderUrl; },
  });
  const first = response();
  const retry = response();
  const payload = { action: 'create-session', invitationToken, idempotencyKey: 'c'.repeat(64) };
  await handler(request(payload), first);
  await handler(request(payload), retry);
  assert.equal(providerPosts, 1);
  assert.equal(reservations.length, 2);
  assert.equal(reservations[0].rerouteUrlDigest, reservations[1].rerouteUrlDigest);
  assert.equal(reservations[0].returnChallenge.tokenHash, reservations[1].returnChallenge.tokenHash);
  assert.ok(retry.body.launchUrl);
  assert.notEqual(retry.body.launchUrl, first.body.launchUrl, 'retry gets a fresh one-time launch challenge');
  assert.equal(retry.body.launchUrl.includes('owner-account'), false);
  const firstLaunch = response();
  const retryLaunch = response();
  await handler(request(undefined, { method: 'GET', url: new URL(first.body.launchUrl).pathname + new URL(first.body.launchUrl).search }), firstLaunch);
  await handler(request(undefined, { method: 'GET', url: new URL(retry.body.launchUrl).pathname + new URL(retry.body.launchUrl).search }), retryLaunch);
  assert.equal(firstLaunch.statusCode, 303);
  assert.equal(retryLaunch.statusCode, 303);
  assert.equal(providerUrlReads, 2, 'private URL remains readable for each separately consumed local launch challenge');
  assert.equal(providerPosts, 1, 'launch recovery never creates another provider session');
});
