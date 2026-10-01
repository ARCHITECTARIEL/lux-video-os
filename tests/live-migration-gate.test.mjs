import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { migrationPlan, schemaSourceHashes, verifyConnectedDatabase, validateTarget } from '../tools/check-migrations.mjs';

test('isolated live migration gate rejects real journal/schema faults and restores the clean baseline', {
  skip: process.env.VIDEO_OS_ISOLATED_LIVE !== '1' && 'Use the guarded isolated-live runner.', timeout: 90000,
}, async () => {
  const target = JSON.parse(await readFile('config/database-target.verification.json', 'utf8'));
  const schemaLock = JSON.parse(await readFile('config/database-schema.lock.json', 'utf8'));
  validateTarget(process.env.DATABASE_URL, target, 'verification');
  const plan = await migrationPlan(); const sourceHashes = await schemaSourceHashes();
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000, query_timeout: 15000 });
  const client = await pool.connect(); const cases = [];
  const options = { target, plan, schemaLock, sourceHashes };
  const verify = () => verifyConnectedDatabase(client, options);
  try {
    await client.query('begin read only');
    await client.query('set local search_path = public, pg_catalog');
    const before = await verify(); assert.equal(before.verified, true);
    await client.query('rollback');
    for (const [name, fault, expected] of [
      ['wrong-hash-same-count', "update drizzle.__drizzle_migrations set hash=repeat('0',64) where id=(select min(id) from drizzle.__drizzle_migrations)", 'MIGRATION_HASH_MISMATCH'],
      ['missing-migration', 'delete from drizzle.__drizzle_migrations where id=(select max(id) from drizzle.__drizzle_migrations)', 'MIGRATION_COUNT_MISMATCH'],
      ['missing-journal', 'alter table drizzle.__drizzle_migrations rename to __test_missing_journal', 'MIGRATION_JOURNAL_MISSING'],
      ['schema-drift', 'alter table public.users add column __test_schema_drift text', 'SCHEMA_DRIFT'],
    ]) {
      await client.query('begin');
      try {
        await client.query('set local search_path = public, pg_catalog');
        await client.query(fault);
        await assert.rejects(verify(), error => error.code === expected);
        cases.push({ name, rejectedWith: expected, passed: true });
      } finally { await client.query('rollback'); }
    }
    await client.query('begin read only'); await client.query('set local search_path = public, pg_catalog');
    await assert.rejects(verifyConnectedDatabase(client, { ...options, target: { ...target, database: 'wrong_database' } }), { code: 'LIVE_IDENTITY_MISMATCH' });
    const after = await verify(); assert.equal(after.schemaSha256, before.schemaSha256);
    assert.deepEqual(after.appliedHashes, before.appliedHashes);
    await client.query('rollback');
    if (process.env.VIDEO_OS_LIVE_DETAIL_REPORT) await writeFile(process.env.VIDEO_OS_LIVE_DETAIL_REPORT, JSON.stringify({ at: new Date().toISOString(), before, cases, wrongIdentityRejected: true, after, allFaultsRolledBack: true }, null, 2));
  } finally { await client.query('rollback').catch(() => {}); client.release(); await pool.end(); }
});
