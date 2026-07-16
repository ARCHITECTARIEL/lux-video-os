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
  'job_events',
  'media_assets',
  'rate_limits',
  'stripe_events',
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
