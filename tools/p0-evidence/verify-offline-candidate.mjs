import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectMedia } from '../../services/final-media-validation.js';
import {
  evaluateP0EvidenceBundle,
  P0_EVIDENCE_CANDIDATE_VERSION,
  P0EvidenceError,
} from './contract.mjs';
import { assertNoSensitiveMaterial, exactKeys, HASH_256, sha256 } from './schema.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

function fail(code, message) {
  throw new P0EvidenceError(code, message);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) {
    fail('UNSAFE_PATH', label + ' path is invalid.');
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('UNSAFE_PATH', label + ' path is invalid.');
  }
  return normalized;
}

async function regularFileWithin(root, relative, label, maxBytes) {
  const safe = safeRelativePath(relative, label);
  const candidate = path.resolve(root, safe);
  const relation = path.relative(root, candidate);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    fail('UNSAFE_PATH', label + ' escapes the run directory.');
  }
  const info = await lstat(candidate).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    fail('UNSAFE_FILE', label + ' is missing or is not a regular file.');
  }
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > maxBytes) {
    fail('FILE_SIZE_INVALID', label + ' has an invalid size.');
  }
  const resolved = await realpath(candidate);
  const resolvedRelation = path.relative(root, resolved);
  if (!resolvedRelation || resolvedRelation.startsWith('..') || path.isAbsolute(resolvedRelation)) {
    fail('UNSAFE_PATH', label + ' resolves outside the run directory.');
  }
  return { path: candidate, info };
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(root, descriptor, label) {
  if (!descriptor || !HASH_256.test(String(descriptor.sha256 || ''))) {
    fail('INVALID_DIGEST', label + ' digest is invalid.');
  }
  const file = await regularFileWithin(root, descriptor.path, label, MAX_JSON_BYTES);
  const bytes = await readFile(file.path);
  if (sha256(bytes) !== descriptor.sha256) fail('EVIDENCE_HASH_MISMATCH', label + ' digest does not match.');
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', label + ' is not valid JSON.');
  }
}

function assertManifest(manifest) {
  exactKeys(manifest, ['version', 'proof', 'observations', 'artifacts'], 'manifest');
  assertNoSensitiveMaterial(manifest);
  if (manifest.version !== P0_EVIDENCE_CANDIDATE_VERSION) fail('VERSION_MISMATCH', 'Candidate version is unsupported.');
  if (!Array.isArray(manifest.observations) || manifest.observations.length !== 9) {
    fail('OBSERVATION_SET_MISMATCH', 'Manifest must name exactly nine observations.');
  }
  exactKeys(manifest.artifacts, ['storedFinal', 'authorizedDownload'], 'manifest artifacts');
}

async function loadArtifact(root, descriptor, label, { stored = false } = {}) {
  exactKeys(descriptor, stored ? ['path', 'sha256', 'bytes', 'directBlobTargetDigest'] : ['path', 'sha256', 'bytes'], label + ' descriptor');
  if (!HASH_256.test(String(descriptor.sha256 || ''))) fail('INVALID_DIGEST', label + ' digest is invalid.');
  if (stored && !HASH_256.test(String(descriptor.directBlobTargetDigest || ''))) fail('INVALID_DIGEST', label + ' target digest is invalid.');
  if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0 || descriptor.bytes > MAX_MEDIA_BYTES) {
    fail('FILE_SIZE_INVALID', label + ' byte count is invalid.');
  }
  const file = await regularFileWithin(root, descriptor.path, label, MAX_MEDIA_BYTES);
  if (file.info.size !== descriptor.bytes) fail('ARTIFACT_BYTES_MISMATCH', label + ' byte count does not match.');
  const fileDigest = await sha256File(file.path);
  if (fileDigest !== descriptor.sha256) fail('ARTIFACT_HASH_MISMATCH', label + ' digest does not match.');
  const inspected = await inspectMedia(file.path);
  if (inspected.sha256 !== fileDigest || inspected.bytes !== file.info.size) {
    fail('ARTIFACT_CHANGED', label + ' changed during media inspection.');
  }
  return {
    file,
    inspected: stored ? { ...inspected, directBlobTargetDigest: descriptor.directBlobTargetDigest } : inspected,
  };
}

export async function verifyOfflineP0Candidate(runDirectory) {
  if (typeof runDirectory !== 'string' || !runDirectory.trim()) {
    fail('RUN_DIRECTORY_REQUIRED', 'A private run directory is required.');
  }
  const root = await realpath(path.resolve(runDirectory)).catch(() => null);
  if (!root) fail('RUN_DIRECTORY_REQUIRED', 'The private run directory is unavailable.');

  const manifestFile = await regularFileWithin(root, 'manifest.json', 'manifest', MAX_JSON_BYTES);
  const manifestBytes = await readFile(manifestFile.path);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', 'manifest.json is not valid JSON.');
  }
  assertManifest(manifest);

  if (manifest.observations.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    fail('OBSERVATION_SET_MISMATCH', 'Manifest observation descriptors are invalid.');
  }
  for (const entry of manifest.observations) exactKeys(entry, ['id', 'path', 'sha256'], 'observation descriptor');
  const descriptors = [...manifest.observations].sort((left, right) => left.id - right.id);
  if (descriptors.some((entry, index) => entry?.id !== index + 1)) {
    fail('OBSERVATION_SET_MISMATCH', 'Manifest observation IDs must be exactly 1 through 9.');
  }
  const observationPaths = descriptors.map((entry) => safeRelativePath(entry.path, 'observation ' + entry.id));
  for (const [index, observationPath] of observationPaths.entries()) {
    const expected = 'observations/' + String(index + 1).padStart(2, '0') + '.json';
    if (observationPath !== expected) fail('NONCANONICAL_EVIDENCE_PATH', 'Observation path does not match the canonical layout.');
  }
  if (new Set(observationPaths).size !== observationPaths.length) {
    fail('OBSERVATION_SET_MISMATCH', 'Observation files must be distinct.');
  }
  const observations = [];
  for (const descriptor of descriptors) {
    const observation = await readJson(root, descriptor, 'observation ' + descriptor.id);
    if (observation?.observation !== descriptor.id) {
      fail('OBSERVATION_SET_MISMATCH', 'Observation file identity mismatch.');
    }
    observations.push(observation);
  }

  const storedDescriptor = manifest.artifacts.storedFinal;
  const downloadDescriptor = manifest.artifacts.authorizedDownload;
  if (safeRelativePath(storedDescriptor?.path, 'stored final') !== 'artifacts/private-stored-final.mp4'
    || safeRelativePath(downloadDescriptor?.path, 'authorized download') !== 'artifacts/authorized-customer-download.mp4') {
    fail('NONCANONICAL_EVIDENCE_PATH', 'Artifact paths do not match the canonical layout.');
  }
  if (safeRelativePath(storedDescriptor?.path, 'stored final') === safeRelativePath(downloadDescriptor?.path, 'authorized download')) {
    fail('ARTIFACT_FILES_NOT_SEPARATE', 'Stored final and download must be separate regular files.');
  }
  const [stored, download] = await Promise.all([
    loadArtifact(root, storedDescriptor, 'stored final', { stored: true }),
    loadArtifact(root, downloadDescriptor, 'authorized download'),
  ]);
  if (stored.file.info.ino !== 0
    && stored.file.info.dev === download.file.info.dev
    && stored.file.info.ino === download.file.info.ino) {
    fail('ARTIFACT_FILES_NOT_SEPARATE', 'Stored final and download are the same filesystem object.');
  }

  const assessment = evaluateP0EvidenceBundle({
    version: manifest.version,
    proof: manifest.proof,
    observations,
  }, {
    stored: stored.inspected,
    download: download.inspected,
  });

  const manifestSha256 = sha256(manifestBytes);
  const candidateSha256 = sha256(Buffer.from(JSON.stringify({
    manifestSha256,
    observations: descriptors.map(({ id, sha256: evidenceSha256 }) => ({ id, evidenceSha256 })),
    artifacts: {
      storedFinal: { sha256: stored.inspected.sha256, bytes: stored.inspected.bytes, directBlobTargetDigest: stored.inspected.directBlobTargetDigest },
      authorizedDownload: { sha256: download.inspected.sha256, bytes: download.inspected.bytes },
    },
  })));
  return Object.freeze({ ...assessment, manifestSha256, candidateSha256 });
}
