export const LUXIFY_LOOK_ELIGIBILITY_POLICY_VERSION = 'luxify-look-eligibility/v1';
export const LUXIFY_CINEMATIC_CAPABILITY = 'cinematic_avatar';
export const LUXIFY_CONSENT_MAX_DAYS = 365;
export const LUXIFY_CONSENT_DEFAULT_DAYS = 365;
// Reserved for a separately approved persisted cinematic-consent receipt.
// No current runtime path creates or accepts this policy as activation proof.
export const LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION = 'luxify-cinematic-consent/v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const REVISION = /^[A-Za-z0-9_.:-]{1,96}$/;
const ACCOUNT_ID = /^[^\u0000-\u001f\u007f]{1,160}$/;
const SAFE_ENGINE = /^[A-Za-z0-9_.:-]{1,80}$/;
const TOP_LEVEL_KEYS = new Set(['accountId', 'providerSpace', 'looks', 'eligibilityAuthority']);
const SPACE_KEYS = new Set([
  'provider',
  'scopeType',
  'applicationAccountId',
  'bindingId',
  'originScopeKey',
  'verifiedAccountScopeId',
  'providerSpaceFingerprint',
  'bindingState',
  'promotionState',
  'observedAt',
  'expiresAt',
]);
const LOOK_KEYS = new Set(['identity', 'consent', 'resource', 'providerReadback']);
const IDENTITY_KEYS = new Set([
  'id',
  'accountId',
  'archivedAt',
  'provider',
  'providerRenderableAvatarId',
  'avatarStatus',
]);
const CONSENT_KEYS = new Set([
  'accountId',
  'identityId',
  'providerLookId',
  'policyVersion',
  'purpose',
  'cinematicGenerationAuthorization',
  'providerProcessingAuthorization',
  'acceptedAt',
  'expiresAt',
  'revokedAt',
]);
const RESOURCE_KEYS = new Set([
  'id',
  'applicationAccountId',
  'bindingId',
  'originScopeKey',
  'verifiedAccountScopeId',
  'kind',
  'providerResourceId',
  'state',
  'tombstonedAt',
]);
const READBACK_KEYS = new Set([
  'provider',
  'providerLookId',
  'providerSpaceFingerprint',
  'present',
  'status',
  'avatarType',
  'supportedApiEngines',
  'observedAt',
  'expiresAt',
]);
const CANARY_KEYS = new Set(['kind', 'revision', 'providerSpaceFingerprint', 'lookIds']);
const CAPABILITY_KEYS = new Set([
  'kind',
  'revision',
  'providerSpaceFingerprint',
  'approvalState',
  'lookCapabilities',
]);
const LOOK_CAPABILITY_KEYS = new Set([
  'providerLookId',
  'capability',
  'eligible',
  'evidenceDigest',
]);

const VALIDATION_REASONS = new Set([
  'INVALID_EVIDENCE',
  'LOOK_COUNT_INVALID',
  'DUPLICATE_LOOK',
]);
const CONSENT_REASONS = new Set(['CONSENT_INVALID']);

export class LuxifyLookEligibilityError extends Error {
  constructor(reason, statusCode = 409) {
    super('LUXIFY look eligibility could not be established.');
    this.name = 'LuxifyLookEligibilityError';
    this.code = 'LUXIFY_LOOK_NOT_ELIGIBLE';
    this.reason = reason;
    this.statusCode = statusCode;
    this.failureCategory = VALIDATION_REASONS.has(reason)
      ? 'VALIDATION'
      : CONSENT_REASONS.has(reason)
        ? 'CONSENT'
        : 'ENTITLEMENT';
  }
}

function deny(reason, statusCode = 409) {
  throw new LuxifyLookEligibilityError(reason, statusCode);
}

function strictRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('INVALID_EVIDENCE', 400);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some(key => !keys.has(key))) deny('INVALID_EVIDENCE', 400);
  return value;
}

function exactAccountId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !ACCOUNT_ID.test(value)) deny('INVALID_EVIDENCE', 400);
  return value;
}

function exactUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) deny('INVALID_EVIDENCE', 400);
  return value.toLowerCase();
}

function exactProviderId(value) {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) deny('INVALID_EVIDENCE', 400);
  return value;
}

function exactHash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) deny('INVALID_EVIDENCE', 400);
  return value;
}

function exactRevision(value) {
  if (typeof value !== 'string' || !REVISION.test(value)) deny('INVALID_EVIDENCE', 400);
  return value;
}

function exactIso(value) {
  if (typeof value !== 'string') deny('INVALID_EVIDENCE', 400);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) deny('INVALID_EVIDENCE', 400);
  return time;
}

export function defaultLuxifyConsentExpiry(acceptedAt) {
  const accepted = exactIso(acceptedAt);
  const calendar = new Date(accepted);
  calendar.setUTCFullYear(calendar.getUTCFullYear() + 1);
  return new Date(Math.min(calendar.getTime(), accepted + LUXIFY_CONSENT_DEFAULT_DAYS * 86_400_000)).toISOString();
}

function clockMs(value) {
  const time = value instanceof Date ? value.getTime() : value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(time) || time <= 0) deny('INVALID_EVIDENCE', 400);
  return time;
}

function assertCurrentWindow(observedAt, expiresAt, now, reason) {
  const observed = exactIso(observedAt);
  const expires = exactIso(expiresAt);
  if (observed > now || observed >= expires || now >= expires) deny(reason);
}

function validateProviderSpace(value, accountId, now) {
  const space = strictRecord(value, SPACE_KEYS);
  if (space.provider !== 'heygen'
    || space.scopeType !== 'space'
    || exactAccountId(space.applicationAccountId) !== accountId
    || space.bindingState !== 'active'
    || space.promotionState !== 'verified') {
    deny('PROVIDER_SPACE_INVALID');
  }
  const normalized = {
    bindingId: exactUuid(space.bindingId),
    originScopeKey: exactHash(space.originScopeKey),
    verifiedAccountScopeId: exactUuid(space.verifiedAccountScopeId),
    providerSpaceFingerprint: exactHash(space.providerSpaceFingerprint),
  };
  assertCurrentWindow(space.observedAt, space.expiresAt, now, 'PROVIDER_SPACE_INVALID');
  return normalized;
}

function validatedLookIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) deny('INVALID_EVIDENCE', 400);
  const lookIds = value.map(exactProviderId);
  if (new Set(lookIds).size !== lookIds.length) deny('INVALID_EVIDENCE', 400);
  return lookIds;
}

function validateEligibilityAuthority(value, providerSpaceFingerprint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('CAPABILITY_UNVERIFIED');
  if (value.kind === 'server_canary_allowlist') {
    const authority = strictRecord(value, CANARY_KEYS);
    if (exactHash(authority.providerSpaceFingerprint) !== providerSpaceFingerprint) deny('CAPABILITY_UNVERIFIED');
    const revision = exactRevision(authority.revision);
    return {
      eligibleLookIds: new Set(validatedLookIds(authority.lookIds)),
      eligibilityRevision: `luxify-look-eligibility-v1:canary:${revision}`,
    };
  }
  if (value.kind === 'approved_capability_evidence') {
    const authority = strictRecord(value, CAPABILITY_KEYS);
    if (authority.approvalState !== 'approved'
      || exactHash(authority.providerSpaceFingerprint) !== providerSpaceFingerprint
      || !Array.isArray(authority.lookCapabilities)
      || authority.lookCapabilities.length < 1
      || authority.lookCapabilities.length > 100) {
      deny('CAPABILITY_UNVERIFIED');
    }
    const lookIds = [];
    for (const candidate of authority.lookCapabilities) {
      const capability = strictRecord(candidate, LOOK_CAPABILITY_KEYS);
      const providerLookId = exactProviderId(capability.providerLookId);
      exactHash(capability.evidenceDigest);
      if (capability.capability !== LUXIFY_CINEMATIC_CAPABILITY || typeof capability.eligible !== 'boolean') {
        deny('CAPABILITY_UNVERIFIED');
      }
      if (capability.eligible === true) lookIds.push(providerLookId);
    }
    if (new Set(authority.lookCapabilities.map(item => item.providerLookId)).size !== authority.lookCapabilities.length) {
      deny('INVALID_EVIDENCE', 400);
    }
    const revision = exactRevision(authority.revision);
    return {
      eligibleLookIds: new Set(lookIds),
      eligibilityRevision: `luxify-look-eligibility-v1:capability:${revision}`,
    };
  }
  deny('CAPABILITY_UNVERIFIED');
}

function validateIdentity(value, accountId) {
  const identity = strictRecord(value, IDENTITY_KEYS);
  const identityId = exactUuid(identity.id);
  const providerLookId = exactProviderId(identity.providerRenderableAvatarId);
  if (exactAccountId(identity.accountId) !== accountId
    || identity.archivedAt !== null
    || identity.provider !== 'heygen'
    || identity.avatarStatus !== 'READY') {
    deny(identity.archivedAt !== null ? 'IDENTITY_ARCHIVED' : 'IDENTITY_INVALID');
  }
  return { identityId, providerLookId };
}

function validateConsent(value, accountId, identityId, providerLookId, now) {
  const consent = strictRecord(value, CONSENT_KEYS);
  if (exactAccountId(consent.accountId) !== accountId
    || exactUuid(consent.identityId) !== identityId
    || exactProviderId(consent.providerLookId) !== providerLookId
    || consent.policyVersion !== LUXIFY_CINEMATIC_CONSENT_POLICY_VERSION
    || consent.purpose !== 'luxify-cinematic-generation'
    || consent.cinematicGenerationAuthorization !== true
    || consent.providerProcessingAuthorization !== true
    || consent.revokedAt !== null
    || exactIso(consent.acceptedAt) > now) {
    deny('CONSENT_INVALID');
  }
  // Consent receipts must have a bounded, exact expiry; malformed receipts
  // fail as consent failures rather than generic evidence failures.
  if (consent.expiresAt === null) deny('CONSENT_INVALID');
  let expiresAt;
  try { expiresAt = exactIso(consent.expiresAt); } catch { deny('CONSENT_INVALID'); }
  if (expiresAt <= exactIso(consent.acceptedAt)
    || expiresAt - exactIso(consent.acceptedAt) > LUXIFY_CONSENT_MAX_DAYS * 86_400_000
    || now >= expiresAt) deny('CONSENT_INVALID');
}

function validateResource(value, accountId, identity, providerSpace) {
  const resource = strictRecord(value, RESOURCE_KEYS);
  if (exactAccountId(resource.applicationAccountId) !== accountId
    || exactUuid(resource.bindingId) !== providerSpace.bindingId
    || exactHash(resource.originScopeKey) !== providerSpace.originScopeKey
    || exactUuid(resource.verifiedAccountScopeId) !== providerSpace.verifiedAccountScopeId
    || resource.kind !== 'avatar_look'
    || exactProviderId(resource.providerResourceId) !== identity.providerLookId
    || resource.state !== 'ready'
    || resource.tombstonedAt !== null) {
    deny('RESOURCE_INVALID');
  }
  exactUuid(resource.id);
}

function validateReadback(value, providerLookId, providerSpaceFingerprint, now) {
  const readback = strictRecord(value, READBACK_KEYS);
  if (readback.provider !== 'heygen'
    || exactProviderId(readback.providerLookId) !== providerLookId
    || exactHash(readback.providerSpaceFingerprint) !== providerSpaceFingerprint
    || readback.present !== true
    || readback.status !== 'completed'
    || typeof readback.avatarType !== 'string'
    || !SAFE_ENGINE.test(readback.avatarType)
    || !Array.isArray(readback.supportedApiEngines)
    || readback.supportedApiEngines.length > 20
    || readback.supportedApiEngines.some(engine => typeof engine !== 'string' || !SAFE_ENGINE.test(engine))
    || new Set(readback.supportedApiEngines).size !== readback.supportedApiEngines.length) {
    deny('PROVIDER_READBACK_INVALID');
  }
  assertCurrentWindow(readback.observedAt, readback.expiresAt, now, 'PROVIDER_READBACK_INVALID');
}

/**
 * Pure integration boundary. The caller must resolve every field server-side
 * under the account/provider authority it already enforces. Client payloads,
 * generic READY flags, and supported_api_engines are never eligibility
 * authority. The immutable return value is the exact eligibility fragment
 * accepted by the LUXIFY quote issuer.
 */
export function resolveLuxifyLookEligibility(input, options = {}) {
  const optionKeys = options && typeof options === 'object' && !Array.isArray(options) && Object.hasOwn(options, 'now')
    ? new Set(['now'])
    : new Set();
  strictRecord(options, optionKeys);
  const now = clockMs(options.now);
  const value = strictRecord(input, TOP_LEVEL_KEYS);
  const accountId = exactAccountId(value.accountId);
  if (!Array.isArray(value.looks) || value.looks.length < 1 || value.looks.length > 3) {
    deny('LOOK_COUNT_INVALID', 400);
  }
  const providerSpace = validateProviderSpace(value.providerSpace, accountId, now);
  const authority = validateEligibilityAuthority(value.eligibilityAuthority, providerSpace.providerSpaceFingerprint);
  const lookBindings = value.looks.map((rawLook) => {
    const look = strictRecord(rawLook, LOOK_KEYS);
    const identity = validateIdentity(look.identity, accountId);
    validateConsent(look.consent, accountId, identity.identityId, identity.providerLookId, now);
    validateResource(look.resource, accountId, identity, providerSpace);
    validateReadback(look.providerReadback, identity.providerLookId, providerSpace.providerSpaceFingerprint, now);
    if (!authority.eligibleLookIds.has(identity.providerLookId)) deny('CAPABILITY_UNVERIFIED');
    return Object.freeze({
      identityId: identity.identityId,
      providerLookId: identity.providerLookId,
    });
  });
  if (new Set(lookBindings.map(item => item.identityId)).size !== lookBindings.length
    || new Set(lookBindings.map(item => item.providerLookId)).size !== lookBindings.length) {
    deny('DUPLICATE_LOOK', 400);
  }
  return Object.freeze({
    lookBindings: Object.freeze(lookBindings),
    eligibilityRevision: authority.eligibilityRevision,
  });
}
