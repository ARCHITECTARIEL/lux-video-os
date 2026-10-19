import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCurrentCandidateCi, checkQuarantinedMarkerFiles, checkQuarantinedRefreshFiles, checkQuarantinedSpaceAuthority, computeAuthorizationResult, outputInventory, fingerprint } from '../tools/authorize-release.mjs';
import { heygenSpaceMarkerAssetIdDigest, reviewHeygenSpaceMarkerForTests } from '../lib/heygen-space-marker.js';

const baseManifest = {
  source: { head: 'abc123', sha256: 'srchash', projectLinkSha256: 'linkhash' },
  output: { sha256: 'outhash' },
  database: { migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' },
  remainingReleaseGates: ['OWNER_EXECUTION_AUTHORIZATION', 'PRODUCTION_P0_RECEIPT'],
};
const cleanSource = { head: 'abc123', sha256: 'srchash', projectLinkSha256: 'linkhash', dirty: false };
const passingDb = { ok: true, result: { verified: true, migrationSetSha256: 'm1', schemaSha256: 's1', targetManifestSha256: 't1' } };
const passingBoundary = { verified: true };
const passingCi = { passed: true, detail: { verify: 'success', analyze: 'success' } };

test('checkCurrentCandidateCi requires every named check to succeed', () => {
  const runs = [{ name: 'verify', conclusion: 'success' }, { name: 'analyze', conclusion: 'success' }];
  assert.equal(checkCurrentCandidateCi(runs).passed, true);
});

test('checkCurrentCandidateCi fails if any required check is missing or not successful', () => {
  assert.equal(checkCurrentCandidateCi([{ name: 'verify', conclusion: 'success' }]).passed, false);
  assert.equal(checkCurrentCandidateCi([{ name: 'verify', conclusion: 'failure' }, { name: 'analyze', conclusion: 'success' }]).passed, false);
  assert.equal(checkCurrentCandidateCi([]).passed, false);
});

test('computeAuthorizationResult authorizes a routine deploy only when every automatable check passes and the owner flag is set', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableGatesCleared, true);
  assert.equal(result.routineDeployAuthorized, true);
  assert.equal(result.releaseAuthorized, false, 'must never claim full release authorization');
  assert.deepEqual(result.outstandingLaunchGates, baseManifest.remainingReleaseGates);
});

test('computeAuthorizationResult withholds routine deploy without the explicit owner flag, even if every check passes', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: false,
  });
  assert.equal(result.automatableGatesCleared, true);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when source changed since packaging', () => {
  const driftedSource = { ...cleanSource, head: 'different-head' };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: driftedSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.sourceUnchangedSincePackaging, false);
  assert.equal(result.automatableGatesCleared, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the working tree is dirty', () => {
  const dirtySource = { ...cleanSource, dirty: true };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: dirtySource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.sourceClean, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the quarantined output fingerprint no longer matches', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'tampered-hash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.outputIntegrityIntact, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the fresh production DB check does not verify', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: { ok: false, result: null }, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.databaseVerifiedNow, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the DB identity drifted since packaging despite verifying now', () => {
  const driftedDb = { ok: true, result: { verified: true, migrationSetSha256: 'DIFFERENT', schemaSha256: 's1', targetManifestSha256: 't1' } };
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: driftedDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.databaseVerifiedNow, true);
  assert.equal(result.automatableChecks.databaseUnchangedSincePackaging, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when the Workflow sandbox boundary is unverified', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: { verified: false }, ciResult: passingCi, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.workflowBoundaryVerifiedNow, false);
  assert.equal(result.routineDeployAuthorized, false);
});

test('computeAuthorizationResult fails closed when current-candidate CI has not passed', () => {
  const result = computeAuthorizationResult({
    manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
    freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: { passed: false, detail: { verify: 'pending', analyze: null } }, ownerAuthorized: true,
  });
  assert.equal(result.automatableChecks.currentCandidateCiPassed, false);
  assert.equal(result.routineDeployAuthorized, false);
  assert.deepEqual(result.ciDetail, { verify: 'pending', analyze: null });
});

test('outputInventory records path/bytes/sha256 in that exact key order, matching release-build-manifest.mjs -- regression for a silent fingerprint mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'authorize-release-inventory-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'hello');
    const sub = join(dir, 'nested');
    await import('node:fs/promises').then(fs => fs.mkdir(sub));
    await writeFile(join(sub, 'b.txt'), 'world');
    const records = await outputInventory(dir);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.deepEqual(Object.keys(record), ['path', 'bytes', 'sha256'], 'record key order must match release-build-manifest.mjs exactly, or fingerprint() silently diverges even when every value is identical');
    }
    assert.equal(records[0].path, 'a.txt');
    assert.equal(records[0].bytes, 5);
    assert.equal(records[1].path, 'nested/b.txt');
    // fingerprint() must be a pure function of the exact record shape.
    assert.equal(fingerprint(records), fingerprint(await outputInventory(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeAuthorizationResult never reports releaseAuthorized true under any input', () => {
  for (const ownerAuthorized of [true, false]) {
    const result = computeAuthorizationResult({
      manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
      freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized,
    });
    assert.equal(result.releaseAuthorized, false);
  }
});

test('production authorization requires an artifact-bound refresh with six hours remaining', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-refresh-'));
  const paths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-refresh.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-refresh.json',
  ];
  try {
    const source = await readFile(join(process.cwd(), 'config/heygen-space-refresh.json'));
    const refresh = JSON.parse(source);
    const now = new Date(Date.parse(refresh.observation.completedAt) + 1000);
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), source);
    }
    const valid = await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now });
    assert.equal(valid.verified, true);
    assert.equal(computeAuthorizationResult({ manifest: { ...baseManifest, target: 'production' },
      currentSource: cleanSource, liveOutputSha256: 'outhash', freshDatabaseCheck: passingDb,
      workflowBoundary: passingBoundary, ciResult: passingCi, refreshCheck: valid, ownerAuthorized: true,
    }).routineDeployAuthorized, true);
    const late = await checkQuarantinedRefreshFiles(process.cwd(), candidate, {
      now: new Date(Date.parse(refresh.observation.expiresAt) - 6 * 60 * 60 * 1000 + 1),
    });
    assert.equal(late.verified, false);
    await writeFile(join(candidate, paths[0]), '{}');
    assert.equal((await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now })).verified, false);
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
});

test('retained marker authorization binds both packaged copies and the private asset ID', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'authorize-marker-source-'));
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-marker-output-'));
  const assetId = 'synthetic-marker-id';
  const origin = {
    fixtureSha256: '1'.repeat(64), credentialKeyFingerprint: '2'.repeat(64),
    credentialScopeFingerprint: '3'.repeat(64), keyIdDigest: '4'.repeat(64),
    keyCreatedAt: '2026-10-01T14:35:48.000Z', usernameDigest: '5'.repeat(64),
    providerSpaceFingerprint: '6'.repeat(64), canonicalScopeKey: '7'.repeat(64),
    identityDigest: '8'.repeat(64), spaceObservedAt: '2026-10-01T15:11:53.953Z',
  };
  const document = { version: 'heygen-space-marker/v1', marker: {
    assetIdDigest: heygenSpaceMarkerAssetIdDigest(assetId), fixtureSha256: origin.fixtureSha256,
    expectedType: 'image', uploadedAt: 1_792_400_000,
    credentialKeyFingerprint: origin.credentialKeyFingerprint,
    credentialScopeFingerprint: origin.credentialScopeFingerprint,
    keyIdDigest: origin.keyIdDigest, keyCreatedAt: origin.keyCreatedAt,
    usernameDigest: origin.usernameDigest, providerSpaceFingerprint: origin.providerSpaceFingerprint,
    canonicalScopeKey: origin.canonicalScopeKey, originIdentityDigest: origin.identityDigest,
    originSpaceObservedAt: origin.spaceObservedAt,
    uploadReceiptSha256: '9'.repeat(64), readReceiptSha256: 'a'.repeat(64),
  } };
  const manifest = reviewHeygenSpaceMarkerForTests(document, origin);
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const paths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-marker.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-marker.json',
  ];
  try {
    await mkdir(join(sourceRoot, 'config'));
    await writeFile(join(sourceRoot, 'config/heygen-space-marker.json'), bytes);
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), bytes);
    }
    assert.deepEqual(await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: assetId }),
      { verified: true, mode: 'retained-marker' });
    assert.equal((await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: 'other-id' })).verified, false);
    await writeFile(join(candidate, paths[0]), '{}');
    assert.equal((await checkQuarantinedMarkerFiles(sourceRoot, candidate, manifest, { HEYGEN_SPACE_MARKER_ASSET_ID: assetId })).verified, false);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(candidate, { recursive: true, force: true });
  }
});

test('active source marker never falls back to packaged static refresh evidence', async () => {
  const candidate = await mkdtemp(join(tmpdir(), 'authorize-marker-no-fallback-'));
  try {
    const refresh = await readFile(join(process.cwd(), 'config/heygen-space-refresh.json'));
    const paths = [
      'functions/api/video-os-lite/workspace.func/config/heygen-space-refresh.json',
      'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-refresh.json',
    ];
    for (const path of paths) {
      await mkdir(join(candidate, path, '..'), { recursive: true });
      await writeFile(join(candidate, path), refresh);
    }
    const now = new Date(Date.parse(JSON.parse(refresh).observation.completedAt) + 1000);
    assert.equal((await checkQuarantinedRefreshFiles(process.cwd(), candidate, { now })).verified, true);
    assert.equal((await checkQuarantinedSpaceAuthority(process.cwd(), candidate, { now })).verified, false);
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
});
