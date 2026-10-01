import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  HEYGEN_SPACE_ANCHOR_PATHS,
  HEYGEN_SPACE_ANCHOR_VERSION,
  HEYGEN_SPACE_QUALIFICATION_PROOF_VERSION,
  assertFreshHeygenBootstrapProof,
  assertFreshHeygenSpaceProof,
  assertPinnedHeygenSpaceAnchor,
  assertPinnedHeygenSpaceAnchorProjection,
  assertVerifiedHeygenSpaceAnchor,
  loadPinnedHeygenSpaceAnchorProjection,
  loadVerifiedHeygenSpaceAnchor,
  validateFreshHeygenQualification,
  validateHeygenQualificationSnapshotForTests,
  validateHeygenSpaceEvidenceSnapshotForTests,
  validatePinnedHeygenProbeResultBytesForTests,
  validatePinnedHeygenSpaceManifestBytesForTests,
} from '../lib/heygen-space-anchor.js';

const SPACE_OBSERVED_AT = '2026-10-01T15:11:53.953Z';
const FRESH_NOW = '2026-10-01T16:00:00.000Z';
const USERNAME_DOMAIN = Buffer.from('LUX_VIDEO_OS\0HEYGEN_PROFILE_USERNAME\0V1\0', 'utf8');

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function usernameDigest(value) {
  return createHash('sha256').update(USERNAME_DOMAIN).update(value, 'utf8').digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function syntheticQualification({
  observedAt = '2026-10-01T16:00:00.000Z',
  username = 'synthetic-private-user',
  credentialKeyFingerprint = 'a'.repeat(64),
  credentialScopeFingerprint = 'b'.repeat(64),
  keyIdDigest = 'c'.repeat(64),
  keyCreatedAt = '2026-10-01T14:35:48.000Z',
} = {}) {
  return {
    version: 'heygen-account-qualification/v1',
    observedAt,
    credentialKeyFingerprint,
    credentialScopeFingerprint,
    accountScopeVerified: false,
    bindingEligible: false,
    publicSummary: {
      credentialStatus: 'active',
      scopeMode: 'full',
      expiresAt: null,
      expirationFormat: 'undocumented_null',
      expiresInSeconds: null,
      permissions: {
        account: { read: true },
        assets: { read: true, write: true },
        avatars: { read: true, write: true },
        voices: { read: true, write: true },
        videos: { read: true, write: true },
      },
      profileProbeOutcome: 'OBSERVED',
      accountScopeVerified: false,
      bindingEligible: false,
      holds: [
        { code: 'CREDENTIAL_EXPIRY_FORMAT_UNVERIFIED' },
        { code: 'STABLE_PROVIDER_ACCOUNT_ID_UNAVAILABLE' },
      ],
    },
    privateEvidence: {
      keyId: 'private-key-id',
      keyIdDigest,
      status: 'active',
      scopeMode: 'full',
      scopes: ['*:*'],
      createdAt: keyCreatedAt,
      updatedAt: keyCreatedAt,
      expiresAt: null,
      expiresAtObserved: null,
      expirationFormat: 'undocumented_null',
      expiresInSeconds: null,
      profile: { username, email: 'private@example.test', billingType: 'subscription' },
    },
  };
}

function syntheticAnchorForQualification(qualification) {
  return {
    version: HEYGEN_SPACE_ANCHOR_VERSION,
    verificationMode: 'synthetic-unbranded-test-input',
    evidenceRefVersion: 'heygen-space-anchor-evidence/v1',
    probeResultSha256: 'd'.repeat(64),
    probeResultCanonicalSha256: 'e'.repeat(64),
    credentialKeyFingerprint: qualification.credentialKeyFingerprint,
    credentialScopeFingerprint: qualification.credentialScopeFingerprint,
    keyIdDigest: qualification.privateEvidence.keyIdDigest,
    keyCreatedAt: qualification.privateEvidence.createdAt,
    usernameDigest: usernameDigest(qualification.privateEvidence.profile.username),
    providerSpaceFingerprint: 'f'.repeat(64),
    canonicalScopeKey: '1'.repeat(64),
    preflightEvidenceSha256: '2'.repeat(64),
    spaceProofSha256: '3'.repeat(64),
    identityDigest: '4'.repeat(64),
    spaceObservedAt: SPACE_OBSERVED_AT,
    anchorExpiresAt: '2026-10-02T15:11:53.953Z',
    policy: { freshQualificationMaxAgeSeconds: 60 },
  };
}

test('pinned runtime projection is safe, immutable, distinctly branded, and verification-only', async () => {
  const anchor = await loadPinnedHeygenSpaceAnchorProjection({ now: FRESH_NOW });
  assert.equal(anchor.version, HEYGEN_SPACE_ANCHOR_VERSION);
  assert.equal(anchor.provider, 'heygen');
  assert.equal(anchor.providerNativeScopeType, 'space');
  assert.equal(anchor.globalAccountIdVerified, false);
  assert.equal(anchor.verificationMode, 'pinned_projection');
  assert.equal(anchor.policy.anchorMaxAgeSeconds, 86_400);
  assert.equal(anchor.policy.freshQualificationMaxAgeSeconds, 60);
  assert.equal(anchor.policy.productionReprobePolicy, 'UNSET');
  assert.equal(anchor.policy.productionReprobeMaxAgeSeconds, null);
  assert.equal(Object.isFrozen(anchor), true);
  assert.equal(Object.isFrozen(anchor.policy), true);
  assert.strictEqual(assertPinnedHeygenSpaceAnchor(anchor, { now: FRESH_NOW }), anchor);
  assert.strictEqual(assertPinnedHeygenSpaceAnchorProjection(anchor, { now: FRESH_NOW }), anchor);
  assert.throws(() => assertVerifiedHeygenSpaceAnchor(anchor, { now: FRESH_NOW }), { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' });
  assert.throws(() => { anchor.provider = 'other'; }, TypeError);

  const serialized = JSON.stringify(anchor);
  assert.equal(serialized.includes('@'), false);
  assert.equal(serialized.includes('AppData'), false);
  assert.equal(serialized.includes('private-key-id'), false);
  assert.equal(serialized.includes('synthetic-private-user'), false);
  assert.throws(() => assertPinnedHeygenSpaceAnchor(JSON.parse(serialized), { now: FRESH_NOW }), { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' });
});

test('anchor freshness is future-safe and expires at the exact 24-hour boundary', async () => {
  await assert.rejects(
    loadPinnedHeygenSpaceAnchorProjection({ now: '2026-10-01T15:11:53.952Z' }),
    { code: 'HEYGEN_SPACE_ANCHOR_STALE' },
  );
  await loadPinnedHeygenSpaceAnchorProjection({ now: '2026-10-02T15:11:53.952Z' });
  await assert.rejects(
    loadPinnedHeygenSpaceAnchorProjection({ now: '2026-10-02T15:11:53.953Z' }),
    { code: 'HEYGEN_SPACE_ANCHOR_STALE' },
  );
});

test('reviewed private bundle and runtime manifest project the same safe identity with distinct brands', async (t) => {
  const result = JSON.parse(await readFile(HEYGEN_SPACE_ANCHOR_PATHS.result, 'utf8'));
  try {
    await access(result.privateEvidenceDirectory);
  } catch {
    t.skip('reviewed private evidence bundle is not present on this machine');
    return;
  }
  const privateAnchor = await loadVerifiedHeygenSpaceAnchor({
    privateEvidenceDirectory: result.privateEvidenceDirectory,
    now: FRESH_NOW,
  });
  const projectionAnchor = await loadPinnedHeygenSpaceAnchorProjection({ now: FRESH_NOW });
  for (const field of [
    'probeResultSha256', 'probeResultCanonicalSha256', 'credentialKeyFingerprint', 'credentialScopeFingerprint',
    'keyIdDigest', 'keyCreatedAt', 'usernameDigest', 'providerSpaceFingerprint', 'canonicalScopeKey',
    'preflightEvidenceSha256', 'spaceProofSha256', 'identityDigest', 'spaceObservedAt', 'anchorExpiresAt',
  ]) assert.equal(privateAnchor[field], projectionAnchor[field], field);
  assert.equal(privateAnchor.verificationMode, 'private_evidence_verified');
  assert.equal(projectionAnchor.verificationMode, 'pinned_projection');
  assert.strictEqual(assertVerifiedHeygenSpaceAnchor(privateAnchor, { now: FRESH_NOW }), privateAnchor);
  assert.throws(() => assertVerifiedHeygenSpaceAnchor({ ...privateAnchor }, { now: FRESH_NOW }), { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' });

  const preflight = JSON.parse(await readFile(join(result.privateEvidenceDirectory, 'preflight.json'), 'utf8'));
  const qualification = structuredClone(preflight.qualification);
  qualification.observedAt = FRESH_NOW;
  assert.throws(
    () => validateFreshHeygenQualification(privateAnchor, qualification, { now: FRESH_NOW }),
    { code: 'UNVERIFIED_HEYGEN_QUALIFICATION' },
  );
  assert.throws(
    () => validateFreshHeygenQualification(projectionAnchor, qualification, { now: FRESH_NOW }),
    { code: 'UNVERIFIED_HEYGEN_QUALIFICATION' },
  );
});

test('public manifest and result pins are semantic and portable across LF/CRLF', async () => {
  const manifestBytes = await readFile(HEYGEN_SPACE_ANCHOR_PATHS.manifest);
  const manifestText = manifestBytes.toString('utf8');
  const lfManifest = Buffer.from(manifestText.replace(/\r\n/g, '\n'));
  const crlfManifest = Buffer.from(manifestText.replace(/\r?\n/g, '\r\n'));
  const left = validatePinnedHeygenSpaceManifestBytesForTests(lfManifest);
  const right = validatePinnedHeygenSpaceManifestBytesForTests(crlfManifest);
  assert.equal(left.projection.bindingIdentityDigest, right.projection.bindingIdentityDigest);
  const changedManifest = Buffer.from(manifestText.replace('"providerNativeScopeType": "space"', '"providerNativeScopeType": "spaces"'));
  assert.throws(() => validatePinnedHeygenSpaceManifestBytesForTests(changedManifest), { code: 'HEYGEN_SPACE_ANCHOR_INVALID' });

  const resultBytes = await readFile(HEYGEN_SPACE_ANCHOR_PATHS.result);
  const resultText = resultBytes.toString('utf8');
  const lfResult = await validatePinnedHeygenProbeResultBytesForTests(Buffer.from(resultText.replace(/\r\n/g, '\n')));
  const crlfResult = await validatePinnedHeygenProbeResultBytesForTests(Buffer.from(resultText.replace(/\r?\n/g, '\r\n')));
  assert.deepEqual(lfResult, crlfResult);
  const changedResult = Buffer.from(resultText.replace('"generationCalls": 0', '"generationCalls": 1'));
  await assert.rejects(validatePinnedHeygenProbeResultBytesForTests(changedResult), { code: 'HEYGEN_SPACE_ANCHOR_INVALID' });
});

test('public manifest contains hashes and policy only, with no raw provider or profile authority', async () => {
  const manifest = JSON.parse(await readFile(HEYGEN_SPACE_ANCHOR_PATHS.manifest, 'utf8'));
  const serialized = JSON.stringify(manifest);
  for (const privateMarker of ['ariel', 'gmail', 'AppData', 'C2b1', '@', '://']) {
    assert.equal(serialized.includes(privateMarker), false, `manifest leaked ${privateMarker}`);
  }
  const keys = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) { keys.push(key); visit(nested); }
  };
  visit(manifest);
  for (const privateKey of ['privateEvidenceDirectory', 'spaceId', 'assetId', 'username', 'email', 'apiKey', 'keyId']) {
    assert.equal(keys.includes(privateKey), false, `manifest exposed raw field ${privateKey}`);
  }
  assert.equal(manifest.providerNativeScopeType, 'space');
  assert.equal(manifest.globalAccountIdVerified, false);
  assert.equal(manifest.policy.productionReprobePolicy, 'UNSET');
});

test('qualification snapshot enforces exact identity, null-expiry holds, permissions, and 60-second freshness', async (t) => {
  const qualification = syntheticQualification();
  const anchor = syntheticAnchorForQualification(qualification);
  const proof = validateHeygenQualificationSnapshotForTests(anchor, qualification, { now: qualification.observedAt });
  assert.equal(proof.version, HEYGEN_SPACE_QUALIFICATION_PROOF_VERSION);
  assert.equal(proof.providerNativeScopeType, 'space');
  assert.equal(proof.globalAccountIdVerified, false);
  assert.equal(proof.spaceObservedAt, SPACE_OBSERVED_AT);
  assert.equal(proof.credentialScopeFingerprint, qualification.credentialScopeFingerprint);
  assert.equal(JSON.stringify(proof).includes(qualification.privateEvidence.keyId), false);
  assert.equal(JSON.stringify(proof).includes(qualification.privateEvidence.profile.username), false);
  assert.throws(() => assertFreshHeygenSpaceProof(proof, { now: qualification.observedAt }), { code: 'UNVERIFIED_HEYGEN_SPACE_PROOF' });
  assert.throws(() => assertFreshHeygenBootstrapProof(proof, { now: qualification.observedAt }), { code: 'UNVERIFIED_HEYGEN_SPACE_PROOF' });

  validateHeygenQualificationSnapshotForTests(anchor, qualification, { now: '2026-10-01T16:01:00.000Z' });
  assert.throws(
    () => validateHeygenQualificationSnapshotForTests(anchor, qualification, { now: '2026-10-01T16:01:00.001Z' }),
    { code: 'HEYGEN_QUALIFICATION_STALE' },
  );

  const mutations = [
    ['key fingerprint', (q) => { q.credentialKeyFingerprint = '9'.repeat(64); }],
    ['scope fingerprint', (q) => { q.credentialScopeFingerprint = '8'.repeat(64); }],
    ['key ID digest', (q) => { q.privateEvidence.keyIdDigest = '7'.repeat(64); }],
    ['key created at', (q) => { q.privateEvidence.createdAt = '2026-10-01T14:35:49.000Z'; }],
    ['username', (q) => { q.privateEvidence.profile.username = 'different-private-user'; }],
    ['inactive', (q) => { q.publicSummary.credentialStatus = 'disabled'; }],
    ['not full', (q) => { q.publicSummary.scopeMode = 'custom'; }],
    ['missing permission', (q) => { q.publicSummary.permissions.videos.write = false; }],
    ['expiry timestamp', (q) => { q.publicSummary.expiresAt = '2026-10-02T00:00:00.000Z'; }],
    ['expiry remaining', (q) => { q.privateEvidence.expiresInSeconds = 1; }],
    ['extra hold', (q) => { q.publicSummary.holds.push({ code: 'OTHER' }); }],
    ['hold detail', (q) => { q.publicSummary.holds[0].detail = 'not allowed'; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const candidate = structuredClone(qualification);
      mutate(candidate);
      assert.throws(
        () => validateHeygenQualificationSnapshotForTests(anchor, candidate, { now: qualification.observedAt }),
        { code: 'HEYGEN_QUALIFICATION_MISMATCH' },
      );
    });
  }
});

function buildEvidenceSnapshot() {
  const fixture = Buffer.from('synthetic-neutral-fixture');
  const fixtureSha256 = sha(fixture);
  const assetId = 'synthetic-asset-id';
  const owner = 'synthetic-owner';
  const spaceId = 'synthetic-space-id';
  const providerSpaceFingerprint = sha(Buffer.from(JSON.stringify({ provider: 'heygen', scopeType: 'space', spaceId })));
  const qualification = syntheticQualification({
    observedAt: '2026-10-01T15:00:00.000Z',
    username: owner,
  });
  const objects = {
    'preflight.json': { ownerApproval: 'synthetic test', fixtureSha256, fixtureBytes: fixture.length, qualification },
    'upload.claim.json': { at: '2026-10-01T15:01:00.000Z', fixtureSha256 },
    'upload-response.json': { status: 200, observedAt: '2026-10-01T15:02:00.000Z', data: { asset_id: assetId, mime_type: 'image/png', size_bytes: 95, urlSha256: '5'.repeat(64) }, errorCode: null },
    'read.claim.json': { at: '2026-10-01T15:03:00.000Z', assetIdSha256: sha(Buffer.from(assetId)) },
    'asset-read.json': { status: 200, observedAt: '2026-10-01T15:04:00.000Z', data: { id: assetId, owner, space_id: spaceId, urlSha256: '6'.repeat(64) }, errorCode: null },
    'delete.claim.json': { at: '2026-10-01T15:05:00.000Z', assetIdSha256: sha(Buffer.from(assetId)) },
    'delete-response.json': { status: 200, observedAt: '2026-10-01T15:06:00.000Z', data: { id: assetId }, errorCode: null },
    'readback.claim.json': { at: '2026-10-01T15:07:00.000Z', assetIdSha256: sha(Buffer.from(assetId)) },
    'readback.json': { status: 404, observedAt: '2026-10-01T15:08:00.000Z', errorCode: 'asset_not_found' },
  };
  const uploadResponseBytes = jsonBytes(objects['upload-response.json']);
  objects['asset.json'] = { id: assetId, uploadResponseSha256: sha(uploadResponseBytes) };
  const assetReadBytes = jsonBytes(objects['asset-read.json']);
  objects['space-proof.json'] = {
    ownerMatches: true,
    spaceId,
    providerSpaceFingerprint,
    assetId,
    readReceiptSha256: sha(assetReadBytes),
    contentProof: 'synthetic fixture receipt',
    validationCorrection: 'documented type is separate from identity fields',
    additionalNetworkRequests: 0,
  };
  const journal = [
    { at: '2026-10-01T15:01:00.500Z', stage: 'upload', event: 'before_request', method: 'POST', pathTemplate: '/v3/assets' },
    { at: '2026-10-01T15:04:00.500Z', stage: 'read', event: 'stopped', code: 'ASSET_TYPE_MISMATCH' },
    { at: '2026-10-01T15:05:00.500Z', stage: 'delete', event: 'before_request', method: 'DELETE', pathTemplate: '/v3/assets/{approved_new_id}' },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  const files = new Map();
  for (const [name, value] of Object.entries(objects)) files.set(name, jsonBytes(value));
  files.set('journal.jsonl', Buffer.from(journal));
  files.set('probe.mjs', Buffer.from('// immutable synthetic evidence\n'));
  const descriptors = Object.fromEntries([...files.entries()].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }]));
  const manifest = {
    fixture: { bytes: fixture.length, sha256: fixtureSha256 },
    privateEvidence: { files: descriptors },
    projection: {
      credentialKeyFingerprint: qualification.credentialKeyFingerprint,
      credentialScopeFingerprint: qualification.credentialScopeFingerprint,
      keyIdDigest: qualification.privateEvidence.keyIdDigest,
      keyCreatedAt: qualification.privateEvidence.createdAt,
      usernameDigest: usernameDigest(owner),
      providerSpaceFingerprint,
      spaceObservedAt: objects['asset-read.json'].observedAt,
    },
  };
  const result = { completedAt: '2026-10-01T15:09:00.000Z' };
  return { files, manifest, result };
}

function mutateEvidence(snapshot, file, mutate) {
  const value = JSON.parse(snapshot.files.get(file).toString('utf8'));
  mutate(value);
  const bytes = jsonBytes(value);
  snapshot.files.set(file, bytes);
  snapshot.manifest.privateEvidence.files[file] = { bytes: bytes.length, sha256: sha(bytes) };
}

test('private receipt snapshot validates the complete ID, owner, space, delete, and readback chain', () => {
  const summary = validateHeygenSpaceEvidenceSnapshotForTests(buildEvidenceSnapshot());
  assert.match(summary.assetIdSha256, /^[a-f0-9]{64}$/);
  assert.match(summary.providerSpaceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summary).includes('synthetic-asset-id'), false);
  assert.equal(JSON.stringify(summary).includes('synthetic-owner'), false);
  assert.equal(JSON.stringify(summary).includes('synthetic-space-id'), false);
});

test('every private receipt relationship fails closed when independently changed', async (t) => {
  const mutations = [
    ['preflight fixture', 'preflight.json', (value) => { value.fixtureSha256 = '0'.repeat(64); }],
    ['preflight qualification', 'preflight.json', (value) => { value.qualification.credentialScopeFingerprint = '0'.repeat(64); }],
    ['upload claim', 'upload.claim.json', (value) => { value.fixtureSha256 = '0'.repeat(64); }],
    ['upload status', 'upload-response.json', (value) => { value.status = 201; }],
    ['upload MIME', 'upload-response.json', (value) => { value.data.mime_type = 'text/plain'; }],
    ['asset handle ID', 'asset.json', (value) => { value.id = 'different-id'; }],
    ['asset handle receipt', 'asset.json', (value) => { value.uploadResponseSha256 = '0'.repeat(64); }],
    ['read claim', 'read.claim.json', (value) => { value.assetIdSha256 = '0'.repeat(64); }],
    ['read ID', 'asset-read.json', (value) => { value.data.id = 'different-id'; }],
    ['read owner', 'asset-read.json', (value) => { value.data.owner = 'different-owner'; }],
    ['read space', 'asset-read.json', (value) => { value.data.space_id = 'different-space'; }],
    ['space proof asset', 'space-proof.json', (value) => { value.assetId = 'different-id'; }],
    ['space proof receipt', 'space-proof.json', (value) => { value.readReceiptSha256 = '0'.repeat(64); }],
    ['space proof network count', 'space-proof.json', (value) => { value.additionalNetworkRequests = 1; }],
    ['delete claim', 'delete.claim.json', (value) => { value.assetIdSha256 = '0'.repeat(64); }],
    ['delete ID', 'delete-response.json', (value) => { value.data.id = 'different-id'; }],
    ['readback claim', 'readback.claim.json', (value) => { value.assetIdSha256 = '0'.repeat(64); }],
    ['readback status', 'readback.json', (value) => { value.status = 200; }],
    ['readback code', 'readback.json', (value) => { value.errorCode = 'not_found'; }],
    ['timeline', 'delete.claim.json', (value) => { value.at = '2026-10-01T14:00:00.000Z'; }],
  ];
  for (const [name, file, mutate] of mutations) {
    await t.test(name, () => {
      const snapshot = buildEvidenceSnapshot();
      mutateEvidence(snapshot, file, mutate);
      assert.throws(
        () => validateHeygenSpaceEvidenceSnapshotForTests(snapshot),
        (error) => error.code === 'HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH' || error.code === 'HEYGEN_SPACE_ANCHOR_INVALID',
      );
    });
  }
});

async function createDummyEvidenceDirectory({ extra = false, missing = false } = {}) {
  const manifest = JSON.parse(await readFile(HEYGEN_SPACE_ANCHOR_PATHS.manifest, 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'heygen-space-anchor-test-'));
  const names = Object.keys(manifest.privateEvidence.files);
  for (const name of (missing ? names.slice(1) : names)) {
    await writeFile(join(directory, name), Buffer.alloc(manifest.privateEvidence.files[name].bytes));
  }
  if (extra) await writeFile(join(directory, 'extra.json'), '{}');
  return directory;
}

test('private loader rejects missing, extra, and same-size hash-mismatched evidence', async (t) => {
  for (const [name, options] of [
    ['missing', { missing: true }],
    ['extra', { extra: true }],
    ['hash mismatch', {}],
  ]) {
    await t.test(name, async () => {
      const directory = await createDummyEvidenceDirectory(options);
      try {
        await assert.rejects(
          loadVerifiedHeygenSpaceAnchor({ privateEvidenceDirectory: directory, now: FRESH_NOW }),
          { code: 'HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH' },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('private loader rejects a symlink even when the exact filename allowlist is present', async (t) => {
  const manifest = JSON.parse(await readFile(HEYGEN_SPACE_ANCHOR_PATHS.manifest, 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'heygen-space-anchor-link-test-'));
  const outside = join(dirname(directory), `${directory.split(/[\\/]/).pop()}-outside`);
  try {
    await mkdir(outside);
    for (const name of Object.keys(manifest.privateEvidence.files)) {
      if (name === 'asset-read.json') continue;
      await writeFile(join(directory, name), Buffer.alloc(manifest.privateEvidence.files[name].bytes));
    }
    try {
      await symlink(outside, join(directory, 'asset-read.json'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      loadVerifiedHeygenSpaceAnchor({ privateEvidenceDirectory: directory, now: FRESH_NOW }),
      { code: 'HEYGEN_SPACE_ANCHOR_EVIDENCE_MISMATCH' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('anchor module has no network, database, child-process, or probe execution path', async () => {
  const sourcePath = join(dirname(HEYGEN_SPACE_ANCHOR_PATHS.manifest), '..', 'lib', 'heygen-space-anchor.js');
  const source = await readFile(sourcePath, 'utf8');
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/node:child_process|\bspawn\s*\(|\bexecFile\s*\(/.test(source), false);
  assert.equal(/from ['"]\.\/db|from ['"]\.\.\/db/.test(source), false);
  assert.equal(/import\s*\([^)]*probe\.mjs/.test(source), false);
  assert.equal(source.includes("files.get('probe.mjs')"), false, 'probe source may be hashed but never parsed or executed');
});

test('production validators reject plain anchors, proofs, and caller-selected authority fields', async () => {
  const qualification = syntheticQualification();
  const plainAnchor = syntheticAnchorForQualification(qualification);
  assert.throws(() => assertPinnedHeygenSpaceAnchor(plainAnchor, { now: FRESH_NOW }), { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' });
  assert.throws(
    () => validateFreshHeygenQualification(plainAnchor, qualification, { now: qualification.observedAt }),
    { code: 'UNVERIFIED_HEYGEN_SPACE_ANCHOR' },
  );
  const plainProof = validateHeygenQualificationSnapshotForTests(plainAnchor, qualification, { now: qualification.observedAt });
  assert.throws(() => assertFreshHeygenSpaceProof({ ...plainProof }, { now: qualification.observedAt }), { code: 'UNVERIFIED_HEYGEN_SPACE_PROOF' });
});
