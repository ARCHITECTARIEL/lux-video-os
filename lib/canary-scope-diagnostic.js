import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';
import { providerSubjectConsentActivationStatus } from '../db/provider-subject-consent-repository.js';
import target from '../config/database-target.production.json' with { type: 'json' };
import { diagnosticMaintenanceMode } from './diagnostic-maintenance-gate.js';
import { auditOperatorDiagnostic, diagnosticAuditDetails } from './operator-diagnostic-audit.js';
import { createDiagnosticLimiter, diagnosticAvailable, diagnosticDigest, diagnosticEnabled,
  diagnosticHost, diagnosticResponse, expectedIdentity, isDbBindingOperatorRequest,
  REVIEWED_TARGET_FILE_SHA256, REVIEWED_TARGET_OBJECT_SHA256 } from './operator-diagnostic-guard.js';
import { timingSafeMatch } from './video-os-security.js';

const NONCE = /^[a-f0-9]{64}$/;
const MAC = /^[a-f0-9]{64}$/;
const ISSUED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const BOOLEAN_FIELDS = Object.freeze([
  'deploymentMatched', 'gitCommitMatched', 'projectMatched', 'stableAliasHostMatched',
  'uniqueDeploymentHostMatched', 'canaryPinPresent', 'canaryPinMatchesExpected',
  'providerCreationFlagExactlyTrue', 'providerCreationEnabledForExpectedPin',
  'providerCreationEnabledWithoutAccount', 'providerCreationEnabledForSyntheticAccount',
  'identityProviderEnabled', 'identityAssetPrivacyConfirmed', 'identityProviderPinMatchesCanaryPin',
  'hostedSubjectConsentEnabled', 'billingDisabled', 'durableRenderDisabled',
  'standardRenderDisabled', 'scriptedPhotoDisabled', 'phoneEnrollmentDisabled',
  'phoneExtractionDisabled', 'maintenanceAdmissionActive', 'canaryScopeAsExpected',
]);

const failure = (status, code) => ({ status, body: { ok: false, code } });

export function createCanaryScopeState() {
  let windowKey;
  const nonces = new Set();
  const rateLimit = createDiagnosticLimiter();
  return {
    rateLimit,
    resetIfWindowChanged(env) {
      const key = `${env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT}|${env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT}`;
      if (key !== windowKey) { windowKey = key; nonces.clear(); rateLimit.clear(); }
    },
    useNonce(value) {
      if (nonces.has(value)) return false;
      if (nonces.size >= 256) nonces.delete(nonces.values().next().value);
      nonces.add(value);
      return true;
    },
    clear() { windowKey = undefined; nonces.clear(); rateLimit.clear(); },
  };
}

const instanceState = createCanaryScopeState();

export async function evaluateCanaryScope({ req, env = process.env, now = Date.now(),
  state = instanceState, providerStatus = providerCreationActivationStatus,
  subjectConsentStatus = providerSubjectConsentActivationStatus,
  compareMac = timingSafeEqual, syntheticAccount = randomUUID } = {}) {
  if (!diagnosticAvailable(req, env, now)) return failure(404, 'diagnostic_unavailable');
  state.resetIfWindowChanged(env);
  if (!isDbBindingOperatorRequest(req, env)) return failure(401, 'operator_required');
  if (!state.rateLimit.consume(env, now)) return failure(429, 'rate_limited');
  const identity = expectedIdentity(req, env);
  if (!identity) return failure(400, 'expected_identity_required');
  const host = diagnosticHost(req, env);
  if (!identity.deploymentMatched || !identity.gitCommitMatched || !identity.projectMatched
    || identity.targetManifest !== REVIEWED_TARGET_FILE_SHA256
    || diagnosticDigest(JSON.stringify(target)) !== REVIEWED_TARGET_OBJECT_SHA256) {
    return { status: 409, body: { ok: false, ...Object.fromEntries(BOOLEAN_FIELDS.map((key) => [key, false])), observedAtUtc: new Date(now).toISOString() } };
  }
  const nonce = String(req.headers['x-canary-nonce'] || '');
  const issuedAt = String(req.headers['x-canary-issued-at'] || '');
  const expectedMac = String(req.headers['x-expected-canary-pin-mac'] || '');
  if (!NONCE.test(nonce) || !MAC.test(expectedMac) || !ISSUED_AT.test(issuedAt)
    || !Number.isFinite(Date.parse(issuedAt)) || new Date(issuedAt).toISOString() !== issuedAt) {
    return failure(400, 'nonce_invalid');
  }
  if (Math.abs(now - Date.parse(issuedAt)) > 60_000) return failure(400, 'skew');
  if (!state.useNonce(nonce)) return failure(400, 'nonce_replayed');

  const pin = String(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID || '').trim();
  // The deployment binding is the same VERCEL_DEPLOYMENT_ID used by db-binding.
  const message = `vos-canary-pin/v1|${diagnosticDigest(env.VERCEL_DEPLOYMENT_ID)}|${issuedAt}|${pin}`;
  const actualMac = createHmac('sha256', Buffer.from(nonce, 'hex')).update(message).digest();
  const canaryPinMatchesExpected = Boolean(pin) && compareMac(actualMac, Buffer.from(expectedMac, 'hex'));
  const providerCreationFlagExactlyTrue = diagnosticEnabled(env, 'VIDEO_OS_PROVIDER_CREATION_ENABLED');
  const providerCreationEnabledForExpectedPin = canaryPinMatchesExpected && providerStatus(env, pin).enabled === true;
  const providerCreationEnabledWithoutAccount = providerStatus(env, undefined).enabled === true;
  let syntheticId = syntheticAccount();
  if (syntheticId === pin) syntheticId = randomUUID();
  const providerCreationEnabledForSyntheticAccount = providerStatus(env, syntheticId).enabled === true;
  const body = {
    ok: false,
    deploymentMatched: identity.deploymentMatched,
    gitCommitMatched: identity.gitCommitMatched,
    projectMatched: identity.projectMatched,
    stableAliasHostMatched: host.stableAlias,
    uniqueDeploymentHostMatched: host.uniqueDeployment,
    canaryPinPresent: Boolean(pin),
    canaryPinMatchesExpected,
    providerCreationFlagExactlyTrue,
    providerCreationEnabledForExpectedPin,
    providerCreationEnabledWithoutAccount,
    providerCreationEnabledForSyntheticAccount,
    identityProviderEnabled: diagnosticEnabled(env, 'VIDEO_OS_IDENTITY_PROVIDER_ENABLED'),
    identityAssetPrivacyConfirmed: diagnosticEnabled(env, 'HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED'),
    identityProviderPinMatchesCanaryPin: Boolean(pin) && timingSafeMatch(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID, pin),
    hostedSubjectConsentEnabled: subjectConsentStatus(env).enabled === true,
    billingDisabled: !diagnosticEnabled(env, 'VIDEO_OS_BILLING_ENABLED'),
    durableRenderDisabled: !diagnosticEnabled(env, 'VIDEO_OS_DURABLE_WORKFLOW_ENABLED'),
    standardRenderDisabled: !diagnosticEnabled(env, 'VIDEO_OS_STANDARD_RENDER_ENABLED'),
    scriptedPhotoDisabled: !diagnosticEnabled(env, 'VIDEO_OS_SCRIPTED_PHOTO_ENABLED'),
    phoneEnrollmentDisabled: !diagnosticEnabled(env, 'VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED'),
    phoneExtractionDisabled: !diagnosticEnabled(env, 'VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED'),
    maintenanceAdmissionActive: diagnosticMaintenanceMode(env) === 'active',
    canaryScopeAsExpected: false,
    observedAtUtc: new Date(now).toISOString(),
  };
  body.canaryScopeAsExpected = body.canaryPinPresent && body.canaryPinMatchesExpected
    && body.providerCreationFlagExactlyTrue && body.providerCreationEnabledForExpectedPin
    && !body.providerCreationEnabledWithoutAccount && !body.providerCreationEnabledForSyntheticAccount
    && body.identityProviderEnabled && body.identityAssetPrivacyConfirmed
    && body.identityProviderPinMatchesCanaryPin && body.hostedSubjectConsentEnabled
    && body.billingDisabled && body.durableRenderDisabled && body.standardRenderDisabled
    && body.scriptedPhotoDisabled && body.phoneEnrollmentDisabled && body.phoneExtractionDisabled
    && body.maintenanceAdmissionActive;
  body.ok = body.canaryScopeAsExpected;
  return { status: body.ok ? 200 : 409, body };
}

export async function handleCanaryScopeDiagnostic(req, res, options = {}) {
  const audit = options.audit || auditOperatorDiagnostic;
  let result;
  try { result = await evaluateCanaryScope({ req, ...options }); }
  catch { result = failure(503, 'diagnostic_unavailable'); }
  await audit('admin.canary_scope.checked', diagnosticAuditDetails(result.body));
  diagnosticResponse(res, result.status, result.body);
}
