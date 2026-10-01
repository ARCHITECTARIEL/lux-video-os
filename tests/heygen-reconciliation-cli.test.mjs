import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  canonicalProviderTargetIdentity,
  databaseBindingSha256,
} from '../lib/provider-reconciliation-target.js';
import {
  createReconciliationPlan,
  redactPlan,
} from '../lib/heygen-reconciliation-contract.js';
import {
  parseCliArguments,
  runCli,
  writePrivatePlanFile,
} from '../tools/reconcile-heygen-enrollment.mjs';

const ACCOUNT_ID = 'account:test-owner';
const ENROLLMENT_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE_KEY = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_SHA = 'a'.repeat(64);
const ADAPTER_SHA = 'b'.repeat(64);
const DATABASE_SHA = 'c'.repeat(64);
const CONNECTION = 'postgresql://test_role:do-not-print@db.example.test:5432/test_db?sslmode=require';
const UNPOOLED = 'postgresql://test_role:do-not-print@db-unpooled.example.test:5432/test_db?sslmode=require';
const EXPIRES_AT = '2026-10-02T12:00:00.000Z';

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    read() { return { stdout, stderr }; },
  };
}

function source(overrides = {}) {
  return {
    head: '1'.repeat(40),
    dirty: true,
    sha256: SOURCE_SHA,
    projectLinkSha256: 'd'.repeat(64),
    project: { id: 'prj_test-app', teamId: 'team_test', name: 'lux-video-os' },
    files: [],
    ...overrides,
  };
}

function snapshot(target) {
  return {
    version: 'heygen-reconciliation-snapshot/v1',
    capturedAt: '2026-09-30T12:00:00.000Z',
    candidate: {
      candidateId: `source:${SOURCE_SHA}`,
      sourceSha256: SOURCE_SHA,
      adapterSha256: ADAPTER_SHA,
    },
    target: {
      environment: 'verification',
      projectId: target.projectId,
      applicationAccountId: ACCOUNT_ID,
      databaseBindingSha256: target.databaseBindingSha256,
      provider: 'heygen',
      providerAccountFingerprint: null,
      providerAccountBindingState: 'provisional',
      credentialScopeFingerprint: null,
      apiVersion: 'v3',
    },
    resources: [{
      resourceKey: RESOURCE_KEY,
      accountId: ACCOUNT_ID,
      kind: 'asset',
      providerResourceId: 'private-provider-asset-id',
      originOperationId: OPERATION_ID,
      state: 'ready',
    }],
    references: [],
    operations: [{
      operationId: OPERATION_ID,
      accountId: ACCOUNT_ID,
      kind: 'asset_upload',
      state: 'succeeded',
      resourceKeys: [RESOURCE_KEY],
    }],
  };
}

function argv(command = 'plan', extras = []) {
  const common = [
    command,
    '--account-id', ACCOUNT_ID,
    '--enrollment-id', ENROLLMENT_ID,
    '--target-manifest', 'config/database-target.verification.json',
    '--environment', 'verification',
  ];
  if (command === 'plan') common.push(
    '--expires-at', EXPIRES_AT,
    '--cohort-id', 'canary-a',
    '--resource-action', `${RESOURCE_KEY}:read,delete,readback`,
  );
  return [...common, ...extras];
}

function dependencies(overrides = {}) {
  const targetManifest = {
    version: 1,
    environment: 'verification',
    projectId: 'neon-project',
    branchId: 'br-test',
    database: 'test_db',
    hosts: ['db.example.test', 'db-unpooled.example.test'],
    roles: ['test_role'],
    port: 5432,
    schemaLock: 'database-schema.lock.json',
  };
  let captures = 0;
  return {
    async captureSourceIdentity() { captures += 1; return source(); },
    async hashFile() { return ADAPTER_SHA; },
    assertUnchangedBuildSource(before, after) {
      assert.equal(before.sha256, after.sha256);
      assert.equal(before.projectLinkSha256, after.projectLinkSha256);
    },
    async loadTargetManifest() {
      return { target: targetManifest, targetManifestSha256: 'e'.repeat(64), targetManifestBinding: 'verification-manifest' };
    },
    async loadSchemaLock() {
      return { schemaLock: { version: 1 }, schemaLockSha256: 'f'.repeat(64), schemaLockBinding: 'verification-schema-lock' };
    },
    validateTarget(connection, target, environment) {
      assert.ok([CONNECTION, UNPOOLED].includes(connection));
      assert.equal(target, targetManifest);
      assert.equal(environment, 'verification');
      return { endpoint: new URL(connection).hostname, port: 5432, database: 'test_db', role: 'test_role', environment };
    },
    runDrizzleCheck() {},
    async checkDatabaseMigrations(connection, options) {
      assert.equal(connection, CONNECTION);
      assert.equal(options.validatedCanonicalTarget.endpoint, 'db.example.test');
      assert.equal(options.validatedUnpooledTarget.endpoint, 'db-unpooled.example.test');
      return { verified: true, scope: 'live-database', journalVerified: true, environment: 'verification' };
    },
    databaseBindingSha256,
    async getProviderReconciliationSnapshot(input) {
      assert.equal(input.accountId, ACCOUNT_ID);
      assert.equal(input.enrollmentId, ENROLLMENT_ID);
      assert.equal(input.candidate.sourceSha256, SOURCE_SHA);
      assert.equal(input.candidate.adapterSha256, ADAPTER_SHA);
      assert.equal(input.target.projectId, 'prj_test-app');
      assert.match(input.target.databaseBindingSha256, /^[a-f0-9]{64}$/);
      return snapshot(input.target);
    },
    async getProviderReconciliationStatus() {
      return {
        version: 'heygen-reconciliation-snapshot/v1',
        capturedAt: '2026-09-30T12:00:00.000Z',
        providerAccountBindingState: 'provisional',
        counts: { resources: 1, references: 0, operations: 1, ambiguousOperations: 0, activeReferences: 0 },
        execution: { enabled: false, reason: 'execution_not_implemented' },
      };
    },
    createReconciliationPlan,
    redactPlan,
    get captures() { return captures; },
    realpath,
    open,
    unlink,
    ...overrides,
  };
}

test('stable database target binding is canonical and excludes connection representation', () => {
  const input = {
    environment: 'verification',
    providerProjectId: 'neon-project',
    providerBranchId: 'br-test',
    databaseName: 'test_db',
    applicationProjectId: 'prj_test-app',
  };
  const canonical = canonicalProviderTargetIdentity(input);
  assert.deepEqual(Object.keys(canonical), [
    'version', 'environment', 'providerProjectId', 'providerBranchId', 'databaseName', 'applicationProjectId',
  ]);
  assert.equal(databaseBindingSha256(input), databaseBindingSha256({ ...input }));
  for (const key of Object.keys(input)) {
    assert.notEqual(databaseBindingSha256(input), databaseBindingSha256({ ...input, [key]: `${input[key]}-other` }));
  }
  assert.throws(() => databaseBindingSha256({ ...input, databaseUrl: CONNECTION }), { code: 'INVALID_PROVIDER_TARGET_BINDING' });
  assert.throws(() => databaseBindingSha256({ ...input, providerProjectId: 'postgresql://user:secret@host/db' }), { code: 'INVALID_PROVIDER_TARGET_BINDING' });
});

test('CLI parser accepts normalized resource UUIDs and rejects provider IDs or implicit plans', () => {
  const parsed = parseCliArguments(argv());
  assert.deepEqual(parsed.requestedActions, [{ resourceKey: RESOURCE_KEY, verbs: ['read', 'delete', 'readback'] }]);
  assert.throws(() => parseCliArguments(argv('plan').filter((value, index, values) => value !== '--resource-action' && values[index - 1] !== '--resource-action')), { code: 'INVALID_RESOURCE_ACTION' });
  const withProviderId = argv().map((value) => value.startsWith(`${RESOURCE_KEY}:`) ? 'provider-asset-id:read' : value);
  assert.throws(() => parseCliArguments(withProviderId), { code: 'INVALID_ARGUMENT' });
});

test('execute and resume hard-deny before dependencies, files, or database access', async () => {
  for (const command of ['execute', 'resume']) {
    let loaded = false;
    const io = streams();
    const outcome = await runCli({
      argv: [command, '--target-manifest', 'does-not-exist'],
      loadDependencies: async () => { loaded = true; throw new Error('must not load'); },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(loaded, false);
    assert.equal(io.read().stdout, '');
    assert.match(io.read().stderr, /EXECUTION_DISABLED/);
  }
  const spawned = spawnSync(process.execPath, [resolve('tools/reconcile-heygen-enrollment.mjs'), 'execute', '--target-manifest', 'does-not-exist'], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'not-a-url', DATABASE_URL_UNPOOLED: '' },
  });
  assert.equal(spawned.status, 2);
  assert.match(spawned.stderr, /EXECUTION_DISABLED/);
  assert.doesNotMatch(spawned.stderr, /does-not-exist|not-a-url/);
});

test('plan runs exact preflight, binds source and adapter, and emits redaction only', async () => {
  const deps = dependencies({
    runDrizzleCheck() { throw new Error('must not inherit child-process stdout'); },
  });
  const io = streams();
  const outcome = await runCli({
    argv: argv(),
    env: { DATABASE_URL: CONNECTION, DATABASE_URL_UNPOOLED: UNPOOLED },
    loadDependencies: async () => deps,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(deps.captures, 2);
  assert.equal(io.read().stderr, '');
  const printed = JSON.parse(io.read().stdout);
  assert.equal(printed.command, 'plan');
  assert.equal(printed.privatePlanWritten, false);
  assert.equal(printed.plan.summary.resourceCount, 1);
  assert.equal(printed.plan.target.providerAccountBindingState, 'provisional');
  assert.doesNotMatch(io.read().stdout, new RegExp(RESOURCE_KEY));
  assert.doesNotMatch(io.read().stdout, /private-provider-asset-id|account:test-owner|prj_test-app|neon-project/);
});

test('status emits only bounded counts and never trusts extra repository fields', async () => {
  const deps = dependencies({
    async getProviderReconciliationStatus() {
      return {
        version: 'heygen-reconciliation-snapshot/v1',
        capturedAt: '2026-09-30T12:00:00.000Z',
        providerAccountBindingState: 'verified',
        counts: { resources: 2, references: 1, operations: 2, ambiguousOperations: 0, activeReferences: 1 },
        execution: { enabled: false, reason: 'execution_not_implemented' },
        providerResourceId: 'must-not-print',
      };
    },
  });
  const io = streams();
  const outcome = await runCli({
    argv: argv('status'),
    env: { DATABASE_URL: CONNECTION, DATABASE_URL_UNPOOLED: UNPOOLED },
    loadDependencies: async () => deps,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(outcome.exitCode, 0);
  const printed = JSON.parse(io.read().stdout);
  assert.deepEqual(printed.status.counts, { resources: 2, references: 1, operations: 2, ambiguousOperations: 0, activeReferences: 1 });
  assert.doesNotMatch(io.read().stdout, /must-not-print|providerResourceId/);
});

test('source drift fails closed before stdout or private plan output', async () => {
  let captures = 0;
  const deps = dependencies({
    async captureSourceIdentity() {
      captures += 1;
      return source(captures === 1 ? {} : { sha256: '9'.repeat(64) });
    },
    assertUnchangedBuildSource(before, after) {
      if (before.sha256 !== after.sha256) throw new Error('changed');
    },
  });
  const io = streams();
  const outcome = await runCli({
    argv: argv(),
    env: { DATABASE_URL: CONNECTION, DATABASE_URL_UNPOOLED: UNPOOLED },
    loadDependencies: async () => deps,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(io.read().stdout, '');
  assert.match(io.read().stderr, /SOURCE_DRIFT/);
});

test('private plan output is outside the repository, exclusive, and never echoed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'heygen-private-plan-'));
  const output = join(directory, 'plan.json');
  const privatePlan = { secretProviderResourceId: 'private-id' };
  try {
    assert.equal(await writePrivatePlanFile(privatePlan, output, { realpath, open, unlink }), true);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), privatePlan);
    await assert.rejects(writePrivatePlanFile(privatePlan, output, { realpath, open, unlink }), { code: 'PRIVATE_PLAN_WRITE_FAILED' });
    const inside = resolve('private-plan-must-not-exist.json');
    await assert.rejects(writePrivatePlanFile(privatePlan, inside, { realpath, open, unlink }), { code: 'PRIVATE_PLAN_PATH_FORBIDDEN' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed private output cleanup unlinks the exact canonical path that was opened', async () => {
  const apparentOutput = join(tmpdir(), 'apparent-private-parent', 'plan.json');
  const canonicalRoot = join(tmpdir(), 'canonical-repository');
  const canonicalParent = join(tmpdir(), 'canonical-private-parent');
  let openedPath;
  let unlinkedPath;
  const fakeHandle = {
    async chmod() {},
    async writeFile() { throw new Error('simulated write failure'); },
    async sync() {},
    async close() {},
  };
  await assert.rejects(writePrivatePlanFile({ private: true }, apparentOutput, {
    async realpath(path) { return path.includes('lux-video-os') ? canonicalRoot : canonicalParent; },
    async open(path, flags, mode) {
      openedPath = path;
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
      return fakeHandle;
    },
    async unlink(path) { unlinkedPath = path; },
  }), { code: 'PRIVATE_PLAN_WRITE_FAILED' });
  assert.equal(openedPath, join(canonicalParent, 'plan.json'));
  assert.equal(unlinkedPath, openedPath);
  assert.notEqual(unlinkedPath, apparentOutput);
});

test('errors never echo database URLs or dependency messages', async () => {
  const io = streams();
  const outcome = await runCli({
    argv: argv('status'),
    env: { DATABASE_URL: CONNECTION, DATABASE_URL_UNPOOLED: UNPOOLED },
    loadDependencies: async () => dependencies({
      async loadTargetManifest() { throw new Error(`secret=${CONNECTION}`); },
    }),
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(io.read().stdout, '');
  assert.match(io.read().stderr, /RECONCILIATION_FAILED/);
  assert.doesNotMatch(io.read().stderr, /do-not-print|secret=/);
});
