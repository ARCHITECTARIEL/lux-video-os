import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { canonicalJsonBytes } from './heygen-reconciliation-contract.js';
import { assertQualifiedHeygenCredential } from '../services/heygen-account-qualification.js';
import { readHeygenSpaceMarkerAsset } from '../services/heygen-space-marker.js';

const VERSION = 'heygen-space-marker/v1';
const PINNED_MANIFEST_SHA256 = 'cb92a6120f0a8b5e69b74e835e90fae8e12b44d1323863ecd33eb59f31e1dc1f';
const ASSET_ID_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_SPACE_MARKER_ASSET\0V1\0', 'utf8');
const USERNAME_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_PROFILE_USERNAME\0V1\0', 'utf8');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const BUNDLED = new URL(import.meta.url).pathname.endsWith('/index.js');
const MANIFEST_URL = BUNDLED
  ? new URL('./runtime-repository/config/heygen-space-marker.json', import.meta.url)
  : new URL('../config/heygen-space-marker.json', import.meta.url);
const MARKER_KEYS = [
  'assetIdDigest', 'fixtureSha256', 'expectedType', 'uploadedAt', 'credentialKeyFingerprint',
  'credentialScopeFingerprint', 'keyIdDigest', 'keyCreatedAt', 'usernameDigest',
  'providerSpaceFingerprint', 'canonicalScopeKey', 'originIdentityDigest',
  'originSpaceObservedAt', 'uploadReceiptSha256', 'readReceiptSha256',
];
const REVIEWED = new WeakSet();
const OBSERVED = new WeakSet();

function fail(code) {
  throw Object.assign(new Error('HeyGen space marker evidence failed closed.'), { code, failureCategory: code, statusCode: 409 });
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  if (!record(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('HEYGEN_SPACE_MARKER_INVALID');
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function exactId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value) || value === '.' || value === '..') {
    fail('HEYGEN_SPACE_MARKER_ID_INVALID');
  }
  return value;
}
function exactIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('HEYGEN_SPACE_MARKER_INVALID');
  }
  return value;
}
function freeze(value) {
  if (record(value)) for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

export function heygenSpaceMarkerAssetIdDigest(assetId) {
  return digest(Buffer.concat([ASSET_ID_DOMAIN, Buffer.from(exactId(assetId), 'utf8')]));
}

export function assertConfiguredHeygenSpaceMarker(manifest, env = process.env) {
  if (!REVIEWED.has(manifest)) fail('HEYGEN_SPACE_MARKER_UNREVIEWED');
  const assetId = exactId(env?.HEYGEN_SPACE_MARKER_ASSET_ID);
  if (heygenSpaceMarkerAssetIdDigest(assetId) !== manifest.assetIdDigest) fail('HEYGEN_SPACE_MARKER_ID_MISMATCH');
  return assetId;
}

function validate(document, origin) {
  exact(document, ['version', 'marker']);
  if (document.version !== VERSION) fail('HEYGEN_SPACE_MARKER_INVALID');
  if (document.marker === null) return null;
  const marker = document.marker;
  exact(marker, MARKER_KEYS);
  for (const key of MARKER_KEYS.filter(key => key.endsWith('Digest') || key.endsWith('Sha256') || key.endsWith('Fingerprint'))) {
    if (!HASH.test(marker[key])) fail('HEYGEN_SPACE_MARKER_INVALID');
  }
  exactIso(marker.keyCreatedAt);
  exactIso(marker.originSpaceObservedAt);
  if (marker.expectedType !== 'image' || !Number.isSafeInteger(marker.uploadedAt) || marker.uploadedAt < 1_000_000_000) {
    fail('HEYGEN_SPACE_MARKER_INVALID');
  }
  if (origin && (marker.fixtureSha256 !== origin.fixtureSha256
    || marker.credentialKeyFingerprint !== origin.credentialKeyFingerprint
    || marker.credentialScopeFingerprint !== origin.credentialScopeFingerprint
    || marker.keyIdDigest !== origin.keyIdDigest || marker.keyCreatedAt !== origin.keyCreatedAt
    || marker.usernameDigest !== origin.usernameDigest
    || marker.providerSpaceFingerprint !== origin.providerSpaceFingerprint
    || marker.canonicalScopeKey !== origin.canonicalScopeKey
    || marker.originIdentityDigest !== origin.identityDigest
    || marker.originSpaceObservedAt !== origin.spaceObservedAt)) {
    fail('HEYGEN_SPACE_MARKER_IDENTITY_MISMATCH');
  }
  return marker;
}

export async function loadPinnedHeygenSpaceMarkerManifest(origin = null) {
  let handle;
  try {
    const info = await lstat(MANIFEST_URL);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768) fail('HEYGEN_SPACE_MARKER_INVALID');
    handle = await open(MANIFEST_URL, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail('HEYGEN_SPACE_MARKER_INVALID');
    const document = JSON.parse(bytes.toString('utf8'));
    const manifestSha256 = digest(canonicalJsonBytes(document));
    if (manifestSha256 !== PINNED_MANIFEST_SHA256) fail('HEYGEN_SPACE_MARKER_UNREVIEWED');
    const marker = validate(document, origin);
    if (marker === null) return null;
    const reviewed = freeze({ ...marker, manifestSha256 });
    REVIEWED.add(reviewed);
    return reviewed;
  } catch (error) {
    if (String(error?.code || '').startsWith('HEYGEN_SPACE_MARKER_')) throw error;
    fail('HEYGEN_SPACE_MARKER_UNAVAILABLE');
  } finally { await handle?.close(); }
}

export async function observePinnedHeygenSpaceMarker({ origin, manifest, qualification, apiKey, markerAssetId, now, fetchImpl }) {
  if (!REVIEWED.has(manifest)) fail('HEYGEN_SPACE_MARKER_UNREVIEWED');
  validate({ version: VERSION, marker: Object.fromEntries(MARKER_KEYS.map(key => [key, manifest[key]])) }, origin);
  const assetId = assertConfiguredHeygenSpaceMarker(manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: markerAssetId });
  assertQualifiedHeygenCredential(qualification);
  const username = qualification?.privateEvidence?.profile?.username;
  if (typeof username !== 'string' || !username || digest(Buffer.concat([USERNAME_DOMAIN, Buffer.from(username, 'utf8')])) !== origin.usernameDigest
    || qualification.credentialKeyFingerprint !== origin.credentialKeyFingerprint
    || qualification.credentialScopeFingerprint !== origin.credentialScopeFingerprint
    || qualification.privateEvidence.keyIdDigest !== origin.keyIdDigest
    || qualification.privateEvidence.createdAt !== origin.keyCreatedAt) {
    fail('HEYGEN_SPACE_MARKER_IDENTITY_MISMATCH');
  }
  const observation = await readHeygenSpaceMarkerAsset({ apiKey, assetId, ...(now ? { now } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
  const providerSpaceFingerprint = digest(Buffer.from(JSON.stringify({ provider: 'heygen', scopeType: 'space', spaceId: observation.spaceId }), 'utf8'));
  if (observation.id !== assetId || observation.owner !== username || observation.type !== manifest.expectedType
    || observation.uploadedAt !== manifest.uploadedAt || providerSpaceFingerprint !== origin.providerSpaceFingerprint) {
    fail('HEYGEN_SPACE_MARKER_IDENTITY_MISMATCH');
  }
  exactIso(observation.observedAt);
  const freshnessEvidenceSha256 = digest(canonicalJsonBytes({
    version: 'heygen-space-marker-observation/v1', markerManifestSha256: manifest.manifestSha256,
    assetIdDigest: manifest.assetIdDigest, ownerDigest: origin.usernameDigest,
    providerSpaceFingerprint, type: observation.type, uploadedAt: observation.uploadedAt,
    observedAt: observation.observedAt,
  }));
  const reviewedObservation = freeze({ observedAt: observation.observedAt, freshnessEvidenceSha256 });
  OBSERVED.add(reviewedObservation);
  return reviewedObservation;
}

export function assertObservedHeygenSpaceMarker(observation) {
  if (!OBSERVED.has(observation)) fail('HEYGEN_SPACE_MARKER_UNVERIFIED');
  return observation;
}

export function reviewMarkerObservationForTests(observation) {
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) fail('HEYGEN_SPACE_MARKER_TEST_ONLY');
  if (!record(observation) || Object.keys(observation).sort().join('\0') !== ['observedAt', 'freshnessEvidenceSha256'].sort().join('\0')
    || !HASH.test(observation.freshnessEvidenceSha256)) fail('HEYGEN_SPACE_MARKER_INVALID');
  exactIso(observation.observedAt);
  const reviewed = freeze({ ...observation });
  OBSERVED.add(reviewed);
  return reviewed;
}

export function reviewHeygenSpaceMarkerForTests(document, origin) {
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) fail('HEYGEN_SPACE_MARKER_TEST_ONLY');
  const marker = validate(document, origin);
  if (marker === null) return null;
  const reviewed = freeze({ ...marker, manifestSha256: digest(canonicalJsonBytes(document)) });
  REVIEWED.add(reviewed);
  return reviewed;
}
