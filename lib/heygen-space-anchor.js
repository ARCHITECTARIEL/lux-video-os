import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';

import { loadReviewedHeygenSpaceRefresh, prepareHeygenSpaceRefreshCandidate } from './heygen-space-refresh.js';

import { assertQualifiedHeygenCredential } from '../services/heygen-account-qualification.js';

export const HEYGEN_SPACE_ANCHOR_VERSION = 'heygen-space-anchor/v1';
export const HEYGEN_SPACE_QUALIFICATION_PROOF_VERSION = 'heygen-space-qualification-proof/v1';

const MANIFEST_VERSION = 'heygen-space-anchor-manifest/v1';
const EVIDENCE_REF_VERSION = 'heygen-space-anchor-evidence/v1';
const PINNED_MANIFEST_CANONICAL_SHA256 = '2894510cc13ecfe7542a9beb94935f36336198dbd0c676dd6d3d3b4cfc3b6abb';
const PINNED_RESULT_REVIEWED_SHA256 = '526f2e63e7a2e61e45c4a79f117a7e4d8bdaddfe694ab77f5be852501aa202e6';
const PINNED_RESULT_CANONICAL_SHA256 = 'f036e9b6cb742438f9b81bcaae6ca25c593fec922d8466938d98c30d5e515ddb';
const PINNED_RESULT_RELATIVE_PATH = 'docs/execution-notes/binding-readiness-20261001/provider-space-probe-result.json';
const PINNED_FIXTURE_RELATIVE_PATH = 'docs/execution-notes/binding-readiness-20261001/provider-space-probe.png';
// Literal alternatives keep Vercel file tracing bounded. Workflow rewrites
// import.meta.url to step.func/index.js, whose data is explicitly staged.
const BUNDLED_RUNTIME = new URL(import.meta.url).pathname.endsWith('/index.js');
const MANIFEST_URL = BUNDLED_RUNTIME
  ? new URL('./runtime-repository/config/heygen-space-anchor.json', import.meta.url)
  : new URL('../config/heygen-space-anchor.json', import.meta.url);
const RESULT_URL = BUNDLED_RUNTIME
  ? new URL('./runtime-repository/docs/execution-notes/binding-readiness-20261001/provider-space-probe-result.json', import.meta.url)
  : new URL('../docs/execution-notes/binding-readiness-20261001/provider-space-probe-result.json', import.meta.url);
const FIXTURE_URL = BUNDLED_RUNTIME
  ? new URL('./runtime-repository/docs/execution-notes/binding-readiness-20261001/provider-space-probe.png', import.meta.url)
  : new URL('../docs/execution-notes/binding-readiness-20261001/provider-space-probe.png', import.meta.url);
const USERNAME_DIGEST_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_PROFILE_USERNAME\0V1\0', 'utf8');
const KEY_ID_DIGEST_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_KEY_ID\0V1\0', 'utf8');
const EVIDENCE_BUNDLE_DIGEST_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_SPACE_EVIDENCE_BUNDLE\0V1\0', 'utf8');
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const EVIDENCE_FILES = Object.freeze([
  'asset-read.json',
  'asset.json',
  'delete-response.json',
  'delete.claim.json',
  'journal.jsonl',
  'preflight.json',
  'probe.mjs',
  'read.claim.json',
  'readback.claim.json',
  'readback.json',
  'space-proof.json',
  'upload-response.json',
  'upload.claim.json',
]);
const ALLOWED_QUALIFICATION_HOLDS = Object.freeze([
  'CREDENTIAL_EXPIRY_FORMAT_UNVERIFIED',
  'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE',
]);
const PRIVATE_ANCHORS = new WeakSet();
const PROJECTION_ANCHORS = new WeakSet();
const REPROBE_ORIGINS = new WeakSet();
const PRIVATE_PROOFS = new WeakSet();
const PROJECTION_PROOFS = new WeakSet();
const OWN_ERRORS = new WeakSet();

function fail(code, message, statusCode = 500) {
  const error = Object.assign(new Error(message), { code, failureCategory: code, statusCode });
  OWN_ERRORS.add(error);
  throw error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value, allowed, required, label) {
  if (!isRecord(value)) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} must be an object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} contains an unsupported field.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} is missing a required field.`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'Canonical evidence contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail('HEYGEN_SPACE_ANCHOR_INVALID', 'Canonical evidence contains an unsupported value.');
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function domainDigest(domain, value) {
  return createHash('sha256').update(domain).update(value, 'utf8').digest('hex');
}

function canonicalDigest(value) {
  return sha256(canonicalBytes(value));
}

function exactSha(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} must be a SHA-256 digest.`);
  return value;
}

function exactText(value, label, { max = 255, pattern } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value !== expected) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} is invalid.`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} is invalid.`);
  return date.toISOString();
}

function nowDate(value) {
  const resolved = typeof value === 'function' ? value() : value ?? new Date();
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) fail('HEYGEN_SPACE_ANCHOR_INVALID_OPTIONS', 'The anchor clock is invalid.', 400);
  return date;
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isRecord(value)) fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} must contain a JSON object.`);
    return value;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail('HEYGEN_SPACE_ANCHOR_INVALID', `${label} contains invalid JSON.`);
  }
}

function normalizePathForComparison(value) {
  const normalized = normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertSafePublicManifest(value) {
  const forbiddenKeys = new Set(['apiKey', 'keyId', 'username', 'email', 'spaceId', 'assetId', 'url', 'privateEvidenceDirectory']);
  function visit(item, key = '') {
    if (forbiddenKeys.has(key)) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The public anchor manifest contains a private field.');
    if (typeof item === 'string') {
      if (item.includes('://') || item.includes('@') || /^[A-Za-z]:[\\/]/.test(item)) {
        fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The public anchor manifest contains a private or absolute value.');
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested);
      return;
    }
    if (isRecord(item)) for (const [nestedKey, nested] of Object.entries(item)) visit(nested, nestedKey);
  }
  visit(value);
}

function calculateEvidenceBundleDigest(files) {
  return createHash('sha256')
    .update(EVIDENCE_BUNDLE_DIGEST_DOMAIN)
    .update(canonicalBytes(files))
    .digest('hex');
}

function validateManifestObject(manifest) {
  onlyKeys(manifest,
    ['version', 'provider', 'providerNativeScopeType', 'globalAccountIdVerified', 'probeResult', 'fixture', 'privateEvidence', 'projection', 'policy', 'evidenceRefVersion'],
    ['version', 'provider', 'providerNativeScopeType', 'globalAccountIdVerified', 'probeResult', 'fixture', 'privateEvidence', 'projection', 'policy', 'evidenceRefVersion'],
    'anchor manifest');
  if (manifest.version !== MANIFEST_VERSION || manifest.provider !== 'heygen' || manifest.providerNativeScopeType !== 'space'
    || manifest.globalAccountIdVerified !== false || manifest.evidenceRefVersion !== EVIDENCE_REF_VERSION) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The anchor manifest identity is invalid.');
  }
  onlyKeys(manifest.probeResult, ['path', 'reviewedSourceSha256', 'canonicalJsonSha256'], ['path', 'reviewedSourceSha256', 'canonicalJsonSha256'], 'probe result pin');
  if (manifest.probeResult.path !== PINNED_RESULT_RELATIVE_PATH
    || exactSha(manifest.probeResult.reviewedSourceSha256, 'probe result reviewed digest') !== PINNED_RESULT_REVIEWED_SHA256
    || exactSha(manifest.probeResult.canonicalJsonSha256, 'probe result canonical digest') !== PINNED_RESULT_CANONICAL_SHA256) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The probe result pin is invalid.');
  }
  onlyKeys(manifest.fixture, ['path', 'bytes', 'sha256'], ['path', 'bytes', 'sha256'], 'fixture pin');
  if (manifest.fixture.path !== PINNED_FIXTURE_RELATIVE_PATH || manifest.fixture.bytes !== 95) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The fixture pin is invalid.');
  exactSha(manifest.fixture.sha256, 'fixture digest');

  onlyKeys(manifest.privateEvidence, ['fileCount', 'files', 'bundleDigest'], ['fileCount', 'files', 'bundleDigest'], 'private evidence pin');
  exactInteger(manifest.privateEvidence.fileCount, EVIDENCE_FILES.length, 'private evidence file count');
  onlyKeys(manifest.privateEvidence.files, EVIDENCE_FILES, EVIDENCE_FILES, 'private evidence files');
  for (const name of EVIDENCE_FILES) {
    const descriptor = manifest.privateEvidence.files[name];
    onlyKeys(descriptor, ['bytes', 'sha256'], ['bytes', 'sha256'], 'private evidence descriptor');
    if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 128 * 1024) {
      fail('HEYGEN_SPACE_ANCHOR_INVALID', 'A private evidence size pin is invalid.');
    }
    exactSha(descriptor.sha256, 'private evidence digest');
  }
  exactSha(manifest.privateEvidence.bundleDigest, 'private evidence bundle digest');
  if (calculateEvidenceBundleDigest(manifest.privateEvidence.files) !== manifest.privateEvidence.bundleDigest) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The private evidence bundle digest is invalid.');
  }

  const projectionKeys = [
    'credentialKeyFingerprint', 'credentialScopeFingerprint', 'keyIdDigest', 'keyCreatedAt', 'usernameDigest',
    'providerSpaceFingerprint', 'preflightEvidenceSha256', 'spaceProofSha256', 'canonicalScopeKey',
    'bindingIdentityDigest', 'spaceObservedAt',
  ];
  onlyKeys(manifest.projection, projectionKeys, projectionKeys, 'anchor projection');
  for (const key of projectionKeys.filter((key) => !['keyCreatedAt', 'spaceObservedAt'].includes(key))) exactSha(manifest.projection[key], `projection ${key}`);
  manifest.projection.keyCreatedAt = timestamp(manifest.projection.keyCreatedAt, 'key creation time');
  manifest.projection.spaceObservedAt = timestamp(manifest.projection.spaceObservedAt, 'space observation time');
  if (manifest.projection.preflightEvidenceSha256 !== manifest.privateEvidence.files['preflight.json'].sha256
    || manifest.projection.spaceProofSha256 !== manifest.privateEvidence.files['space-proof.json'].sha256) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The projected evidence digests do not match the evidence manifest.');
  }
  const canonicalScopeKey = canonicalDigest({
    version: 'heygen-provider-scope/v1',
    provider: 'heygen',
    scopeType: 'space',
    providerSpaceFingerprint: manifest.projection.providerSpaceFingerprint,
  });
  if (canonicalScopeKey !== manifest.projection.canonicalScopeKey) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The canonical provider-scope key is invalid.');
  const bindingIdentityDigest = canonicalDigest({
    version: 'heygen-space-binding-identity/v1',
    probeResultSha256: manifest.probeResult.reviewedSourceSha256,
    credentialKeyFingerprint: manifest.projection.credentialKeyFingerprint,
    credentialScopeFingerprint: manifest.projection.credentialScopeFingerprint,
    keyIdDigest: manifest.projection.keyIdDigest,
    keyCreatedAt: manifest.projection.keyCreatedAt,
    usernameDigest: manifest.projection.usernameDigest,
    providerSpaceFingerprint: manifest.projection.providerSpaceFingerprint,
    scopeType: 'space',
  });
  if (bindingIdentityDigest !== manifest.projection.bindingIdentityDigest) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The binding identity digest is invalid.');

  onlyKeys(manifest.policy,
    ['anchorMaxAgeSeconds', 'freshQualificationMaxAgeSeconds', 'productionReprobePolicy', 'productionReprobeMaxAgeSeconds'],
    ['anchorMaxAgeSeconds', 'freshQualificationMaxAgeSeconds', 'productionReprobePolicy', 'productionReprobeMaxAgeSeconds'],
    'anchor policy');
  if (manifest.policy.anchorMaxAgeSeconds !== 86_400 || manifest.policy.freshQualificationMaxAgeSeconds !== 60
    || manifest.policy.productionReprobePolicy !== 'UNSET' || manifest.policy.productionReprobeMaxAgeSeconds !== null) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The anchor policy is invalid.');
  }
  assertSafePublicManifest(manifest);
  return manifest;
}

function validateManifestBytes(bytes) {
  const manifest = parseJson(bytes, 'anchor manifest');
  if (canonicalDigest(manifest) !== PINNED_MANIFEST_CANONICAL_SHA256) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The pinned anchor manifest digest does not match.');
  }
  return validateManifestObject(manifest);
}

async function loadManifest() {
  try {
    return validateManifestBytes(await readFile(MANIFEST_URL));
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_UNAVAILABLE', 'The pinned anchor manifest is unavailable.', 503);
  }
}

function anchorFromManifest(manifest, verificationMode) {
  const observedMs = Date.parse(manifest.projection.spaceObservedAt);
  const anchorExpiresAt = new Date(observedMs + manifest.policy.anchorMaxAgeSeconds * 1_000).toISOString();
  return deepFreeze({
    version: HEYGEN_SPACE_ANCHOR_VERSION,
    manifestVersion: manifest.version,
    evidenceRefVersion: manifest.evidenceRefVersion,
    provider: 'heygen',
    providerNativeScopeType: 'space',
    globalAccountIdVerified: false,
    verificationMode,
    probeResultSha256: manifest.probeResult.reviewedSourceSha256,
    probeResultCanonicalSha256: manifest.probeResult.canonicalJsonSha256,
    fixtureSha256: manifest.fixture.sha256,
    fixtureBytes: manifest.fixture.bytes,
    privateEvidenceBundleDigest: manifest.privateEvidence.bundleDigest,
    credentialKeyFingerprint: manifest.projection.credentialKeyFingerprint,
    credentialScopeFingerprint: manifest.projection.credentialScopeFingerprint,
    keyIdDigest: manifest.projection.keyIdDigest,
    keyCreatedAt: manifest.projection.keyCreatedAt,
    usernameDigest: manifest.projection.usernameDigest,
    providerSpaceFingerprint: manifest.projection.providerSpaceFingerprint,
    canonicalScopeKey: manifest.projection.canonicalScopeKey,
    preflightEvidenceSha256: manifest.projection.preflightEvidenceSha256,
    spaceProofSha256: manifest.projection.spaceProofSha256,
    identityDigest: manifest.projection.bindingIdentityDigest,
    spaceObservedAt: manifest.projection.spaceObservedAt,
    anchorExpiresAt,
    policy: {
      anchorMaxAgeSeconds: manifest.policy.anchorMaxAgeSeconds,
      freshQualificationMaxAgeSeconds: manifest.policy.freshQualificationMaxAgeSeconds,
      productionReprobePolicy: manifest.policy.productionReprobePolicy,
      productionReprobeMaxAgeSeconds: manifest.policy.productionReprobeMaxAgeSeconds,
    },
  });
}

function assertAnchorFresh(anchor, now) {
  const nowMs = nowDate(now).getTime();
  const observedMs = Date.parse(anchor.spaceObservedAt);
  const expiresMs = Date.parse(anchor.anchorExpiresAt);
  if (nowMs < observedMs || nowMs >= expiresMs) fail('HEYGEN_SPACE_ANCHOR_STALE', 'The HeyGen space anchor is outside its verification window.', 409);
  return anchor;
}

export function assertVerifiedHeygenSpaceAnchor(anchor, { now } = {}) {
  if (!anchor || !PRIVATE_ANCHORS.has(anchor)) fail('UNVERIFIED_HEYGEN_SPACE_ANCHOR', 'A private-evidence-verified HeyGen space anchor is required.', 403);
  return assertAnchorFresh(anchor, now);
}

export function assertPinnedHeygenSpaceAnchorProjection(anchor, { now } = {}) {
  if (!anchor || !PROJECTION_ANCHORS.has(anchor)) fail('UNVERIFIED_HEYGEN_SPACE_ANCHOR', 'A pinned HeyGen space projection is required.', 403);
  return assertAnchorFresh(anchor, now);
}

export function assertPinnedHeygenSpaceAnchor(anchor, { now } = {}) {
  if (!anchor || (!PRIVATE_ANCHORS.has(anchor) && !PROJECTION_ANCHORS.has(anchor))) {
    fail('UNVERIFIED_HEYGEN_SPACE_ANCHOR', 'A process-verified HeyGen space anchor is required.', 403);
  }
  return assertAnchorFresh(anchor, now);
}

function requiredPermissions(summary) {
  return summary?.account?.read === true
    && ['assets', 'avatars', 'voices', 'videos'].every((resource) => summary?.[resource]?.read === true && summary?.[resource]?.write === true);
}

function qualificationSnapshot(qualification) {
  if (!isRecord(qualification) || qualification.version !== 'heygen-account-qualification/v1') {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification is invalid.', 409);
  }
  const publicSummary = qualification.publicSummary;
  const privateEvidence = qualification.privateEvidence;
  if (!isRecord(publicSummary) || !isRecord(privateEvidence) || !isRecord(privateEvidence.profile)) {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification evidence is incomplete.', 409);
  }
  const holds = publicSummary.holds;
  if (!Array.isArray(holds) || holds.length !== ALLOWED_QUALIFICATION_HOLDS.length) {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification has an unexpected hold.', 409);
  }
  const holdCodes = holds.map((hold) => {
    if (!isRecord(hold) || Object.keys(hold).length !== 1 || typeof hold.code !== 'string') {
      fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification has an invalid hold.', 409);
    }
    return hold.code;
  }).sort();
  if (holdCodes.join('\0') !== [...ALLOWED_QUALIFICATION_HOLDS].sort().join('\0')) {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification has an unexpected hold.', 409);
  }
  if (qualification.accountScopeVerified !== false || qualification.bindingEligible !== false
    || publicSummary.accountScopeVerified !== false || publicSummary.bindingEligible !== false
    || publicSummary.credentialStatus !== 'active' || publicSummary.scopeMode !== 'full'
    || publicSummary.profileProbeOutcome !== 'OBSERVED' || !requiredPermissions(publicSummary.permissions)
    || publicSummary.expiresAt !== null || publicSummary.expiresInSeconds !== null || publicSummary.expirationFormat !== 'undocumented_null'
    || privateEvidence.status !== 'active' || privateEvidence.scopeMode !== 'full'
    || privateEvidence.expiresAt !== null || privateEvidence.expiresAtObserved !== null
    || privateEvidence.expiresInSeconds !== null || privateEvidence.expirationFormat !== 'undocumented_null'
    || !Array.isArray(privateEvidence.scopes) || privateEvidence.scopes.length !== 1 || privateEvidence.scopes[0] !== '*:*') {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification does not satisfy the pinned credential policy.', 409);
  }
  const username = exactText(privateEvidence.profile.username, 'qualified profile username');
  return {
    observedAt: timestamp(qualification.observedAt, 'qualification observation time'),
    credentialKeyFingerprint: exactSha(qualification.credentialKeyFingerprint, 'credential key fingerprint'),
    credentialScopeFingerprint: exactSha(qualification.credentialScopeFingerprint, 'credential scope fingerprint'),
    keyIdDigest: exactSha(privateEvidence.keyIdDigest, 'credential key ID digest'),
    keyCreatedAt: timestamp(privateEvidence.createdAt, 'credential creation time'),
    usernameDigest: domainDigest(USERNAME_DIGEST_DOMAIN, username),
  };
}

function compareQualification(anchor, qualification, now) {
  const snapshot = qualificationSnapshot(qualification);
  if (snapshot.credentialKeyFingerprint !== anchor.credentialKeyFingerprint
    || snapshot.credentialScopeFingerprint !== anchor.credentialScopeFingerprint
    || snapshot.keyIdDigest !== anchor.keyIdDigest
    || snapshot.keyCreatedAt !== anchor.keyCreatedAt
    || snapshot.usernameDigest !== anchor.usernameDigest) {
    fail('HEYGEN_QUALIFICATION_MISMATCH', 'The current HeyGen qualification does not match the pinned space anchor.', 409);
  }
  const nowMs = nowDate(now).getTime();
  const qualifiedMs = Date.parse(snapshot.observedAt);
  if (qualifiedMs > nowMs || nowMs - qualifiedMs >= anchor.policy.freshQualificationMaxAgeSeconds * 1_000) {
    fail('HEYGEN_QUALIFICATION_STALE', 'The current HeyGen qualification is outside its freshness window.', 409);
  }
  const expiresAt = new Date(qualifiedMs + anchor.policy.freshQualificationMaxAgeSeconds * 1_000).toISOString();
  return deepFreeze({
    version: HEYGEN_SPACE_QUALIFICATION_PROOF_VERSION,
    provider: 'heygen',
    providerNativeScopeType: 'space',
    globalAccountIdVerified: false,
    anchorVerificationMode: anchor.verificationMode,
    evidenceRefVersion: anchor.evidenceRefVersion,
    probeResultSha256: anchor.probeResultSha256,
    probeResultCanonicalSha256: anchor.probeResultCanonicalSha256,
    credentialKeyFingerprint: anchor.credentialKeyFingerprint,
    credentialScopeFingerprint: anchor.credentialScopeFingerprint,
    keyIdDigest: anchor.keyIdDigest,
    keyCreatedAt: anchor.keyCreatedAt,
    usernameDigest: anchor.usernameDigest,
    providerSpaceFingerprint: anchor.providerSpaceFingerprint,
    canonicalScopeKey: anchor.canonicalScopeKey,
    preflightEvidenceSha256: anchor.preflightEvidenceSha256,
    spaceProofSha256: anchor.spaceProofSha256,
    identityDigest: anchor.identityDigest,
    ...(anchor.originSpaceObservedAt ? { originSpaceObservedAt: anchor.originSpaceObservedAt, freshnessEvidenceSha256: anchor.freshnessEvidenceSha256 } : {}),
    spaceObservedAt: anchor.spaceObservedAt,
    qualifiedAt: snapshot.observedAt,
    expiresAt,
    anchorExpiresAt: anchor.anchorExpiresAt,
  });
}

export function validateFreshHeygenQualification(anchor, qualification, { now } = {}) {
  assertPinnedHeygenSpaceAnchor(anchor, { now });
  assertQualifiedHeygenCredential(qualification);
  const proof = compareQualification(anchor, qualification, now);
  if (PRIVATE_ANCHORS.has(anchor)) PRIVATE_PROOFS.add(proof);
  else PROJECTION_PROOFS.add(proof);
  return proof;
}

function assertProofFresh(proof, now) {
  const nowMs = nowDate(now).getTime();
  if (nowMs < Date.parse(proof.qualifiedAt) || nowMs >= Date.parse(proof.expiresAt) || nowMs >= Date.parse(proof.anchorExpiresAt)) {
    fail('HEYGEN_SPACE_PROOF_STALE', 'The HeyGen space qualification proof is stale.', 409);
  }
  return proof;
}

export function assertFreshHeygenSpaceProof(proof, { now } = {}) {
  if (!proof || (!PRIVATE_PROOFS.has(proof) && !PROJECTION_PROOFS.has(proof))) {
    fail('UNVERIFIED_HEYGEN_SPACE_PROOF', 'A process-verified HeyGen space qualification proof is required.', 403);
  }
  return assertProofFresh(proof, now);
}

export function assertFreshHeygenBootstrapProof(proof, { now } = {}) {
  if (!proof || !PRIVATE_PROOFS.has(proof)) {
    fail('UNVERIFIED_HEYGEN_SPACE_PROOF', 'A private-evidence-verified HeyGen bootstrap proof is required.', 403);
  }
  return assertProofFresh(proof, now);
}

function parseEvidenceJson(files, name) {
  return parseJson(files.get(name), `private evidence ${name}`);
}

function validateEvidenceChain(files, manifest, result) {
  const preflight = parseEvidenceJson(files, 'preflight.json');
  const uploadClaim = parseEvidenceJson(files, 'upload.claim.json');
  const uploadResponse = parseEvidenceJson(files, 'upload-response.json');
  const asset = parseEvidenceJson(files, 'asset.json');
  const readClaim = parseEvidenceJson(files, 'read.claim.json');
  const assetRead = parseEvidenceJson(files, 'asset-read.json');
  const spaceProof = parseEvidenceJson(files, 'space-proof.json');
  const deleteClaim = parseEvidenceJson(files, 'delete.claim.json');
  const deleteResponse = parseEvidenceJson(files, 'delete-response.json');
  const readbackClaim = parseEvidenceJson(files, 'readback.claim.json');
  const readback = parseEvidenceJson(files, 'readback.json');

  if (preflight.fixtureSha256 !== manifest.fixture.sha256 || preflight.fixtureBytes !== manifest.fixture.bytes) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe preflight fixture binding is invalid.', 409);
  }
  const qualified = qualificationSnapshot(preflight.qualification);
  if (qualified.credentialKeyFingerprint !== manifest.projection.credentialKeyFingerprint
    || qualified.credentialScopeFingerprint !== manifest.projection.credentialScopeFingerprint
    || qualified.keyIdDigest !== manifest.projection.keyIdDigest
    || qualified.keyCreatedAt !== manifest.projection.keyCreatedAt
    || qualified.usernameDigest !== manifest.projection.usernameDigest) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe preflight credential binding is invalid.', 409);
  }
  if (uploadClaim.fixtureSha256 !== manifest.fixture.sha256 || uploadResponse.status !== 200 || uploadResponse.errorCode !== null
    || !isRecord(uploadResponse.data) || uploadResponse.data.mime_type !== 'image/png' || uploadResponse.data.size_bytes !== 95) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe upload receipt is invalid.', 409);
  }
  const assetId = exactText(uploadResponse.data.asset_id, 'probe asset ID', { pattern: PROVIDER_ID });
  if (asset.id !== assetId || asset.uploadResponseSha256 !== manifest.privateEvidence.files['upload-response.json'].sha256) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe asset handle is invalid.', 409);
  }
  const assetIdSha256 = sha256(Buffer.from(assetId, 'utf8'));
  if (readClaim.assetIdSha256 !== assetIdSha256 || deleteClaim.assetIdSha256 !== assetIdSha256 || readbackClaim.assetIdSha256 !== assetIdSha256) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'A probe resource claim is invalid.', 409);
  }
  if (assetRead.status !== 200 || assetRead.errorCode !== null || !isRecord(assetRead.data) || assetRead.data.id !== assetId
    || assetRead.data.owner !== preflight.qualification.privateEvidence.profile.username) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe asset ownership receipt is invalid.', 409);
  }
  const spaceId = exactText(assetRead.data.space_id, 'probe provider space ID', { pattern: PROVIDER_ID });
  const providerSpaceFingerprint = sha256(Buffer.from(JSON.stringify({ provider: 'heygen', scopeType: 'space', spaceId }), 'utf8'));
  if (spaceProof.assetId !== assetId || spaceProof.spaceId !== spaceId || spaceProof.ownerMatches !== true
    || spaceProof.providerSpaceFingerprint !== providerSpaceFingerprint
    || spaceProof.readReceiptSha256 !== manifest.privateEvidence.files['asset-read.json'].sha256
    || spaceProof.additionalNetworkRequests !== 0
    || typeof spaceProof.contentProof !== 'string' || spaceProof.contentProof.length === 0
    || typeof spaceProof.validationCorrection !== 'string' || spaceProof.validationCorrection.length === 0
    || providerSpaceFingerprint !== manifest.projection.providerSpaceFingerprint) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe provider-space proof is invalid.', 409);
  }
  if (deleteResponse.status !== 200 || deleteResponse.errorCode !== null || !isRecord(deleteResponse.data) || deleteResponse.data.id !== assetId
    || readback.status !== 404 || readback.errorCode !== 'asset_not_found') {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe cleanup chain is invalid.', 409);
  }
  const times = [
    qualified.observedAt, uploadClaim.at, uploadResponse.observedAt, readClaim.at, assetRead.observedAt,
    deleteClaim.at, deleteResponse.observedAt, readbackClaim.at, readback.observedAt, result.completedAt,
  ].map((value) => Date.parse(timestamp(value, 'probe receipt time')));
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] < times[index - 1]) fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe receipt timeline is not monotonic.', 409);
  }
  if (new Date(Date.parse(assetRead.observedAt)).toISOString() !== manifest.projection.spaceObservedAt) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The pinned provider-space observation time is invalid.', 409);
  }
  const journalLines = Buffer.from(files.get('journal.jsonl')).toString('utf8').trimEnd().split(/\r?\n/).map((line) => parseJson(Buffer.from(line), 'probe journal line'));
  if (journalLines.length !== 3
    || journalLines[0].stage !== 'upload' || journalLines[0].event !== 'before_request' || journalLines[0].method !== 'POST' || journalLines[0].pathTemplate !== '/v3/assets'
    || journalLines[1].stage !== 'read' || journalLines[1].event !== 'stopped' || journalLines[1].code !== 'ASSET_TYPE_MISMATCH'
    || journalLines[2].stage !== 'delete' || journalLines[2].event !== 'before_request' || journalLines[2].method !== 'DELETE'
    || journalLines[2].pathTemplate !== '/v3/assets/{approved_new_id}') {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The probe request journal is invalid.', 409);
  }
  return deepFreeze({ credential: qualified, assetIdSha256, providerSpaceFingerprint, spaceObservedAt: manifest.projection.spaceObservedAt });
}

function validateProbeResult(result, manifest) {
  if (result.version !== 'heygen-space-probe-result/v1' || result.status !== 'verified-provider-space-api-cleanup'
    || timestamp(result.completedAt, 'probe completion time') !== '2026-10-01T15:18:03.929Z'
    || result.credentialKeyFingerprint !== manifest.projection.credentialKeyFingerprint
    || result.credentialScopeFingerprint !== manifest.projection.credentialScopeFingerprint) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe result identity is invalid.');
  }
  if (!isRecord(result.fixture) || result.fixture.bytes !== 95 || result.fixture.width !== 32 || result.fixture.height !== 32
    || result.fixture.sha256 !== manifest.fixture.sha256
    || !isRecord(result.providerSpace) || result.providerSpace.verified !== true || result.providerSpace.scopeType !== 'space'
    || result.providerSpace.fingerprint !== manifest.projection.providerSpaceFingerprint
    || result.providerSpace.assetOwnerMatchedAuthenticatedUsername !== true || result.providerSpace.globalAccountIdVerified !== false) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe result scope is invalid.');
  }
  const expectedCalls = { qualificationGets: 2, assetUploads: 1, assetMetadataGets: 1, assetDeletes: 1, assetReadbacks: 1, mutationRetries: 0, generationCalls: 0 };
  for (const [key, expected] of Object.entries(expectedCalls)) if (result.calls?.[key] !== expected) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe call counts are invalid.');
  const expectedResults = {
    uploadStatus: 200, metadataStatus: 200, deleteStatus: 200, readbackStatus: 404,
    readbackCode: 'asset_not_found', apiAbsenceObserved: true, cdnDenialObserved: false,
    backupPurgeVerified: false, chargeMeasured: false,
  };
  for (const [key, expected] of Object.entries(expectedResults)) if (result.results?.[key] !== expected) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe outcomes are invalid.');
  if (result.databaseBindingWritten !== false || result.productionConfigurationChanged !== false || result.deploymentPerformed !== false
    || result.approval?.kind !== 'explicit-conversation-one-off' || result.approval?.reusableWorkerApproval !== false
    || result.approval?.scopeExhausted !== true || !isRecord(result.evidenceSha256)) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe execution boundary is invalid.');
  }
  onlyKeys(result.evidenceSha256, EVIDENCE_FILES, EVIDENCE_FILES, 'probe evidence hashes');
  for (const name of EVIDENCE_FILES) {
    if (result.evidenceSha256[name] !== manifest.privateEvidence.files[name].sha256) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'A reviewed probe evidence digest is invalid.');
  }
  return result;
}

async function readVerifiedPrivateDirectory(directory, manifest) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\u0000')) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID_OPTIONS', 'An absolute private evidence directory is required.', 400);
  }
  const requested = resolve(directory);
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(requested);
    const directoryStat = await lstat(requested);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || normalizePathForComparison(canonicalDirectory) !== normalizePathForComparison(requested)) {
      fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The private evidence directory must be a direct directory without links.', 409);
    }
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_UNAVAILABLE', 'The private evidence directory is unavailable.', 503);
  }
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.join('\0') !== [...EVIDENCE_FILES].sort().join('\0')
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'The private evidence directory does not match the exact file allowlist.', 409);
  }
  const files = new Map();
  for (const name of EVIDENCE_FILES) {
    const filePath = resolve(canonicalDirectory, name);
    let handle;
    try {
      if (normalizePathForComparison(await realpath(filePath)) !== normalizePathForComparison(filePath)) {
        fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'A private evidence file is linked.', 409);
      }
      handle = await open(filePath, fsConstants.O_RDONLY);
      const fileStat = await handle.stat();
      const descriptor = manifest.privateEvidence.files[name];
      if (!fileStat.isFile() || fileStat.size !== descriptor.bytes) fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'A private evidence file size is invalid.', 409);
      const bytes = await handle.readFile();
      if (sha256(bytes) !== descriptor.sha256) fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH', 'A private evidence file digest is invalid.', 409);
      files.set(name, bytes);
    } catch (error) {
      if (OWN_ERRORS.has(error)) throw error;
      fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_UNAVAILABLE', 'A private evidence file is unavailable.', 503);
    } finally {
      try { await handle?.close(); } catch { /* read-only handle cleanup */ }
    }
  }
  return files;
}

async function loadAndValidatePublicEvidence(manifest) {
  const resultBytes = await readFile(RESULT_URL);
  const result = parseJson(resultBytes, 'reviewed probe result');
  if (canonicalDigest(result) !== manifest.probeResult.canonicalJsonSha256) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe result canonical digest does not match.');
  validateProbeResult(result, manifest);
  const fixture = await readFile(FIXTURE_URL);
  if (fixture.length !== manifest.fixture.bytes || sha256(fixture) !== manifest.fixture.sha256) fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The pinned neutral probe fixture does not match.');
  return { result, fixture };
}

export async function loadPinnedHeygenSpaceAnchorProjection({ now } = {}) {
  const manifest = await loadManifest();
  const anchor = await loadReviewedHeygenSpaceRefresh(anchorFromManifest(manifest, 'pinned_projection'), { now: nowDate(now) });
  PROJECTION_ANCHORS.add(anchor);
  return assertPinnedHeygenSpaceAnchorProjection(anchor, { now });
}

export async function loadVerifiedHeygenSpaceAnchor({ privateEvidenceDirectory, now } = {}) {
  try {
    const manifest = await loadManifest();
    const { result } = await loadAndValidatePublicEvidence(manifest);
    const files = await readVerifiedPrivateDirectory(privateEvidenceDirectory, manifest);
    validateEvidenceChain(files, manifest, result);
    const anchor = anchorFromManifest(manifest, 'private_evidence_verified');
    PRIVATE_ANCHORS.add(anchor);
    return assertVerifiedHeygenSpaceAnchor(anchor, { now });
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail('HEYGEN_SPACE_ANCHOR_EVIDENCE_UNAVAILABLE', 'The HeyGen space anchor evidence could not be loaded.', 503);
  }
}

export async function loadPinnedHeygenSpaceAnchor(privateEvidenceDirectory, { now } = {}) {
  return loadVerifiedHeygenSpaceAnchor({ privateEvidenceDirectory, now });
}

// Operator-only origin inspection for a newly approved probe. This intentionally
// permits an expired historical origin but never brands it as runtime authority.
export async function loadHeygenSpaceReprobeOrigin() {
  if (String(process.env.VERCEL_ENV || '').trim().toLowerCase() === 'production') {
    fail('HEYGEN_SPACE_REPROBE_OPERATOR_ONLY', 'A new probe must run outside deployed production.', 403);
  }
  const manifest = await loadManifest();
  await loadAndValidatePublicEvidence(manifest);
  const origin = anchorFromManifest(manifest, 'refresh_review_only');
  REPROBE_ORIGINS.add(origin);
  return origin;
}

export function validateHeygenSpaceReprobeQualification(origin, qualification, { now } = {}) {
  if (String(process.env.VERCEL_ENV || '').trim().toLowerCase() === 'production'
    || !REPROBE_ORIGINS.has(origin)) {
    fail('UNVERIFIED_HEYGEN_REPROBE_ORIGIN', 'A pinned operator-only reprobe origin is required.', 403);
  }
  assertQualifiedHeygenCredential(qualification);
  // compareQualification checks the exact original identity + live 60-second
  // qualification, not the expired observation horizon. Do not register this
  // return value in PRIVATE_PROOFS/PROJECTION_PROOFS: only the completed new
  // observation and separately reviewed source pin can refresh that horizon.
  return compareQualification(origin, qualification, now);
}

export async function prepareReviewedHeygenSpaceRefresh(privateEvidenceDirectory, { now } = {}) {
  const manifest = await loadManifest();
  const origin = anchorFromManifest(manifest, 'refresh_review_only');
  return prepareHeygenSpaceRefreshCandidate(privateEvidenceDirectory, origin, qualificationSnapshot, { now: nowDate(now) });
}

function requireNodeTestContext() {
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
    fail('HEYGEN_SPACE_ANCHOR_TEST_ONLY', 'The anchor snapshot helper is available only to the Node test runner.', 403);
  }
}

export function validateHeygenQualificationSnapshotForTests(anchorProjection, qualification, { now } = {}) {
  requireNodeTestContext();
  const anchor = deepFreeze({ ...anchorProjection, policy: { ...anchorProjection.policy } });
  return compareQualification(anchor, qualification, now);
}

export function validateHeygenSpaceEvidenceSnapshotForTests(snapshot) {
  requireNodeTestContext();
  if (!isRecord(snapshot) || !(snapshot.files instanceof Map) || !isRecord(snapshot.manifest) || !isRecord(snapshot.result)) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The evidence test snapshot is invalid.');
  }
  return validateEvidenceChain(snapshot.files, snapshot.manifest, snapshot.result);
}

export function validatePinnedHeygenSpaceManifestBytesForTests(bytes) {
  requireNodeTestContext();
  return deepFreeze({ ...validateManifestBytes(bytes) });
}

export async function validatePinnedHeygenProbeResultBytesForTests(bytes) {
  requireNodeTestContext();
  const manifest = await loadManifest();
  const result = parseJson(bytes, 'reviewed probe result');
  if (canonicalDigest(result) !== manifest.probeResult.canonicalJsonSha256) {
    fail('HEYGEN_SPACE_ANCHOR_INVALID', 'The reviewed probe result canonical digest does not match.');
  }
  validateProbeResult(result, manifest);
  return deepFreeze({
    version: result.version,
    status: result.status,
    canonicalJsonSha256: manifest.probeResult.canonicalJsonSha256,
  });
}

export const HEYGEN_SPACE_ANCHOR_PATHS = deepFreeze({
  manifest: 'config/heygen-space-anchor.json',
  result: PINNED_RESULT_RELATIVE_PATH,
  fixture: PINNED_FIXTURE_RELATIVE_PATH,
});
