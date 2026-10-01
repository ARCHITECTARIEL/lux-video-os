import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { MVP_RELEASE_PROVIDER, providerReleasePosture, workflowBoundary, assertProductionWorkflowBoundary, assertUnchangedBuildSource, assertStableDatabase, rollbackGates, quarantineBuildOutput, assertNoDefaultBuildOutput } from '../tools/release-build-manifest.mjs';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const workflow = classes => ({ version: '1.0.0', workflows: { render: {} }, steps: { render: {} }, classes });

function run(args, extra = {}) {
  return spawnSync(process.execPath, ['tools/build-production.mjs', '--preflight-only', ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', VIDEO_OS_DB_TARGET_MANIFEST: '', ...extra } });
}
test('production build cannot pass without live target verification', () => {
  const result = run([]); assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL_REQUIRED/);
  assert.doesNotMatch(result.stdout + result.stderr, /env pull|Retrieving project/);
});
test('production build rejects the isolated verification manifest before connecting', async () => {
  const expected = createHash('sha256').update(await readFile('config/database-target.verification.json')).digest('hex');
  const result = run([], { DATABASE_URL: 'postgres://neondb_owner:synthetic@ep-lingering-fire-aitvfm3y-pooler.c-4.us-east-1.aws.neon.tech/mvp_verification_20260930', VIDEO_OS_DB_TARGET_MANIFEST: 'config/database-target.verification.json', VIDEO_OS_DB_TARGET_MANIFEST_SHA256: expected });
  assert.equal(result.status, 1); assert.match(result.stderr, /TARGET_ENVIRONMENT_MISMATCH/);
});
test('explicit preview preflight reports snapshot-only scope and no release authority', () => {
  const result = run(['--preview']); assert.equal(result.status, 0);
  assert.match(result.stdout, /"verified":false/); assert.match(result.stdout, /"releaseAuthorized":false/);
});
test('known Sandbox serializer leakage blocks production even if feature selection is off', () => {
  const boundary = workflowBoundary(workflow({ 'node_modules/@vercel/sandbox/dist/sandbox.js': { Sandbox: {} } }));
  assert.equal(boundary.verified, false);
  assert.throws(() => assertProductionWorkflowBoundary(boundary), /unproven/);
  assert.throws(() => assertProductionWorkflowBoundary(undefined));
  assert.doesNotThrow(() => assertProductionWorkflowBoundary(workflowBoundary(workflow({}))));
});

test('incomplete or malformed workflow evidence never clears the boundary', () => {
  for (const value of [undefined, {}, workflow(undefined), workflow(null), workflow([]), { ...workflow({}), version: 'unknown' }, { ...workflow({}), steps: {} }, { ...workflow({}), workflows: [] }]) assert.equal(workflowBoundary(value).verified, false);
});
test('Sandbox evidence in step keys or metadata values also blocks production', () => {
  for (const value of [{ ...workflow({}), steps: { 'node_modules/@vercel/sandbox/dist/sandbox.js': {} } }, { ...workflow({}), metadata: { source: 'node_modules/@vercel/sandbox/dist/sandbox.js' } }]) assert.equal(workflowBoundary(value).verified, false);
});

test('HeyGen MVP release gates require managed-provider evidence instead of a worker image', () => {
  assert.equal(MVP_RELEASE_PROVIDER, 'heygen');
  const posture = providerReleasePosture();
  assert.equal(posture.selectedProvider, 'heygen');
  assert.equal(posture.runtimeClass, 'managed-api');
  assert.equal(posture.workerImageIdentity.applicable, false);
  assert.equal(posture.workerImageIdentity.verified, null);
  assert.equal(posture.remainingReleaseGates.includes('WORKER_IMAGE_IDENTITY_UNVERIFIED'), false);
  for (const gate of [
    'HEYGEN_ONLY_RUNTIME_SCOPE_UNVERIFIED',
    'HEYGEN_ACCOUNT_CAPABILITIES_UNVERIFIED',
    'HEYGEN_PRICING_UNVERIFIED',
    'HEYGEN_PRIVACY_RETENTION_UNVERIFIED',
    'HEYGEN_DELETION_RECONCILIATION_UNVERIFIED',
    'HEYGEN_LIVE_CANARY_UNVERIFIED',
  ]) assert.ok(posture.remainingReleaseGates.includes(gate));
  assert.deepEqual(providerReleasePosture('heygen', { verified: true }).remainingReleaseGates, posture.remainingReleaseGates,
    'an editable claimed-success object cannot clear live provider gates');
});

test('self-hosted and unknown providers remain fail-closed under their own applicability gates', () => {
  const selfHosted = providerReleasePosture('runpod');
  assert.equal(selfHosted.workerImageIdentity.applicable, true);
  assert.deepEqual(selfHosted.remainingReleaseGates, ['WORKER_IMAGE_IDENTITY_UNVERIFIED']);
  assert.deepEqual(providerReleasePosture('unknown').remainingReleaseGates, ['RELEASE_PROVIDER_UNSUPPORTED']);
});

test('rollback metadata and byte attestation remain distinct release gates', () => {
  const baseline = { projectId: 'project', deploymentId: 'dpl_abc', deploymentUrl: 'test.vercel.app', target: 'production', state: 'READY', observedAt: new Date().toISOString(), sourceByteAttestation: false };
  assert.deepEqual(rollbackGates(null, 'project'), ['ROLLBACK_BASELINE_UNVERIFIED']);
  assert.deepEqual(rollbackGates(baseline, 'wrong'), ['ROLLBACK_BASELINE_UNVERIFIED']);
  assert.deepEqual(rollbackGates(baseline, 'project'), ['ROLLBACK_SOURCE_BYTES_UNATTESTED']);
  assert.deepEqual(rollbackGates({ ...baseline, sourceByteAttestation: true }, 'project'), ['ROLLBACK_SOURCE_BYTES_UNATTESTED']);
  assert.deepEqual(rollbackGates({ ...baseline, observedAt: '2020-01-01' }, 'project'), ['ROLLBACK_BASELINE_UNVERIFIED']);
});

test('post-build database proof rejects drift and missing proof', () => {
  const receipt = { verified: true, environment: 'production', migrationSetSha256: 'migration', schemaSha256: 'schema', targetManifestSha256: 'target', identity: { database: 'db' }, validatedConnection: { endpoint: 'host', database: 'db', role: 'user', port: 5432 } };
  assert.doesNotThrow(() => assertStableDatabase(receipt, { ...receipt }));
  for (const field of ['migrationSetSha256', 'schemaSha256', 'targetManifestSha256', 'identity', 'validatedConnection', 'environment', 'verified']) assert.throws(() => assertStableDatabase(receipt, { ...receipt, [field]: 'changed' }));
  assert.throws(() => assertStableDatabase({}, {}));
});

test('failed or review-only output is removed from the default prebuilt path without deleting bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'release-output-'));
  try {
    const output = join(directory, 'output'); await mkdir(output); await writeFile(join(output, 'config.json'), 'proof');
    await assert.rejects(assertNoDefaultBuildOutput(output), /stale default/);
    const moved = await quarantineBuildOutput(output);
    await assertNoDefaultBuildOutput(output);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.equal(await readFile(join(moved, 'config.json'), 'utf8'), 'proof');
    assert.equal(await quarantineBuildOutput(output), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('packaging refuses source, commit or linked-project drift', () => {
  const source = { head: 'commit', sha256: 'source', projectLinkSha256: 'project' };
  assert.doesNotThrow(() => assertUnchangedBuildSource(source, { ...source }));
  for (const field of Object.keys(source)) assert.throws(() => assertUnchangedBuildSource(source, { ...source, [field]: 'changed' }), /changed during packaging/);
});
