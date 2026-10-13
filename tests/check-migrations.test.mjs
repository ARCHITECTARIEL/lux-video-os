import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateTarget, assertMigrationRows, verifyConnectedDatabase, schemaDigest, migrationPlan, loadTargetManifest, loadSchemaLock } from '../tools/check-migrations.mjs';

const target = { version: 1, environment: 'verification', projectId: 'test-project', branchId: 'br-test', hosts: ['127.0.0.1'], database: 'test_db', roles: ['test_role'], port: 1 };
const url = 'postgresql://test_role:never-print-this-secret@127.0.0.1:1/test_db';
const plan = { migrations: [{ tag: '0000_test', timestamp: '42', hashes: ['a'.repeat(64), 'b'.repeat(64)] }], sha256: 'plan-digest' };
const sourceHashes = { schema: 'source-hash' };
const catalogue = { tables: [{ name: 'users' }], columns: [{ table: 'users', name: 'id', type: 'text' }] };
const lock = { version: 1, migrationSetSha256: plan.sha256, sourceHashes, schemaSha256: schemaDigest(catalogue) };
function client(overrides = {}) {
  return { async query(sql) {
    if (overrides.error) throw overrides.error;
    if (sql.includes('current_database()')) return { rows: [overrides.identity || { database: 'test_db', role: 'test_role' }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: overrides.present !== false }] };
    if (sql.startsWith('select hash')) return { rows: overrides.rows || [{ hash: 'a'.repeat(64), created_at: '42' }] };
    return { rows: [{ catalogue: overrides.catalogue || catalogue }] };
  } };
}
const targetManifestSha256 = 'c'.repeat(64);
const validatedTarget = validateTarget(url, target);
const verify = (overrides = {}, schemaLock = lock) => verifyConnectedDatabase(client(overrides), {
  target, plan, schemaLock, sourceHashes, targetManifestSha256,
  targetManifestBinding: 'verification-manifest', validatedTarget,
  validatedCanonicalTarget: validatedTarget, schemaLockSha256: 'd'.repeat(64),
  schemaLockBinding: 'verification-schema-lock',
});
function run(args, env = {}) {
  return spawnSync(process.execPath, [resolve('tools/check-migrations.mjs'), ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', VIDEO_OS_DB_TARGET_MANIFEST: '', VIDEO_OS_DB_TARGET_MANIFEST_SHA256: '', ...env } });
}

test('missing database URL fails closed in default and strict modes', () => {
  for (const args of [[], ['--strict']]) assert.equal(run(args).status, 1);
});
test('snapshot-only mode is explicit and cannot satisfy strict live verification', () => {
  const result = run(['--snapshot-only']);
  assert.equal(result.status, 0); assert.match(result.stdout, /"liveVerified":false/);
  assert.equal(run(['--snapshot-only', '--strict']).status, 1);
});
test('target manifest is independent of URL and exact on host/database/role/environment', () => {
  assert.equal(validateTarget(url, target).database, 'test_db');
  for (const changed of [{ hosts: ['other.example'] }, { database: 'other' }, { roles: ['other'] }, { port: 5432 }]) {
    assert.throws(() => validateTarget(url, { ...target, ...changed }), { code: 'DATABASE_TARGET_MISMATCH' });
  }
  assert.throws(() => validateTarget(url, null), { code: 'TARGET_MANIFEST_REQUIRED' });
  assert.throws(() => validateTarget(url, target, 'production'), { code: 'TARGET_ENVIRONMENT_MISMATCH' });
  for (const option of ['host=other.example', 'options=endpoint%3Dep-other', 'user=other', 'sslmode=require&sslmode=disable']) assert.throws(() => validateTarget(`${url}?${option}`, target), { code: 'DATABASE_URL_INVALID' });
  assert.throws(() => validateTarget(url, { ...target, environment: 'production' }), { code: 'DATABASE_URL_INVALID' });
});
test('production target manifest must be canonical or match a separately supplied exact SHA-256', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'target-binding-test-'));
  try {
    const manifestPath = join(directory, 'external-production.json');
    const canonicalPath = join(directory, 'canonical-production.json');
    const verificationPath = join(directory, 'verification.json');
    const production = { ...target, environment: 'production' };
    const raw = `${JSON.stringify(production)}\n`;
    const sha256 = createHash('sha256').update(raw).digest('hex');
    writeFileSync(manifestPath, raw);
    writeFileSync(canonicalPath, raw);
    writeFileSync(verificationPath, `${JSON.stringify(target)}\n`);

    await assert.rejects(
      loadTargetManifest(manifestPath, { requiredEnvironment: 'production', canonicalProductionPath: canonicalPath }),
      { code: 'TARGET_MANIFEST_UNBOUND' },
    );
    await assert.rejects(
      loadTargetManifest(manifestPath, { canonicalProductionPath: canonicalPath }),
      { code: 'TARGET_MANIFEST_UNBOUND' },
    );
    await assert.rejects(
      loadTargetManifest(manifestPath, { requiredEnvironment: 'production', canonicalProductionPath: canonicalPath, expectedSha256: '0'.repeat(64) }),
      { code: 'TARGET_MANIFEST_UNBOUND' },
    );
    const external = await loadTargetManifest(manifestPath, { requiredEnvironment: 'production', canonicalProductionPath: canonicalPath, expectedSha256: sha256 });
    assert.equal(external.targetManifestSha256, sha256);
    assert.equal(external.targetManifestBinding, 'trusted-external-manifest-sha256');
    const canonical = await loadTargetManifest(canonicalPath, { requiredEnvironment: 'production', canonicalProductionPath: canonicalPath });
    assert.equal(canonical.targetManifestSha256, sha256);
    assert.equal(canonical.targetManifestBinding, 'canonical-repository-manifest');
    const verification = await loadTargetManifest(verificationPath, { requiredEnvironment: 'verification', canonicalProductionPath: canonicalPath });
    assert.equal(verification.targetManifestBinding, 'verification-manifest');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('production validates canonical DATABASE_URL and optional unpooled URL before any query', () => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-url-test-'));
  try {
    const manifestPath = join(directory, 'production.json');
    const production = { ...target, environment: 'production', schemaLock: 'database-schema.lock.json' };
    const raw = `${JSON.stringify(production)}\n`;
    const sha256 = createHash('sha256').update(raw).digest('hex');
    writeFileSync(manifestPath, raw);
    const args = ['--strict', '--environment', 'production', '--target-manifest', manifestPath, '--expected-target-sha256', sha256];
    const good = 'postgresql://test_role:canonical-secret@127.0.0.1:1/test_db?sslmode=require';
    const wrong = 'postgresql://test_role:wrong-secret@127.0.0.1:1/wrong_db?sslmode=require';

    const missingCanonical = run(args, { DATABASE_URL: '', DATABASE_URL_UNPOOLED: good });
    assert.equal(missingCanonical.status, 1);
    assert.match(missingCanonical.stderr, /CANONICAL_DATABASE_URL_REQUIRED/);

    const wrongCanonical = run(args, { DATABASE_URL: wrong, DATABASE_URL_UNPOOLED: good });
    assert.equal(wrongCanonical.status, 1);
    assert.match(wrongCanonical.stderr, /DATABASE_TARGET_MISMATCH/);

    const wrongUnpooled = run(args, { DATABASE_URL: good, DATABASE_URL_UNPOOLED: wrong });
    assert.equal(wrongUnpooled.status, 1);
    assert.match(wrongUnpooled.stderr, /DATABASE_TARGET_MISMATCH/);

    for (const result of [missingCanonical, wrongCanonical, wrongUnpooled]) {
      assert.doesNotMatch(result.stdout + result.stderr, /canonical-secret|wrong-secret/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('production schema lock is pinned to the canonical regular repository file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schema-lock-binding-test-'));
  try {
    const targetPath = join(directory, 'production.json');
    const externalLock = join(directory, 'external-lock.json');
    writeFileSync(externalLock, JSON.stringify(lock));
    await assert.rejects(
      loadSchemaLock(targetPath, { ...target, environment: 'production', schemaLock: 'external-lock.json' }),
      { code: 'SCHEMA_LOCK_UNBOUND' },
    );
    const canonicalLock = join(directory, 'canonical-lock.json');
    const raw = `${JSON.stringify(lock)}\n`;
    writeFileSync(canonicalLock, raw);
    const bound = await loadSchemaLock(targetPath, { ...target, environment: 'production', schemaLock: 'database-schema.lock.json' }, { canonicalSchemaLockPath: canonicalLock });
    assert.equal(bound.schemaLockBinding, 'canonical-repository-schema-lock');
    assert.equal(bound.schemaLockSha256, createHash('sha256').update(raw).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('exact timestamp and source hash are required even when counts match', () => {
  for (const rows of [[{ hash: 'wrong', created_at: '42' }], [{ hash: 'a'.repeat(64), created_at: '43' }]]) assert.throws(() => assertMigrationRows(rows, plan), { code: 'MIGRATION_HASH_MISMATCH' });
  assert.throws(() => assertMigrationRows([], plan), { code: 'MIGRATION_COUNT_MISMATCH' });
  assert.throws(() => assertMigrationRows([{ hash: 'a'.repeat(64), created_at: '42' }, { hash: 'a'.repeat(64), created_at: '42' }], plan), { code: 'MIGRATION_COUNT_MISMATCH' });
  assert.doesNotThrow(() => assertMigrationRows([{ hash: 'b'.repeat(64), created_at: '42' }], plan));
});
test('live identity, missing schema-qualified journal, stale baseline and schema drift reject', async () => {
  await assert.rejects(verify({ identity: { database: 'wrong', role: 'test_role' } }), { code: 'LIVE_IDENTITY_MISMATCH' });
  await assert.rejects(verify({ present: false }), { code: 'MIGRATION_JOURNAL_MISSING' });
  await assert.rejects(verify({}, { ...lock, migrationSetSha256: 'old' }), { code: 'SCHEMA_LOCK_STALE' });
  await assert.rejects(verify({}, { ...lock, sourceHashes: {} }), { code: 'SCHEMA_LOCK_STALE' });
  await assert.rejects(verify({ catalogue: { ...catalogue, columns: [] } }), { code: 'SCHEMA_DRIFT' });
  await assert.rejects(verify({ error: new Error('query failure') }), /query failure/);
  const good = await verify(); assert.equal(good.verified, true); assert.equal(good.migrationCount, 1);
  assert.equal(good.targetManifestSha256, targetManifestSha256);
  assert.equal(good.schemaLockSha256, 'd'.repeat(64));
  assert.deepEqual(good.validatedConnection, { endpoint: '127.0.0.1', port: 1, database: 'test_db', role: 'test_role' });
  assert.deepEqual(good.databaseUrlValidation.canonical, { present: true, independentlyValidated: true, endpoint: '127.0.0.1', port: 1, database: 'test_db', role: 'test_role' });
  assert.deepEqual(good.databaseUrlValidation.unpooled, { present: false, independentlyValidated: false });
  assert.deepEqual(good.declaredProviderIdentity, { verification: 'declared-not-independently-verified', projectId: 'test-project', branchId: 'br-test' });
  assert.equal('providerBinding' in good, false);
});
test('repository plan accounts for every migration and only LF/CRLF source encodings', async () => {
  const actual = await migrationPlan(); assert.equal(actual.migrations.length, 12);
  assert.ok(actual.migrations.every(entry => entry.hashes.length >= 1 && entry.hashes.length <= 2));
});
test('unreachable reviewed target fails with no credentials in CLI output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'migration-gate-test-'));
  try {
    const targetPath = join(directory, 'target.json');
    writeFileSync(targetPath, JSON.stringify({ ...target, schemaLock: resolve('config/database-schema.lock.json') }));
    const result = run(['--strict', '--target-manifest', targetPath], { DATABASE_URL_UNPOOLED: url, DATABASE_URL: '' });
    assert.equal(result.status, 1); assert.match(result.stdout + result.stderr, /DATABASE_QUERY_FAILED/);
    assert.doesNotMatch(result.stdout + result.stderr, /never-print-this-secret/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
