// Explicit live-test runner. Credentials are supplied from an external env file,
// never from the checkout's .env.local. This runner rejects default DB targets.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { list, del } from '@vercel/blob';
import { putPrivateBlob, getPrivateBlob, deletePrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../lib/video-os-private-blob.js';
import { migrationPlan, assertMigrationRows, readSchemaCatalogue, schemaDigest, validateTarget } from './check-migrations.mjs';

const mode = process.argv[2] || 'preflight';
const reportPath = process.env.VIDEO_OS_LIVE_REPORT;
assert.ok(reportPath, 'An explicit report path is required.');
const url = new URL(process.env.DATABASE_URL || '');
const reviewedTarget = JSON.parse(await readFile(new URL('../config/database-target.verification.json', import.meta.url), 'utf8'));
validateTarget(process.env.DATABASE_URL, reviewedTarget, 'verification');
if (process.env.DATABASE_URL_UNPOOLED) validateTarget(process.env.DATABASE_URL_UNPOOLED, reviewedTarget, 'verification');
assert.equal(url.hostname, process.env.VIDEO_OS_EXPECTED_DB_HOST);
assert.equal(url.pathname.slice(1), process.env.VIDEO_OS_EXPECTED_DB_NAME);
assert.match(url.pathname, /^\/mvp_verification_\d{8}$/);
assert.equal(url.hostname, 'ep-lingering-fire-aitvfm3y-pooler.c-4.us-east-1.aws.neon.tech');
assert.equal(process.env.VIDEO_OS_EXPECTED_BLOB_STORE, '8uyr0JDWkUyha8sy');
assert.ok((process.env.BLOB_READ_WRITE_TOKEN || '').toLowerCase().startsWith('vercel_blob_rw_8uyr0jdwkuyha8sy_'));
assert.equal(process.env.STORAGE_DRIVER, 'blob');
for (const name of ['HEYGEN_API_KEY', 'HEYGEN_TOKEN', 'RUNPOD_API_KEY', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY']) delete process.env[name];
process.env.VIDEO_OS_STANDARD_PROVIDER = 'simulation';
process.env.VIDEO_OS_SESSION_SECRET = 'isolated-verification-session-not-production';
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const report = { at: new Date().toISOString(), mode, database: { host: url.hostname, name: url.pathname.slice(1), branch: 'br-wandering-violet-ai1egt3g' }, blobStore: 'store_8uyr0JDWkUyha8sy' };
const tableNames = ['users', 'credit_accounts', 'credit_transactions', 'job_events', 'media_assets', 'rate_limits', 'stripe_events', 'video_jobs', 'auth_challenges', 'auth_sessions', 'entitlements', 'projects', 'identity_consents', 'user_identities', 'standard_narration_consents', 'standard_narration_quotes', 'identity_video_enrollments', 'identity_enrollment_events', 'provider_account_bindings', 'provider_verified_account_scopes', 'provider_account_binding_promotions', 'provider_approval_claims', 'provider_lifecycle_operations', 'provider_resources', 'provider_consumer_references', 'provider_lifecycle_events', 'provider_approval_claim_resources'];

async function objectList() {
  const blobs = []; let cursor;
  do { const page = await list({ token: process.env.BLOB_READ_WRITE_TOKEN, cursor, limit: 1000 }); blobs.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined; } while (cursor);
  return blobs;
}
async function counts() {
  const names = (await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).rows.map(x => x.table_name);
  assert.ok(names.every(name => tableNames.includes(name)), 'Unexpected table in test database.');
  const result = {};
  for (const name of names) result[name] = Number((await pool.query(`select count(*) as n from public."${name}"`)).rows[0].n);
  return result;
}
function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let pending = ''; let size = 0;
    const printSafe = text => {
      for (const secret of [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED, process.env.BLOB_READ_WRITE_TOKEN, process.env.VERCEL_OIDC_TOKEN].filter(Boolean)) text = text.replaceAll(secret, '[redacted credential]');
      process.stdout.write(text);
    };
    const collect = chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { child.kill(); return; }
      pending += chunk.toString();
      const end = pending.lastIndexOf('\n');
      if (end >= 0) { printSafe(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject); child.once('close', code => {
      printSafe(pending);
      resolveRun(code ?? 1);
    });
  });
}
try {
  const identity = (await pool.query('select current_database() as database, current_user as role')).rows[0];
  assert.equal(identity.database, process.env.VIDEO_OS_EXPECTED_DB_NAME);
  report.identity = identity;
  report.before = { rows: await counts(), blobs: (await objectList()).length };
  if (mode === 'migrate') {
    assert.equal(Object.keys(report.before.rows).length, 0, 'Migration mode only initializes the new empty test database.');
    const exit = await run([resolve('node_modules/drizzle-kit/bin.cjs'), 'migrate']);
    assert.equal(exit, 0, 'Test database migration failed.');
    const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
    const applied = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    const expected = await Promise.all(journal.entries.map(async entry => createHash('sha256').update(await readFile(`drizzle/${entry.tag}.sql`)).digest('hex')));
    assert.deepEqual(applied.map(row => row.hash), expected);
    report.migrationHashes = expected;
  } else if (mode === 'validate-migration') {
    // Diagnose pending SQL on the same pinned target without retaining DDL.
    const plan = await migrationPlan();
    const before = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    assertMigrationRows(before, { migrations: plan.migrations.slice(0, before.length) });
    const schemaBefore = schemaDigest(await readSchemaCatalogue(pool));
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const migration of plan.migrations.slice(before.length)) {
        const chunks = (await readFile(`drizzle/${migration.tag}.sql`, 'utf8')).split('--> statement-breakpoint');
        for (const [index, statement] of chunks.entries()) {
          try { if (statement.trim()) await client.query(statement); }
          catch (error) {
            report.failedStatement = { migration: migration.tag, index, code: error.code };
            throw error;
          }
        }
      }
    } finally {
      await client.query('rollback');
      client.release();
    }
    assert.equal(schemaDigest(await readSchemaCatalogue(pool)), schemaBefore, 'Validation must not retain schema changes.');
    report.rollbackVerified = true;
  } else if (mode === 'upgrade') {
    // Append migrations only on this pinned, empty verification database. Never
    // bless drift by applying a migration over an unverified previous baseline.
    assert.ok(Object.values(report.before.rows).every(value => value === 0), 'Test data must be cleaned before upgrading.');
    assert.equal(report.before.blobs, 0, 'Test objects must be cleaned before upgrading.');
    const plan = await migrationPlan();
    const before = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    assert.ok(before.length > 0 && before.length < plan.migrations.length, 'Upgrade requires a nonempty exact migration prefix and pending migrations.');
    assertMigrationRows(before, { migrations: plan.migrations.slice(0, before.length) });
    const previousLock = JSON.parse(await readFile(new URL('../config/database-schema.lock.json', import.meta.url), 'utf8'));
    assert.equal(schemaDigest(await readSchemaCatalogue(pool)), previousLock.schemaSha256, 'Existing test schema differs from its previous reviewed baseline.');
    report.previousMigrationHashes = before.map(row => row.hash);
    const migrationExit = await run([resolve('node_modules/drizzle-kit/bin.cjs'), 'migrate']);
    assert.equal(migrationExit, 0, 'Isolated test migration upgrade failed.');
    const after = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    assertMigrationRows(after, plan);
    report.migrationHashes = after.map(row => row.hash);
    report.migrationSetSha256 = plan.sha256;
  } else if (mode === 'preflight') {
    const bytes = Buffer.from('isolated-private-storage-proof');
    const path = `video-os/uploads/live-verification-${randomUUID()}/proof.txt`;
    const blob = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, path, bytes, { addRandomSuffix: false, contentType: 'text/plain' });
    try {
      const stored = await getPrivateBlob(path); assert.ok(stored?.stream);
      const read = Buffer.from(await new Response(stored.stream).arrayBuffer()); assert.deepEqual(read, bytes);
      const anonymous = await fetch(blob.url, { redirect: 'manual' });
      assert.ok([401, 403, 404].includes(anonymous.status), `Anonymous private object unexpectedly returned ${anonymous.status}.`);
      report.storageProof = { sha256: createHash('sha256').update(read).digest('hex'), bytes: read.length, anonymousStatus: anonymous.status };
      await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, path, { ifMatch: stored.blob.etag });
    } finally { await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => {}); }
  } else if (mode === 'tests') {
    assert.equal(Object.keys(report.before.rows).length, tableNames.length, 'Test schema is incomplete.');
    const files = process.argv.slice(3);
    assert.ok(files.length && files.every(file => /^tests\/[a-z0-9-]+\.test\.mjs$/.test(file)), 'Supply explicit scoped test files.');
    report.testFiles = files;
    process.env.VIDEO_OS_ISOLATED_LIVE = '1';
    process.env.VIDEO_OS_LIVE_DETAIL_REPORT = reportPath.replace(/\.json$/, '.detail.json');
    report.testExit = await run(['--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', ...files]);
  } else if (mode === 'cleanup') {
    // Every object/table in this dedicated, originally empty target belongs to
    // this verification run. Exact host/name/store guards above are mandatory.
    const blobs = await objectList();
    assert.ok(blobs.every(blob => blob.pathname.startsWith('video-os/')), 'Unexpected object outside application test namespace.');
    for (const blob of blobs) await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const presentTables = Object.keys(report.before.rows); // Already checked against the fixed allowlist.
    if (presentTables.length) await pool.query(`truncate ${presentTables.map(name => `public."${name}"`).join(', ')} cascade`);
    report.deletedTestObjects = blobs.length;
  } else throw new Error('Unknown verification mode.');
  report.after = { rows: await counts(), blobs: (await objectList()).length };
  if (mode === 'cleanup') assert.ok(report.after.blobs === 0 && Object.values(report.after.rows).every(n => n === 0));
  report.ok = report.testExit === undefined || report.testExit === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.ok = false;
  report.error = { name: error?.name, code: error?.code, message: String(error?.message || 'Verification failed').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted database URL]').replace(/vercel_blob_rw_\S+/g, '[redacted Blob token]') };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report)); process.exitCode = 1;
} finally { await pool.end(); }
