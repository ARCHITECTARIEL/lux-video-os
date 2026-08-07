import { readFile, readdir } from 'node:fs/promises';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const expectedTables = [
  'auth_challenges',
  'auth_sessions',
  'credit_accounts',
  'credit_transactions',
  'entitlements',
  'identity_consents',
  'job_events',
  'media_assets',
  'projects',
  'rate_limits',
  'stripe_events',
  'user_identities',
  'users',
  'video_jobs',
];

const connectionString = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required for the migration dry run.');

const migrationFiles = (await readdir(new URL('../drizzle/', import.meta.url)))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
if (!migrationFiles.length) throw new Error('No SQL migrations were found.');

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();

async function presentTables() {
  const result = await client.query(
    'select tablename from pg_tables where schemaname = current_schema() and tablename = any($1::text[]) order by tablename',
    [expectedTables],
  );
  return result.rows.map((row) => row.tablename);
}

try {
  const before = await presentTables();
  if (before.length) throw new Error(`Dry run requires an empty target; found ${before.length} application tables.`);

  await client.query('begin');
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
      await client.query(statement);
    }
  }

  const inside = await presentTables();
  const missing = expectedTables.filter((table) => !inside.includes(table));
  if (missing.length) throw new Error(`Migration dry run did not create expected tables: ${missing.join(', ')}`);
  const projectRelationship = await client.query(`
    select
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'video_jobs' and column_name = 'project_id'
      ) as project_id_column,
      exists (
        select 1
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_schema = tc.constraint_schema and ccu.constraint_name = tc.constraint_name
        where tc.constraint_schema = current_schema()
          and tc.table_name = 'video_jobs'
          and tc.constraint_type = 'FOREIGN KEY'
          and ccu.table_name = 'projects'
      ) as project_foreign_key
  `);
  if (!projectRelationship.rows[0]?.project_id_column || !projectRelationship.rows[0]?.project_foreign_key) {
    throw new Error('Migration dry run did not establish video_jobs.project_id -> projects.');
  }
  const identityRelationship = await client.query(`
    select
      exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'media_assets' and column_name = 'provider_asset_id') as provider_asset_column,
      exists (
        select 1 from information_schema.table_constraints
        where constraint_schema = current_schema() and table_name = 'user_identities'
          and constraint_name = 'user_identities_overall_status_ck' and constraint_type = 'CHECK'
      ) as lifecycle_check,
      exists (
        select 1 from pg_indexes
        where schemaname = current_schema() and tablename = 'identity_consents'
          and indexname = 'identity_consents_active_policy_uq'
      ) as active_consent_index,
      exists (
        select 1 from information_schema.table_constraints
        where constraint_schema = current_schema() and table_name = 'projects'
          and constraint_name = 'projects_identity_id_user_identities_id_fk' and constraint_type = 'FOREIGN KEY'
      ) as project_identity_fk
  `);
  if (!identityRelationship.rows[0]?.provider_asset_column || !identityRelationship.rows[0]?.lifecycle_check || !identityRelationship.rows[0]?.active_consent_index || !identityRelationship.rows[0]?.project_identity_fk) {
    throw new Error('Migration dry run did not establish the Identity Studio schema contract.');
  }
  await client.query('rollback');

  const after = await presentTables();
  if (after.length) throw new Error(`Migration rollback left ${after.length} application tables behind.`);
  console.log(`Migration dry run passed: ${migrationFiles.length} migrations, ${inside.length} tables verified, rollback left the target empty.`);
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
