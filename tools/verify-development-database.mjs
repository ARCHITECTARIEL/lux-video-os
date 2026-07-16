import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const connectionString = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');
const expected = ['auth_challenges', 'auth_sessions', 'credit_accounts', 'credit_transactions', 'entitlements', 'job_events', 'media_assets', 'projects', 'rate_limits', 'stripe_events', 'users', 'video_jobs'];
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();
try {
  const tables = await client.query('select tablename from pg_tables where schemaname = current_schema() and tablename = any($1::text[]) order by tablename', [expected]);
  const present = tables.rows.map((row) => row.tablename);
  const missing = expected.filter((table) => !present.includes(table));
  if (missing.length) throw new Error(`Missing application tables: ${missing.join(', ')}`);
  const counts = {};
  for (const table of expected) counts[table] = Number((await client.query(`select count(*)::int as count from ${table}`)).rows[0].count);
  const nonempty = Object.entries(counts).filter(([, count]) => count !== 0);
  if (nonempty.length) throw new Error(`Authorized empty target unexpectedly contains application records in: ${nonempty.map(([table]) => table).join(', ')}`);
  console.log(`Development database verified: ${present.length} application tables, all application row counts zero.`);
} finally {
  client.release();
  await pool.end();
}
