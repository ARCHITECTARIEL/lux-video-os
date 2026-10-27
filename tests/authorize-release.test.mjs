import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCurrentCandidateCi, fetchAllCheckRuns, ghApiJson, resolveCurrentCandidateCi, checkQuarantinedMarkerFiles, checkQuarantinedRefreshFiles, checkQuarantinedSpaceAuthority, computeAuthorizationResult, outputInventory, fingerprint } from '../tools/authorize-release.mjs';
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

// --- check-runs pagination (REL-PAGING-1027) ---
function fillerRuns(count, prefix = 'scheduled') {
  return Array.from({ length: count }, (_, i) => ({ id: 10_000 + i, name: `${prefix}-${i}`, status: 'completed', conclusion: 'success', completed_at: '2026-10-20T00:00:00Z' }));
}

function pagedApi(allRuns, { perPageCap = 100, failOnPage = null, totalCount = allRuns.length } = {}) {
  const calls = [];
  const api = async path => {
    calls.push(path);
    const url = new URL(path, 'https://api.invalid/');
    const perPage = Math.min(Number(url.searchParams.get('per_page') || 30), perPageCap);
    const page = Number(url.searchParams.get('page') || 1);
    if (failOnPage === page) throw new Error('GitHub API request failed (exit 1).');
    return { total_count: totalCount, check_runs: allRuns.slice((page - 1) * perPage, page * perPage) };
  };
  return { api, calls };
}

test('fetchAllCheckRuns requests per_page=100 and finds verify on page 2', async () => {
  const runs = [...fillerRuns(100), { id: 2, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T00:00:00Z' }, { id: 3, name: 'analyze', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T00:00:00Z' }];
  const { api, calls } = pagedApi(runs);
  const fetched = await fetchAllCheckRuns({ repo: 'o/r', sha: 'abc', ghApi: api });
  assert.equal(fetched.checkRuns.length, 102);
  assert.equal(fetched.pages, 2);
  assert.deepEqual(calls, ['repos/o/r/commits/abc/check-runs?per_page=100&page=1', 'repos/o/r/commits/abc/check-runs?per_page=100&page=2']);
  // First page alone (the old behavior) would have missed verify.
  assert.equal(checkCurrentCandidateCi(runs.slice(0, 100)).passed, false);
  const result = await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api });
  assert.equal(result.passed, true);
  assert.deepEqual(result.detail, { verify: 'success', analyze: 'success' });
});

test('fetchAllCheckRuns follows more than 100 runs across several pages until total_count', async () => {
  const runs = [...fillerRuns(250), { id: 2, name: 'verify', status: 'completed', conclusion: 'success' }, { id: 3, name: 'analyze', status: 'completed', conclusion: 'success' }];
  const { api, calls } = pagedApi(runs);
  const fetched = await fetchAllCheckRuns({ repo: 'o/r', sha: 'abc', ghApi: api });
  assert.equal(fetched.checkRuns.length, 252);
  assert.equal(fetched.totalCount, 252);
  assert.equal(calls.length, 3);
  assert.equal((await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api })).passed, true);
});

test('fetchAllCheckRuns fails closed when the page cap is hit before total_count', async () => {
  const runs = [...fillerRuns(300), { id: 2, name: 'verify', status: 'completed', conclusion: 'success' }, { id: 3, name: 'analyze', status: 'completed', conclusion: 'success' }];
  const { api, calls } = pagedApi(runs);
  await assert.rejects(fetchAllCheckRuns({ repo: 'o/r', sha: 'abc', ghApi: api, maxPages: 2 }), /page cap/);
  assert.equal(calls.length, 2);
  const result = await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api, maxPages: 2 });
  assert.equal(result.passed, false);
  assert.equal(result.detail, null);
});

test('fetchAllCheckRuns fails closed when pages end before total_count', async () => {
  const runs = [{ id: 2, name: 'verify', status: 'completed', conclusion: 'success' }, { id: 3, name: 'analyze', status: 'completed', conclusion: 'success' }];
  const { api } = pagedApi(runs, { totalCount: 5 });
  await assert.rejects(fetchAllCheckRuns({ repo: 'o/r', sha: 'abc', ghApi: api }), /ended early/);
  assert.equal((await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api })).passed, false);
});

test('checkCurrentCandidateCi uses the latest completed run when a check name repeats', () => {
  const failedThenRerunPassed = [
    { id: 1, name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2026-10-25T10:00:00Z' },
    { id: 5, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T10:00:00Z' },
    { id: 6, name: 'verify', status: 'in_progress', conclusion: null, completed_at: null },
    { id: 2, name: 'analyze', status: 'completed', conclusion: 'success', completed_at: '2026-10-25T10:00:00Z' },
  ];
  assert.deepEqual(checkCurrentCandidateCi(failedThenRerunPassed), { passed: true, detail: { verify: 'success', analyze: 'success' } });

  const passedThenRerunFailed = [
    { id: 9, name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2026-10-27T10:00:00Z' },
    { id: 5, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T10:00:00Z' },
    { id: 2, name: 'analyze', status: 'completed', conclusion: 'success', completed_at: '2026-10-25T10:00:00Z' },
  ];
  assert.deepEqual(checkCurrentCandidateCi(passedThenRerunFailed), { passed: false, detail: { verify: 'failure', analyze: 'success' } });

  // Same completed_at: higher id wins.
  const tie = [
    { id: 7, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T10:00:00Z' },
    { id: 8, name: 'verify', status: 'completed', conclusion: 'cancelled', completed_at: '2026-10-26T10:00:00Z' },
    { id: 2, name: 'analyze', status: 'completed', conclusion: 'success', completed_at: '2026-10-25T10:00:00Z' },
  ];
  assert.equal(checkCurrentCandidateCi(tie).detail.verify, 'cancelled');

  // Only an in-progress run: no completed result, so the gate fails.
  assert.equal(checkCurrentCandidateCi([{ id: 6, name: 'verify', status: 'in_progress', conclusion: null }, { id: 2, name: 'analyze', status: 'completed', conclusion: 'success' }]).passed, false);
});

test('duplicate check names split across pages resolve to the latest completed run', async () => {
  const runs = [
    { id: 50, name: 'verify', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T10:00:00Z' },
    ...fillerRuns(99),
    { id: 3, name: 'verify', status: 'completed', conclusion: 'failure', completed_at: '2026-10-20T10:00:00Z' },
    { id: 4, name: 'analyze', status: 'completed', conclusion: 'success', completed_at: '2026-10-20T10:00:00Z' },
  ];
  const { api } = pagedApi(runs);
  const result = await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api });
  assert.deepEqual(result, { passed: true, detail: { verify: 'success', analyze: 'success' } });
});

test('resolveCurrentCandidateCi fails closed on an API error on any page', async () => {
  const runs = [...fillerRuns(100), { id: 2, name: 'verify', status: 'completed', conclusion: 'success' }, { id: 3, name: 'analyze', status: 'completed', conclusion: 'success' }];
  for (const failOnPage of [1, 2]) {
    const { api } = pagedApi(runs, { failOnPage });
    const result = await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: api });
    assert.equal(result.passed, false);
    assert.equal(result.detail, null);
    assert.match(result.error, /GitHub API request failed/);
  }
});

test('resolveCurrentCandidateCi fails closed on a malformed page', async () => {
  for (const body of [null, {}, { total_count: 2 }, { check_runs: [] }, { total_count: '2', check_runs: [] }]) {
    const result = await resolveCurrentCandidateCi({ repo: 'o/r', sha: 'abc', ghApi: async () => body });
    assert.equal(result.passed, false);
    assert.match(result.error, /Malformed/);
  }
});

test('ghApiJson throws on a non-zero gh exit, spawn error, or non-JSON output without echoing stderr', () => {
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 1, stdout: '', stderr: 'secret-ish detail' }) }), err => /exit 1/.test(err.message) && !/secret-ish/.test(err.message));
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: null, error: new Error('ENOENT') }) }), /exit none/);
  assert.throws(() => ghApiJson('x', { spawn: () => ({ status: 0, stdout: 'not json' }) }), /non-JSON/);
  const calls = [];
  assert.deepEqual(ghApiJson('repos/o/r/commits/abc/check-runs?per_page=100&page=1', { spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '{"total_count":0,"check_runs":[]}' }; } }), { total_count: 0, check_runs: [] });
  assert.deepEqual(calls, [['gh', 'api', 'repos/o/r/commits/abc/check-runs?per_page=100&page=1']]);
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
