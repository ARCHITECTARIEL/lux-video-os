import { readFile } from 'node:fs/promises';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
const connectionString = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim();
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required for the identity migration dry run.');

const baselineMigrations = ['0000_clear_blackheart.sql', '0001_breezy_mikhail_rasputin.sql', '0002_icy_white_queen.sql', '0003_long_flatman.sql'];
const identityMigration = '0004_identity_studio_mvp.sql';
const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
const client = await pool.connect();

async function applyMigration(file) {
  const source = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
  for (const statement of source.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) await client.query(statement);
}

try {
  const before = await client.query(`select count(*)::int as count from pg_tables where schemaname = current_schema() and tablename in ('users', 'media_assets', 'projects', 'user_identities', 'identity_consents')`);
  if (before.rows[0].count !== 0) throw new Error('Identity migration dry run requires an empty target.');
  await client.query('begin');
  for (const file of baselineMigrations) await applyMigration(file);
  await client.query(`insert into users (id, email, name) values ('identity-migration-owner', 'identity-migration@example.invalid', 'Migration Owner')`);
  await client.query(`insert into media_assets (id, account_id, kind, private_pathname, content_type, bytes, sha256) values
    ('00000000-0000-4000-8000-000000000001', 'identity-migration-owner', 'identity-photo-source', 'video-os/uploads/migration/photo.png', 'image/png', 100, repeat('a', 64)),
    ('00000000-0000-4000-8000-000000000002', 'identity-migration-owner', 'identity-voice-source', 'video-os/uploads/migration/voice.wav', 'audio/wav', 200, repeat('b', 64))`);
  await client.query(`insert into projects (id, account_id, title, script) values ('00000000-0000-4000-8000-000000000003', 'identity-migration-owner', 'Existing project', 'Existing script')`);
  await client.query('savepoint before_identity_migration');
  await applyMigration(identityMigration);
  await client.query(`insert into user_identities (id, account_id, display_name, source_photo_asset_id, source_voice_asset_id) values
    ('00000000-0000-4000-8000-000000000004', 'identity-migration-owner', 'CEO Identity', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')`);
  await client.query(`insert into identity_consents (account_id, identity_id, face_authorization, voice_authorization, provider_processing_authorization, archive_delete_acknowledgment, policy_version, photo_sha256, voice_sha256) values
    ('identity-migration-owner', '00000000-0000-4000-8000-000000000004', true, true, true, true, 'identity-2026-07-v1', repeat('a', 64), repeat('b', 64))`);
  const inside = await client.query(`select
    to_regclass('user_identities') is not null as identities,
    to_regclass('identity_consents') is not null as consents,
    exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'media_assets' and column_name = 'provider_asset_id') as media_extension,
    (select count(*)::int from projects where account_id = 'identity-migration-owner') as preserved_projects`);
  if (!inside.rows[0].identities || !inside.rows[0].consents || !inside.rows[0].media_extension || inside.rows[0].preserved_projects !== 1) {
    throw new Error('Identity migration did not preserve the populated baseline or create its contract.');
  }
  await client.query('rollback to savepoint before_identity_migration');
  const rolledBack = await client.query(`select
    to_regclass('user_identities') is null as identities_removed,
    to_regclass('identity_consents') is null as consents_removed,
    not exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'media_assets' and column_name = 'provider_asset_id') as media_extension_removed,
    (select count(*)::int from projects where account_id = 'identity-migration-owner') as preserved_projects`);
  if (!rolledBack.rows[0].identities_removed || !rolledBack.rows[0].consents_removed || !rolledBack.rows[0].media_extension_removed || rolledBack.rows[0].preserved_projects !== 1) {
    throw new Error('Identity migration rollback did not restore the populated baseline.');
  }
  await client.query('rollback');

  const after = await client.query(`select count(*)::int as count from pg_tables where schemaname = current_schema() and tablename in ('users', 'media_assets', 'projects', 'user_identities', 'identity_consents')`);
  if (after.rows[0].count !== 0) throw new Error('Identity migration dry run left application tables behind.');
  console.log('Identity migration dry run passed: populated baseline preserved, identity schema verified, savepoint rollback restored baseline, outer rollback left target empty.');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
