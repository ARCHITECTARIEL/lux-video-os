import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const VERSION = 'heygen-space-refresh/v1';
const POLICY = 'reviewed-neutral-asset-reprobe-24h/v1';
const FILES = ['qualification.json', 'upload.json', 'read.json', 'delete.json', 'readback.json'];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,255}$/;
const IDENTITY = ['credentialKeyFingerprint', 'credentialScopeFingerprint', 'keyIdDigest', 'keyCreatedAt', 'usernameDigest', 'providerSpaceFingerprint', 'canonicalScopeKey'];
const BUNDLED = new URL(import.meta.url).pathname.endsWith('/index.js');
const MANIFEST_URL = BUNDLED
  ? new URL('./runtime-repository/config/heygen-space-refresh.json', import.meta.url)
  : new URL('../config/heygen-space-refresh.json', import.meta.url);
// An observation is accepted only after a source review changes BOTH this pin
// and the public projection. No environment variable or per-request file can
// install authority. The initial pinned document intentionally contains none.
const PINNED_REFRESH_SHA256 = '495d725dc45326e239bdb488ec041d0bf97ef8471f3bf15b4ff7ac3bd2e0764f';

function fail(code = 'HEYGEN_SPACE_REFRESH_INVALID') {
  throw Object.assign(new Error('HeyGen space refresh evidence failed closed.'), { code, failureCategory: code, statusCode: 409 });
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { if (!record(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail(); }
function iso(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(); return Date.parse(value); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail();
}
export function heygenRefreshDigest(value) { return hash(canonical(value)); }
function parse(bytes) { try { const value = JSON.parse(bytes.toString('utf8')); if (!record(value)) fail(); return value; } catch { fail(); } }
function frozen(value) { for (const child of Object.values(value)) if (record(child)) frozen(child); return Object.freeze(value); }

function validateObservation(observation, origin, now) {
  exact(observation, ['policy', 'originIdentityDigest', 'originProbeResultSha256', 'originSpaceObservedAt', ...IDENTITY,
    'spaceObservedAt', 'completedAt', 'expiresAt', 'maxAgeSeconds', 'freshQualificationMaxAgeSeconds', 'fixtureSha256', 'files', 'bundleSha256']);
  if (observation.policy !== POLICY || observation.originIdentityDigest !== origin.identityDigest
    || observation.originProbeResultSha256 !== origin.probeResultSha256
    || observation.originSpaceObservedAt !== origin.spaceObservedAt
    || IDENTITY.some(key => observation[key] !== origin[key])
    || observation.fixtureSha256 !== origin.fixtureSha256
    || observation.maxAgeSeconds !== 86400 || observation.freshQualificationMaxAgeSeconds !== 60) fail('HEYGEN_SPACE_REFRESH_IDENTITY_MISMATCH');
  const observed = iso(observation.spaceObservedAt), completed = iso(observation.completedAt), expiry = iso(observation.expiresAt);
  const current = new Date(now).getTime();
  if (!Number.isFinite(current) || observed <= iso(origin.spaceObservedAt) || completed < observed
    || completed - observed > 60000 || expiry !== observed + 86400000 || current < completed || current >= expiry) fail('HEYGEN_SPACE_REFRESH_STALE');
  exact(observation.files, FILES);
  for (const file of FILES) {
    exact(observation.files[file], ['bytes', 'sha256']);
    if (!Number.isSafeInteger(observation.files[file].bytes) || observation.files[file].bytes < 1
      || observation.files[file].bytes > 131072 || !HASH.test(observation.files[file].sha256)) fail();
  }
  if (observation.bundleSha256 !== heygenRefreshDigest(observation.files)) fail();
  return observation;
}

function apply(document, origin, now) {
  exact(document, ['version', 'observation']);
  if (document.version !== VERSION) fail();
  if (document.observation === null) return origin;
  const observation = validateObservation(document.observation, origin, now);
  return frozen({ ...origin,
    originSpaceObservedAt: origin.spaceObservedAt,
    spaceObservedAt: observation.spaceObservedAt,
    anchorExpiresAt: observation.expiresAt,
    freshnessEvidenceSha256: heygenRefreshDigest(document),
    policy: { ...origin.policy, productionReprobePolicy: POLICY, productionReprobeMaxAgeSeconds: 86400 },
  });
}

export async function loadReviewedHeygenSpaceRefresh(origin, { now = new Date() } = {}) {
  let handle;
  try {
    const info = await lstat(MANIFEST_URL);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) fail();
    handle = await open(MANIFEST_URL, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) fail();
    const document = parse(bytes);
    if (heygenRefreshDigest(document) !== PINNED_REFRESH_SHA256) fail('HEYGEN_SPACE_REFRESH_UNREVIEWED');
    return apply(document, origin, now);
  } catch (error) {
    if (String(error.code).startsWith('HEYGEN_SPACE_REFRESH_')) throw error;
    fail('HEYGEN_SPACE_REFRESH_UNAVAILABLE');
  } finally { await handle?.close(); }
}

// Offline preparation ONLY: validate protected raw observations and emit a
// non-authoritative public candidate. This never installs the pin, writes DB
// state, makes network requests, or extends the currently deployed anchor.
export async function prepareHeygenSpaceRefreshCandidate(directory, origin, qualificationSnapshot, { now = new Date() } = {}) {
  if (!isAbsolute(directory) || resolve(directory) !== await realpath(directory)) fail('HEYGEN_SPACE_REFRESH_DIRECTORY_INVALID');
  const stat = await lstat(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())
    || entries.map(entry => entry.name).sort().join('\0') !== [...FILES].sort().join('\0')) fail('HEYGEN_SPACE_REFRESH_DIRECTORY_INVALID');
  const files = {}, evidence = {};
  for (const name of FILES) {
    const path = resolve(directory, name);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 131072
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) fail();
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) fail();
      files[name] = { bytes: bytes.length, sha256: hash(bytes) };
      evidence[name] = parse(bytes);
    } finally { await handle?.close(); }
  }
  const qualification = evidence['qualification.json'];
  const snapshot = qualificationSnapshot(qualification);
  if (IDENTITY.slice(0, 5).some(key => snapshot[key] !== origin[key])) fail('HEYGEN_SPACE_REFRESH_IDENTITY_MISMATCH');
  const upload = evidence['upload.json'], read = evidence['read.json'], deletion = evidence['delete.json'], readback = evidence['readback.json'];
  for (const [receipt, method, path] of [[upload, 'POST', '/v3/assets'], [read, 'GET', '/v3/assets/{probe_asset_id}'],
    [deletion, 'DELETE', '/v3/assets/{probe_asset_id}'], [readback, 'GET', '/v3/assets/{probe_asset_id}']]) {
    exact(receipt, ['method', 'pathTemplate', 'observedAt', 'status', 'errorCode', 'data', 'assetIdSha256', 'fixtureSha256']);
    if (receipt.method !== method || receipt.pathTemplate !== path || receipt.fixtureSha256 !== origin.fixtureSha256) fail();
  }
  const assetId = upload.data?.asset_id;
  if (typeof assetId !== 'string' || !ID.test(assetId) || upload.status !== 200 || upload.errorCode !== null
    || upload.data?.mime_type !== 'image/png' || upload.data?.size_bytes !== origin.fixtureBytes
    || read.status !== 200 || read.errorCode !== null || read.data?.id !== assetId
    || read.data?.owner !== qualification.privateEvidence?.profile?.username || typeof read.data?.space_id !== 'string'
    || !ID.test(read.data.space_id) || deletion.status !== 200 || deletion.errorCode !== null || deletion.data?.id !== assetId
    || readback.status !== 404 || readback.errorCode !== 'asset_not_found' || readback.data !== null) fail('HEYGEN_SPACE_REFRESH_CHAIN_INVALID');
  const spaceHash = hash(JSON.stringify({ provider: 'heygen', scopeType: 'space', spaceId: read.data.space_id }));
  if (spaceHash !== origin.providerSpaceFingerprint) fail('HEYGEN_SPACE_REFRESH_IDENTITY_MISMATCH');
  if ([upload, read, deletion, readback].some(receipt => receipt.assetIdSha256 !== hash(assetId))) fail('HEYGEN_SPACE_REFRESH_CHAIN_INVALID');
  const times = [snapshot.observedAt, upload.observedAt, read.observedAt, deletion.observedAt, readback.observedAt].map(iso);
  if (times.some((time, i) => i && time < times[i - 1]) || times.at(-1) - times[0] > 60000) fail('HEYGEN_SPACE_REFRESH_STALE');
  const observation = {
    policy: POLICY, originIdentityDigest: origin.identityDigest, originProbeResultSha256: origin.probeResultSha256,
    originSpaceObservedAt: origin.spaceObservedAt, ...Object.fromEntries(IDENTITY.map(key => [key, origin[key]])),
    spaceObservedAt: read.observedAt, completedAt: readback.observedAt,
    expiresAt: new Date(iso(read.observedAt) + 86400000).toISOString(), maxAgeSeconds: 86400,
    freshQualificationMaxAgeSeconds: 60, fixtureSha256: origin.fixtureSha256, files, bundleSha256: heygenRefreshDigest(files),
  };
  validateObservation(observation, origin, now);
  return frozen({ version: VERSION, observation });
}

export function applyHeygenSpaceRefreshForTests(document, origin, now) {
  if (!String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) fail('HEYGEN_SPACE_REFRESH_TEST_ONLY');
  return apply(document, origin, now);
}
