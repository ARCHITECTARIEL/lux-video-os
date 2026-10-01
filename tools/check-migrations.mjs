import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const BUNDLED_RUNTIME = new URL(import.meta.url).pathname.endsWith('/index.js');
const root = fileURLToPath(BUNDLED_RUNTIME ? new URL('./runtime-repository/', import.meta.url) : new URL('../', import.meta.url));
const drizzleDir = resolve(root, 'drizzle');
const canonicalProductionTarget = resolve(root, 'config/database-target.production.json');
const canonicalProductionSchemaLock = resolve(root, 'config/database-schema.lock.json');
const schemaFiles = ['db/schema.js', 'db/standard-narration-schema.js', 'db/provider-lifecycle-guards.sql'];
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const schemaDigest = value => digest(JSON.stringify(canonical(value)));
function fail(code, message) { return Object.assign(new Error(message), { code, verificationFailure: true }); }

export async function checkMigrationFiles(directory = drizzleDir) {
  return (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
}

export async function migrationPlan(directory = drizzleDir) {
  const journal = JSON.parse(await readFile(resolve(directory, 'meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw fail('LOCAL_JOURNAL_INVALID', 'Local migration journal is empty or invalid.');
  const migrations = [];
  for (const [idx, entry] of journal.entries.entries()) {
    if (entry.idx !== idx || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) || !Number.isSafeInteger(entry.when)
      || (idx && entry.when <= journal.entries[idx - 1].when)) throw fail('LOCAL_JOURNAL_INVALID', 'Local migration order is invalid.');
    const sql = (await readFile(resolve(directory, `${entry.tag}.sql`), 'utf8')).replace(/\r\n/g, '\n');
    // Drizzle hashes exact bytes. Git uses LF/CRLF on different hosts: accept
    // only those two encodings of identical source SQL, never arbitrary hashes.
    migrations.push({ tag: entry.tag, timestamp: String(entry.when), hashes: [...new Set([digest(sql), digest(sql.replace(/\n/g, '\r\n'))])] });
  }
  if (JSON.stringify(await checkMigrationFiles(directory)) !== JSON.stringify(migrations.map(item => `${item.tag}.sql`).sort())) {
    throw fail('LOCAL_JOURNAL_INVALID', 'Migration files and journal entries differ.');
  }
  return { migrations, sha256: schemaDigest(migrations) };
}

export async function schemaSourceHashes() {
  // Keep file references explicit: tracing resolve(root, an unknown map value)
  // can expand to the entire repository, including in-progress build output.
  const contents = await Promise.all([
    readFile(resolve(root, 'db/schema.js'), 'utf8'),
    readFile(resolve(root, 'db/standard-narration-schema.js'), 'utf8'),
    readFile(resolve(root, 'db/provider-lifecycle-guards.sql'), 'utf8'),
  ]);
  return Object.fromEntries(schemaFiles.map((name, index) => [name, digest(contents[index].replace(/\r\n/g, '\n'))]));
}

export async function loadTargetManifest(targetPath, options = {}) {
  const resolvedPath = resolve(targetPath);
  const raw = await readFile(resolvedPath);
  const targetManifestSha256 = digest(raw);
  let target;
  try { target = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch {
    throw fail('TARGET_MANIFEST_INVALID', 'Database target manifest is not valid JSON.');
  }
  if (options.requiredEnvironment && target.environment !== options.requiredEnvironment) {
    throw fail('TARGET_ENVIRONMENT_MISMATCH', 'Target manifest environment does not match the requested build.');
  }
  let targetManifestBinding = 'verification-manifest';
  if (target.environment === 'production') {
    const canonicalPath = resolve(options.canonicalProductionPath || canonicalProductionTarget);
    if (resolvedPath === canonicalPath) {
      const metadata = await lstat(resolvedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw fail('TARGET_MANIFEST_UNBOUND', 'Canonical production target manifest must be a regular repository file.');
      targetManifestBinding = 'canonical-repository-manifest';
    } else {
      const expected = String(options.expectedSha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expected) || expected !== targetManifestSha256) {
        throw fail('TARGET_MANIFEST_UNBOUND', 'External production target manifest does not match the trusted expected SHA-256.');
      }
      targetManifestBinding = 'trusted-external-manifest-sha256';
    }
  }
  return { target, targetManifestSha256, targetManifestBinding };
}

export async function loadSchemaLock(targetPath, target, options = {}) {
  let lockPath;
  let schemaLockBinding;
  if (target.environment === 'production') {
    if (target.schemaLock !== 'database-schema.lock.json') {
      throw fail('SCHEMA_LOCK_UNBOUND', 'Production schema lock must use the canonical repository baseline.');
    }
    lockPath = resolve(options.canonicalSchemaLockPath || canonicalProductionSchemaLock);
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw fail('SCHEMA_LOCK_UNBOUND', 'Canonical production schema lock must be a regular repository file.');
    }
    schemaLockBinding = 'canonical-repository-schema-lock';
  } else {
    if (!target.schemaLock || typeof target.schemaLock !== 'string') {
      throw fail('SCHEMA_LOCK_UNBOUND', 'Verification target manifest must identify its schema lock.');
    }
    lockPath = resolve(dirname(resolve(targetPath)), target.schemaLock);
    schemaLockBinding = 'verification-schema-lock';
  }
  const raw = await readFile(lockPath);
  let schemaLock;
  try { schemaLock = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch {
    throw fail('SCHEMA_LOCK_INVALID', 'Schema lock is not valid JSON.');
  }
  return { schemaLock, schemaLockSha256: digest(raw), schemaLockBinding };
}

export function validateTarget(connectionString, target, requiredEnvironment) {
  if (!connectionString) throw fail('DATABASE_URL_REQUIRED', 'A database URL is required for live verification.');
  if (!target || target.version !== 1 || !['production', 'verification'].includes(target.environment)
    || !target.projectId || !target.branchId || !Array.isArray(target.hosts) || !target.hosts.length
    || !target.database || !Array.isArray(target.roles) || !target.roles.length) throw fail('TARGET_MANIFEST_REQUIRED', 'A reviewed nonsecret database target manifest is required.');
  if (requiredEnvironment && target.environment !== requiredEnvironment) throw fail('TARGET_ENVIRONMENT_MISMATCH', 'Target manifest environment does not match the requested build.');
  let url;
  try { url = new URL(connectionString); } catch { throw fail('DATABASE_URL_INVALID', 'Database URL is invalid.'); }
  const queryKeys = [...url.searchParams.keys()];
  const safeQueryKeys = new Set(['sslmode', 'channel_binding', 'connect_timeout', 'application_name', 'pgbouncer', 'target_session_attrs']);
  if (queryKeys.some(key => !safeQueryKeys.has(key)) || new Set(queryKeys).size !== queryKeys.length) {
    throw fail('DATABASE_URL_INVALID', 'Database URL contains unsupported or ambiguous connection options.');
  }
  if (target.environment === 'production' && !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))) {
    throw fail('DATABASE_URL_INVALID', 'Production database verification requires TLS.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !target.hosts.includes(url.hostname)
    || decodeURIComponent(url.pathname.slice(1)) !== target.database || !target.roles.includes(decodeURIComponent(url.username))
    || Number(url.port || 5432) !== Number(target.port || 5432)) throw fail('DATABASE_TARGET_MISMATCH', 'Database connection does not match the reviewed target identity.');
  return { endpoint: url.hostname, port: Number(url.port || 5432), database: target.database, role: decodeURIComponent(url.username), environment: target.environment };
}

export function assertMigrationRows(rows, plan) {
  if (rows.length !== plan.migrations.length) throw fail('MIGRATION_COUNT_MISMATCH', 'Applied migration count differs from source.');
  for (const [index, item] of plan.migrations.entries()) {
    if (String(rows[index].created_at) !== item.timestamp || !item.hashes.includes(rows[index].hash)) throw fail('MIGRATION_HASH_MISMATCH', `Applied migration fingerprint differs at ${item.tag}.`);
  }
}

// No table data or mutable counters: same-count journals cannot conceal drift.
export async function readSchemaCatalogue(client) {
  const result = await client.query(`select jsonb_build_object(
    'tables', (select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
    'columns', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) order by c.relname,a.attnum),'[]') from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped),
    'constraints', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated) order by c.relname,k.conname),'[]') from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'indexes', (select coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) order by tablename,indexname),'[]') from pg_indexes where schemaname='public'),
    'policies', (select coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'permissive',permissive,'roles',roles,'command',cmd,'using',qual,'check',with_check) order by tablename,policyname),'[]') from pg_policies where schemaname='public'),
    'triggers', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) order by c.relname,t.tgname),'[]') from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
    'enums', (select coalesce(jsonb_agg(jsonb_build_object('name',t.typname,'label',e.enumlabel,'order',e.enumsortorder) order by t.typname,e.enumsortorder),'[]') from pg_type t join pg_namespace n on n.oid=t.typnamespace join pg_enum e on e.enumtypid=t.oid where n.nspname='public'),
    'views', (select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'definition',pg_get_viewdef(c.oid,true)) order by c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m')),
    'routines', (select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')),
    'sequences', (select coalesce(jsonb_agg(jsonb_build_object('name',sequencename,'type',data_type::text,'start',start_value,'min',min_value,'max',max_value,'increment',increment_by,'cycle',cycle,'cache',cache_size) order by sequencename),'[]') from pg_sequences where schemaname='public')
  ) as catalogue`);
  return result.rows[0].catalogue;
}

export async function verifyConnectedDatabase(client, { target, plan, schemaLock, sourceHashes, capture = false, validatedTarget = null, validatedCanonicalTarget = null, validatedUnpooledTarget = null, targetManifestSha256 = null, targetManifestBinding = null, schemaLockSha256 = null, schemaLockBinding = null }) {
  const identity = (await client.query('select current_database() as database, current_user as role')).rows[0];
  if (identity.database !== target.database || !target.roles.includes(identity.role)) throw fail('LIVE_IDENTITY_MISMATCH', 'Connected database identity differs from target manifest.');
  const exists = (await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present")).rows[0].present;
  if (!exists) throw fail('MIGRATION_JOURNAL_MISSING', 'The schema-qualified Drizzle migration journal is missing.');
  const rows = (await client.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at, id')).rows;
  assertMigrationRows(rows, plan);
  const catalogue = await readSchemaCatalogue(client);
  const fingerprint = schemaDigest(catalogue);
  if (!capture) {
    if (schemaLock?.version !== 1 || !schemaLock.sourceHashes || schemaLock.migrationSetSha256 !== plan.sha256 || schemaDigest(schemaLock.sourceHashes) !== schemaDigest(sourceHashes)) throw fail('SCHEMA_LOCK_STALE', 'Schema baseline is missing or no longer bound to current schema/migration sources.');
    if (schemaLock.schemaSha256 !== fingerprint) throw fail('SCHEMA_DRIFT', 'Live schema structure differs from the reviewed migration-derived baseline.');
  }
  return {
    verified: !capture,
    scope: capture ? 'schema-baseline-capture' : 'live-database',
    journalVerified: true,
    environment: target.environment,
    identity,
    targetManifestSha256,
    targetManifestBinding,
    schemaLockSha256,
    schemaLockBinding,
    validatedConnection: validatedTarget ? {
      endpoint: validatedTarget.endpoint,
      port: validatedTarget.port,
      database: validatedTarget.database,
      role: validatedTarget.role,
    } : null,
    databaseUrlValidation: {
      canonical: validatedCanonicalTarget ? {
        present: true,
        independentlyValidated: true,
        endpoint: validatedCanonicalTarget.endpoint,
        port: validatedCanonicalTarget.port,
        database: validatedCanonicalTarget.database,
        role: validatedCanonicalTarget.role,
      } : { present: false, independentlyValidated: false },
      unpooled: validatedUnpooledTarget ? {
        present: true,
        independentlyValidated: true,
        endpoint: validatedUnpooledTarget.endpoint,
        port: validatedUnpooledTarget.port,
        database: validatedUnpooledTarget.database,
        role: validatedUnpooledTarget.role,
      } : { present: false, independentlyValidated: false },
    },
    declaredProviderIdentity: {
      verification: 'declared-not-independently-verified',
      projectId: target.projectId,
      branchId: target.branchId,
    },
    migrationSetSha256: plan.sha256,
    migrationCount: rows.length,
    appliedHashes: rows.map(row => row.hash),
    schemaSha256: fingerprint,
    tableCount: catalogue.tables.length,
    verifiedAt: new Date().toISOString(),
  };
}

export async function checkDatabaseMigrations(connectionString, options = {}) {
  const validatedTarget = validateTarget(connectionString, options.target, options.requiredEnvironment);
  const plan = options.plan || await migrationPlan();
  const sourceHashes = options.sourceHashes || await schemaSourceHashes();
  if (options.capture && (options.target.environment !== 'verification' || options.target.isDefault !== false
    || !options.target.parentBranchId || options.target.branchId === options.target.parentBranchId
    || !/^mvp_verification_\d{8}$/.test(options.target.database))) throw fail('CAPTURE_FORBIDDEN', 'Only an isolated verification database can supply a schema baseline.');
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  neonConfig.webSocketConstructor = (await import('ws')).default;
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000, query_timeout: 15000 });
  let client;
  try {
    client = await pool.connect();
    await client.query('begin isolation level repeatable read read only');
    await client.query('set local search_path = public, pg_catalog');
    const result = await verifyConnectedDatabase(client, { ...options, plan, sourceHashes, validatedTarget });
    await client.query('rollback');
    return result;
  } catch (error) {
    if (error.verificationFailure) throw error;
    throw fail('DATABASE_QUERY_FAILED', 'Live database verification could not complete.');
  } finally {
    if (client) { await client.query('rollback').catch(() => {}); client.release(); }
    await pool.end();
  }
}

export function runDrizzleCheck() {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/drizzle-kit/bin.cjs'), 'check'], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw fail('SNAPSHOT_CHECK_FAILED', 'Drizzle migration snapshot check failed.');
}

function argument(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
export async function main() {
  if (process.argv.includes('--snapshot-only')) {
    if (process.argv.includes('--strict')) throw fail('MODE_CONFLICT', 'Strict live verification cannot use snapshot-only mode.');
    runDrizzleCheck(); console.log(JSON.stringify({ scope: 'snapshots-only', liveVerified: false })); return;
  }
  const canonicalConnectionString = process.env.DATABASE_URL;
  const unpooledConnectionString = process.env.DATABASE_URL_UNPOOLED;
  if (!canonicalConnectionString && !unpooledConnectionString) throw fail('DATABASE_URL_REQUIRED', 'A database URL is required for live verification.');
  const targetPath = argument('--target-manifest') || process.env.VIDEO_OS_DB_TARGET_MANIFEST;
  if (!targetPath) throw fail('TARGET_MANIFEST_REQUIRED', 'Provide --target-manifest or VIDEO_OS_DB_TARGET_MANIFEST.');
  const requiredEnvironment = argument('--environment');
  const targetEvidence = await loadTargetManifest(targetPath, {
    requiredEnvironment,
    expectedSha256: argument('--expected-target-sha256') || process.env.VIDEO_OS_DB_TARGET_MANIFEST_SHA256,
  });
  const { target } = targetEvidence;
  let connectionString;
  let validatedCanonicalTarget = null;
  let validatedUnpooledTarget = null;
  if (target.environment === 'production') {
    if (!canonicalConnectionString) throw fail('CANONICAL_DATABASE_URL_REQUIRED', 'Production verification requires the canonical application DATABASE_URL.');
    validatedCanonicalTarget = validateTarget(canonicalConnectionString, target, requiredEnvironment);
    if (unpooledConnectionString) validatedUnpooledTarget = validateTarget(unpooledConnectionString, target, requiredEnvironment);
    connectionString = canonicalConnectionString;
  } else {
    connectionString = unpooledConnectionString || canonicalConnectionString;
    if (canonicalConnectionString) validatedCanonicalTarget = validateTarget(canonicalConnectionString, target, requiredEnvironment);
    if (unpooledConnectionString) validatedUnpooledTarget = validateTarget(unpooledConnectionString, target, requiredEnvironment);
  }
  const capturePath = argument('--capture-schema');
  const schemaEvidence = capturePath
    ? { schemaLock: undefined, schemaLockSha256: null, schemaLockBinding: 'schema-baseline-capture' }
    : await loadSchemaLock(targetPath, target);
  runDrizzleCheck();
  const result = await checkDatabaseMigrations(connectionString, {
    ...targetEvidence,
    ...schemaEvidence,
    target,
    capture: Boolean(capturePath),
    requiredEnvironment,
    validatedCanonicalTarget,
    validatedUnpooledTarget,
  });
  if (capturePath) await writeFile(capturePath, JSON.stringify({ version: 1, provenance: 'isolated database initialized from exact repository migrations; review before production use', capturedAt: result.verifiedAt, migrationSetSha256: result.migrationSetSha256, sourceHashes: await schemaSourceHashes(), schemaSha256: result.schemaSha256, tableCount: result.tableCount }, null, 2) + '\n');
  const receipt = argument('--receipt');
  if (receipt) await writeFile(receipt, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[check-migrations] ${error.verificationFailure ? error.code : 'VERIFICATION_FAILED'}: ${error.verificationFailure ? error.message : 'Verification inputs are unavailable or invalid.'}`); process.exitCode = 1; });
}
