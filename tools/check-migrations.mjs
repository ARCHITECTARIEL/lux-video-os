import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const drizzleDir = new URL('../drizzle/', import.meta.url);

export async function checkMigrationFiles() {
  const files = (await readdir(drizzleDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  return files;
}

export function runDrizzleCheck() {
  const drizzleCli = new URL('../node_modules/drizzle-kit/bin.cjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(drizzleCli), 'check'], {
    cwd: fileURLToPath(root),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error('drizzle-kit check failed. Schema definitions and migration snapshots are out of sync.');
  }
}

export async function checkDatabaseMigrations(connectionString) {
  if (!connectionString) {
    console.log('[check-migrations] No DATABASE_URL provided. Skipping live database migration check.');
    return { skipped: true };
  }

  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  const ws = (await import('ws')).default;
  neonConfig.webSocketConstructor = ws;

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  const client = await pool.connect();
  try {
    const tableCheck = await client.query(`
      select exists (
        select 1 from information_schema.tables 
        where table_name = '__drizzle_migrations'
      ) as exists;
    `);

    const tableExists = tableCheck.rows[0]?.exists;
    if (!tableExists) {
      return {
        applied: false,
        error: '__drizzle_migrations table does not exist in target database.',
      };
    }

    const appliedRows = await client.query(
      'select id, hash, created_at from __drizzle_migrations order by id asc'
    );

    const journalUrl = new URL('meta/_journal.json', drizzleDir);
    const journalContent = JSON.parse(await readFile(journalUrl, 'utf8'));
    const entries = journalContent.entries || [];

    const unapplied = [];
    for (const entry of entries) {
      const name = entry.tag;
      const found = appliedRows.rows.some((r) => String(r.id) === String(entry.idx) || r.hash?.includes(name));
      if (!found && appliedRows.rows.length <= entry.idx) {
        unapplied.push(name);
      }
    }

    return {
      applied: unapplied.length === 0,
      appliedCount: appliedRows.rows.length,
      expectedCount: entries.length,
      unapplied,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const strict = process.argv.includes('--strict');
  console.log('[check-migrations] Verifying migration snapshots...');
  runDrizzleCheck();
  console.log('[check-migrations] Schema snapshots are consistent with Drizzle schema.');

  const dbUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (dbUrl) {
    console.log('[check-migrations] Verifying applied migrations against live database...');
    try {
      const status = await checkDatabaseMigrations(dbUrl);
      if (status.skipped) {
        console.log('[check-migrations] Skipped live check.');
      } else if (!status.applied) {
        const msg = `Target database is missing migrations (${status.unapplied?.join(', ') || 'unmigrated'}). Expected ${status.expectedCount}, found ${status.appliedCount}.`;
        if (strict) {
          console.error(`\x1b[31m[ERROR] ${msg}\x1b[0m`);
          console.error('Run "npm run db:migrate" against production before proceeding.');
          process.exit(1);
        } else {
          console.warn(`\x1b[33m[WARN] ${msg}\x1b[0m`);
        }
      } else {
        console.log(`[check-migrations] Database is up-to-date (${status.appliedCount}/${status.expectedCount} migrations applied).`);
      }
    } catch (err) {
      console.warn(`[check-migrations] Warning: Could not verify against live database: ${err.message}`);
      if (strict) {
        process.exit(1);
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
