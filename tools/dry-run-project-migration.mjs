import { readFile } from 'node:fs/promises';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const connectionString = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');

const sql = await readFile(new URL('../drizzle/0003_long_flatman.sql', import.meta.url), 'utf8');
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();

try {
  const before = await client.query(`select to_regclass('public.projects') as projects, count(*)::int as jobs from video_jobs`);
  if (before.rows[0].projects) throw new Error('Project migration dry run requires projects to be absent.');
  if (before.rows[0].jobs !== 0) throw new Error('Project migration dry run requires the development job table to be empty.');
  await client.query('begin');
  for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) await client.query(statement);
  const inside = await client.query(`select to_regclass('public.projects') as projects, exists (select 1 from information_schema.columns where table_name = 'video_jobs' and column_name = 'project_id') as project_id_column`);
  if (!inside.rows[0].projects || !inside.rows[0].project_id_column) throw new Error('Project migration did not create the expected schema.');
  await client.query('rollback');
  const after = await client.query(`select to_regclass('public.projects') as projects`);
  if (after.rows[0].projects) throw new Error('Rollback left the projects table behind.');
  console.log('Project migration dry run passed: empty target verified, schema created transactionally, rollback restored the prior schema.');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
