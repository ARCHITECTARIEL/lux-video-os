import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCurrentCandidateCi, computeAuthorizationResult } from '../tools/authorize-release.mjs';

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

test('computeAuthorizationResult never reports releaseAuthorized true under any input', () => {
  for (const ownerAuthorized of [true, false]) {
    const result = computeAuthorizationResult({
      manifest: baseManifest, currentSource: cleanSource, liveOutputSha256: 'outhash',
      freshDatabaseCheck: passingDb, workflowBoundary: passingBoundary, ciResult: passingCi, ownerAuthorized,
    });
    assert.equal(result.releaseAuthorized, false);
  }
});
