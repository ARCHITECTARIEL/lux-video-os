import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LUXIFY_CINEMATIC_CAPABILITY,
  LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
  LUXIFY_CONSENT_MAX_DAYS,
  LUXIFY_CONSENT_DEFAULT_DAYS,
  defaultLuxifyConsentExpiry,
  LUXIFY_LOOK_ELIGIBILITY_POLICY_VERSION,
  LuxifyLookEligibilityError,
  resolveLuxifyLookEligibility,
} from '../lib/luxify-look-eligibility.js';

const NOW = Date.parse('2026-10-11T12:30:00.000Z');
const ACCOUNT_ID = 'user-owner-1';
const BINDING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERIFIED_SCOPE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPACE_FINGERPRINT = 'c'.repeat(64);
const ORIGIN_SCOPE_KEY = 'd'.repeat(64);

const LOOKS = Object.freeze([
  Object.freeze({
    identityId: '11111111-1111-4111-8111-111111111111',
    resourceId: '21111111-1111-4111-8111-111111111111',
    providerLookId: 'look-ariel-1',
  }),
  Object.freeze({
    identityId: '22222222-2222-4222-8222-222222222222',
    resourceId: '32222222-2222-4222-8222-222222222222',
    providerLookId: 'look-oso-2',
  }),
  Object.freeze({
    identityId: '33333333-3333-4333-8333-333333333333',
    resourceId: '43333333-3333-4333-8333-333333333333',
    providerLookId: 'look-kd-3',
  }),
]);

function lookEvidence({ identityId, resourceId, providerLookId }) {
  return {
    identity: {
      id: identityId,
      accountId: ACCOUNT_ID,
      archivedAt: null,
      provider: 'heygen',
      providerRenderableAvatarId: providerLookId,
      avatarStatus: 'READY',
    },
    consent: {
      accountId: ACCOUNT_ID,
      identityId,
      providerLookId,
      policyVersion: LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION,
      purpose: 'luxify-cinematic-generation',
      cinematicGenerationAuthorization: true,
      providerProcessingAuthorization: true,
      acceptedAt: '2026-10-11T12:00:00.000Z',
      expiresAt: '2026-10-11T13:00:00.000Z',
      revokedAt: null,
    },
    resource: {
      id: resourceId,
      applicationAccountId: ACCOUNT_ID,
      bindingId: BINDING_ID,
      originScopeKey: ORIGIN_SCOPE_KEY,
      verifiedAccountScopeId: VERIFIED_SCOPE_ID,
      kind: 'avatar_look',
      providerResourceId: providerLookId,
      state: 'ready',
      tombstonedAt: null,
    },
    providerReadback: {
      provider: 'heygen',
      providerLookId,
      providerSpaceFingerprint: SPACE_FINGERPRINT,
      present: true,
      status: 'completed',
      avatarType: 'digital_twin',
      supportedApiEngines: ['avatar_v', 'avatar_iv', 'avatar_iii'],
      observedAt: '2026-10-11T12:29:00.000Z',
      expiresAt: '2026-10-11T12:31:00.000Z',
    },
  };
}

function providerSpace() {
  return {
    provider: 'heygen',
    scopeType: 'space',
    applicationAccountId: ACCOUNT_ID,
    bindingId: BINDING_ID,
    originScopeKey: ORIGIN_SCOPE_KEY,
    verifiedAccountScopeId: VERIFIED_SCOPE_ID,
    providerSpaceFingerprint: SPACE_FINGERPRINT,
    bindingState: 'active',
    promotionState: 'verified',
    observedAt: '2026-10-11T12:00:00.000Z',
    expiresAt: '2026-10-11T13:00:00.000Z',
  };
}

function canaryAuthority(lookIds = LOOKS.map(item => item.providerLookId)) {
  return {
    kind: 'server_canary_allowlist',
    revision: 'owner-canary-20261011-r1',
    providerSpaceFingerprint: SPACE_FINGERPRINT,
    lookIds,
  };
}

function capabilityAuthority(looks = LOOKS) {
  return {
    kind: 'approved_capability_evidence',
    revision: 'heygen-cinematic-proof-20261011-r1',
    providerSpaceFingerprint: SPACE_FINGERPRINT,
    approvalState: 'approved',
    lookCapabilities: looks.map((item, index) => ({
      providerLookId: item.providerLookId,
      capability: LUXIFY_CINEMATIC_CAPABILITY,
      eligible: true,
      evidenceDigest: String(index + 1).repeat(64),
    })),
  };
}

function fixture(looks = LOOKS.slice(0, 2), authority = canaryAuthority()) {
  return {
    accountId: ACCOUNT_ID,
    providerSpace: providerSpace(),
    looks: looks.map(lookEvidence),
    eligibilityAuthority: authority,
  };
}

function expectDenied(input, reason, options = { now: NOW }) {
  assert.throws(
    () => resolveLuxifyLookEligibility(input, options),
    error => error instanceof LuxifyLookEligibilityError
      && error.code === 'LUXIFY_LOOK_NOT_ELIGIBLE'
      && error.reason === reason,
  );
}

test('server canary allowlist returns ordered immutable sanitized quote bindings', () => {
  const input = fixture([LOOKS[1], LOOKS[0]], canaryAuthority([
    LOOKS[0].providerLookId,
    LOOKS[1].providerLookId,
  ]));
  const result = resolveLuxifyLookEligibility(input, { now: NOW });

  assert.equal(LUXIFY_LOOK_ELIGIBILITY_POLICY_VERSION, 'luxify-look-eligibility/v1');
  assert.deepEqual(result, {
    lookBindings: [
      { identityId: LOOKS[1].identityId, providerLookId: LOOKS[1].providerLookId },
      { identityId: LOOKS[0].identityId, providerLookId: LOOKS[0].providerLookId },
    ],
    eligibilityRevision: 'luxify-look-eligibility-v1:canary:owner-canary-20261011-r1',
  });
  assert.deepEqual(Object.keys(result), ['lookBindings', 'eligibilityRevision']);
  assert(result.lookBindings.every(binding => Object.keys(binding).join(',') === 'identityId,providerLookId'));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.lookBindings), true);
  assert(result.lookBindings.every(Object.isFrozen));
  assert.throws(() => { result.lookBindings[0].providerLookId = 'changed'; }, TypeError);
});

test('approved capability evidence revision authorizes one to three ordered looks', () => {
  const result = resolveLuxifyLookEligibility(
    fixture(LOOKS, capabilityAuthority()),
    { now: NOW },
  );
  assert.deepEqual(result.lookBindings.map(item => item.identityId), LOOKS.map(item => item.identityId));
  assert.equal(
    result.eligibilityRevision,
    'luxify-look-eligibility-v1:capability:heygen-cinematic-proof-20261011-r1',
  );
});

test('generic READY and Avatar V/IV/III engine support never imply cinematic eligibility', () => {
  const input = fixture([LOOKS[0]], canaryAuthority([LOOKS[1].providerLookId]));
  input.looks[0].identity.avatarStatus = 'READY';
  input.looks[0].resource.state = 'ready';
  input.looks[0].providerReadback.status = 'completed';
  input.looks[0].providerReadback.supportedApiEngines = ['avatar_v', 'avatar_iv', 'avatar_iii'];
  expectDenied(input, 'CAPABILITY_UNVERIFIED');

  const capability = capabilityAuthority([LOOKS[0]]);
  capability.lookCapabilities[0].eligible = false;
  expectDenied(fixture([LOOKS[0]], capability), 'CAPABILITY_UNVERIFIED');
});

test('look count, order identity, and uniqueness fail closed', () => {
  const empty = fixture();
  empty.looks = [];
  expectDenied(empty, 'LOOK_COUNT_INVALID');

  const four = fixture();
  four.looks = [...LOOKS, LOOKS[0]].map(lookEvidence);
  expectDenied(four, 'LOOK_COUNT_INVALID');

  const duplicateIdentity = fixture([LOOKS[0], { ...LOOKS[1], identityId: LOOKS[0].identityId }]);
  duplicateIdentity.eligibilityAuthority = canaryAuthority([LOOKS[0].providerLookId, LOOKS[1].providerLookId]);
  expectDenied(duplicateIdentity, 'DUPLICATE_LOOK');

  const duplicateProviderLook = fixture([LOOKS[0], { ...LOOKS[1], providerLookId: LOOKS[0].providerLookId }]);
  expectDenied(duplicateProviderLook, 'DUPLICATE_LOOK');
});

test('account ownership and archive evidence are mandatory for every look', () => {
  const cases = [
    ['identity account', input => { input.looks[0].identity.accountId = 'user-other'; }, 'IDENTITY_INVALID'],
    ['consent account', input => { input.looks[0].consent.accountId = 'user-other'; }, 'CONSENT_INVALID'],
    ['resource account', input => { input.looks[0].resource.applicationAccountId = 'user-other'; }, 'RESOURCE_INVALID'],
    ['space account', input => { input.providerSpace.applicationAccountId = 'user-other'; }, 'PROVIDER_SPACE_INVALID'],
    ['archived identity', input => { input.looks[0].identity.archivedAt = '2026-10-11T12:10:00.000Z'; }, 'IDENTITY_ARCHIVED'],
  ];
  for (const [name, mutate, reason] of cases) {
    const input = fixture([LOOKS[0]]);
    mutate(input);
    assert.equal(typeof name, 'string');
    expectDenied(input, reason);
  }
});

test('cinematic consent must be exact, active, current, and bound to the look', () => {
  const cases = [
    input => { input.looks[0].consent.purpose = 'avatar-video'; },
    input => { input.looks[0].consent.cinematicGenerationAuthorization = false; },
    input => { input.looks[0].consent.providerProcessingAuthorization = false; },
    input => { input.looks[0].consent.providerLookId = LOOKS[1].providerLookId; },
    input => { input.looks[0].consent.revokedAt = '2026-10-11T12:15:00.000Z'; },
    input => { input.looks[0].consent.expiresAt = '2026-10-11T12:30:00.000Z'; },
  ];
  for (const mutate of cases) {
    const input = fixture([LOOKS[0]]);
    mutate(input);
    expectDenied(input, 'CONSENT_INVALID');
  }
});

test('cinematic consent expiry is mandatory, exact, and at most 365 days', () => {
  assert.equal(LUXIFY_CONSENT_MAX_DAYS, 365);
  assert.equal(LUXIFY_CONSENT_DEFAULT_DAYS, 365);
  assert.equal(defaultLuxifyConsentExpiry('2024-02-29T00:00:00.000Z'), '2025-02-28T00:00:00.000Z');
  const accepted = Date.parse('2026-10-11T12:00:00.000Z');
  const input = fixture([LOOKS[0]]);
  input.looks[0].consent.expiresAt = new Date(accepted + 365 * 86_400_000).toISOString();
  assert.doesNotThrow(() => resolveLuxifyLookEligibility(input, { now: NOW }));
  for (const expiry of [null, new Date(accepted + 365 * 86_400_000 + 1).toISOString(), '2027-10-11', 'bad']) {
    input.looks[0].consent.expiresAt = expiry;
    expectDenied(input, 'CONSENT_INVALID');
  }
  input.looks[0].consent.expiresAt = new Date(NOW).toISOString();
  expectDenied(input, 'CONSENT_INVALID');
});

test('cinematic consent rejects every non-current policy version', () => {
  assert.equal(LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION, 'luxify-cinematic-consent/v1');
  for (const policyVersion of [
    'luxify-cinematic-consent-v1',
    'luxify-cinematic-consent/v2',
    'identity-provider-bridge-v2',
  ]) {
    const input = fixture([LOOKS[0]]);
    input.looks[0].consent.policyVersion = policyVersion;
    expectDenied(input, 'CONSENT_INVALID');
  }
});

test('provider space must be current, active, verified, and exact', () => {
  const cases = [
    input => { input.providerSpace.provider = 'other'; },
    input => { input.providerSpace.scopeType = 'account'; },
    input => { input.providerSpace.bindingState = 'revoked'; },
    input => { input.providerSpace.promotionState = 'conflict'; },
    input => { input.providerSpace.expiresAt = '2026-10-11T12:30:00.000Z'; },
    input => { input.eligibilityAuthority.providerSpaceFingerprint = 'e'.repeat(64); },
  ];
  for (const mutate of cases) {
    const input = fixture([LOOKS[0]]);
    mutate(input);
    expectDenied(input, mutate === cases.at(-1) ? 'CAPABILITY_UNVERIFIED' : 'PROVIDER_SPACE_INVALID');
  }
});

test('provider resource must be the exact ready active look in the verified space', () => {
  const cases = [
    input => { input.looks[0].resource.kind = 'avatar_group'; },
    input => { input.looks[0].resource.state = 'present'; },
    input => { input.looks[0].resource.tombstonedAt = '2026-10-11T12:15:00.000Z'; },
    input => { input.looks[0].resource.providerResourceId = LOOKS[1].providerLookId; },
    input => { input.looks[0].resource.bindingId = '99999999-9999-4999-8999-999999999999'; },
    input => { input.looks[0].resource.originScopeKey = 'f'.repeat(64); },
    input => { input.looks[0].resource.verifiedAccountScopeId = '88888888-8888-4888-8888-888888888888'; },
  ];
  for (const mutate of cases) {
    const input = fixture([LOOKS[0]]);
    mutate(input);
    expectDenied(input, 'RESOURCE_INVALID');
  }
});

test('current provider readback must prove the same present completed look and space', () => {
  const cases = [
    input => { input.looks[0].providerReadback.provider = 'other'; },
    input => { input.looks[0].providerReadback.providerLookId = LOOKS[1].providerLookId; },
    input => { input.looks[0].providerReadback.providerSpaceFingerprint = 'e'.repeat(64); },
    input => { input.looks[0].providerReadback.present = false; },
    input => { input.looks[0].providerReadback.status = 'ready'; },
    input => { input.looks[0].providerReadback.avatarType = '   '; },
    input => { input.looks[0].providerReadback.expiresAt = '2026-10-11T12:30:00.000Z'; },
  ];
  for (const mutate of cases) {
    const input = fixture([LOOKS[0]]);
    mutate(input);
    expectDenied(input, 'PROVIDER_READBACK_INVALID');
  }
});

test('unknown evidence fields and unapproved authority shapes fail closed', () => {
  const topLevel = fixture([LOOKS[0]]);
  topLevel.clientEligible = true;
  expectDenied(topLevel, 'INVALID_EVIDENCE');
  expectDenied(fixture([LOOKS[0]]), 'INVALID_EVIDENCE', null);

  const nested = fixture([LOOKS[0]]);
  nested.looks[0].providerReadback.cinematicEligible = true;
  expectDenied(nested, 'INVALID_EVIDENCE');

  const authority = fixture([LOOKS[0]]);
  authority.eligibilityAuthority = {
    kind: 'approved_capability_evidence',
    revision: 'unapproved-r1',
    providerSpaceFingerprint: SPACE_FINGERPRINT,
    approvalState: 'draft',
    lookCapabilities: capabilityAuthority([LOOKS[0]]).lookCapabilities,
  };
  expectDenied(authority, 'CAPABILITY_UNVERIFIED');
});
