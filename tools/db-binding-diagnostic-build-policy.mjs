import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ACTIVE_APP_BASE = '61c907e32eea84d65bfe5ab51f0b00f8a265f94f';
export const DIAGNOSTIC_PATHS = Object.freeze([
  'api/video-os-lite/auth.js',
  'api/video-os-lite/checkout-v2.js',
  'api/video-os-lite/download-v2.js',
  'api/video-os-lite/finalize-v2.js',
  'api/video-os-lite/render-v2.js',
  'api/video-os-lite/stripe-webhook-v2.js',
  'api/video-os-lite/uploads.js',
  'api/video-os-lite/workspace.js',
  'api/video-os/talent.js',
  'docs/execution-notes/20261006-diagnostic-maintenance-gate.md',
  'lib/diagnostic-maintenance-gate.js',
  'lib/production-db-binding-diagnostic.js',
  'routes/video-os-lite/admin.js',
  'tests/db-binding-diagnostic-build-policy.test.mjs',
  'tests/diagnostic-maintenance-gate.test.mjs',
  'tests/diagnostic-maintenance-server-routing.test.mjs',
  'tests/production-db-binding-diagnostic.test.mjs',
  'tools/build-browser-clients.mjs',
  'tools/build-production.mjs',
  'tools/db-binding-diagnostic-build-policy.mjs',
]);

// Credential and connection variables only; harmless libpq settings such as
// PGSSLMODE, PGCONNECT_TIMEOUT or PGAPPNAME are allowed.
const DATABASE_CREDENTIAL_PREFIXES = Object.freeze(['DATABASE_URL', 'POSTGRES_URL', 'NEON_']);
const DATABASE_CREDENTIAL_NAMES = new Set([
  'POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_HOST', 'POSTGRES_DATABASE',
  'PGPASSWORD', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE',
  'DB_URL', 'SUPABASE_DB_URL',
]);
export function isDatabaseCredentialName(name) {
  const upper = String(name).toUpperCase();
  return DATABASE_CREDENTIAL_NAMES.has(upper) || DATABASE_CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const ENV_SCAN_SKIP = new Set(['node_modules', '.git']);
// Any .env* anywhere in the working tree, tracked, untracked or gitignored.
// Directory symlinks are not followed.
export function localEnvironmentFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.toLowerCase().startsWith('.env') && !entry.isDirectory()) found.push(path);
      else if (entry.isDirectory() && !entry.isSymbolicLink() && !ENV_SCAN_SKIP.has(entry.name)) walk(path);
    }
  };
  if (existsSync(root)) walk('');
  return found;
}

export function diagnosticDatabaseEvidence() {
  return {
    verified: false,
    environment: 'production',
    scope: 'diagnostic-only-live-db-deferred',
    deferredChecks: [
      'canonical DATABASE_URL and optional unpooled target preflight',
      'strict live migration, schema and database identity preflight',
      'canonical DATABASE_URL and optional unpooled target postflight',
      'strict live migration, schema and database identity postflight',
      'preflight/postflight database stability comparison',
    ],
  };
}

export function assertDiagnosticBuildInputs({ root, env, changedPaths, source }) {
  if (source.dirty || !/^[a-f0-9]{40}$/.test(source.head || '')) throw new Error('Diagnostic build requires an exact clean commit.');
  if (source.project?.name !== 'lux-video-os' || source.project?.id !== 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW') throw new Error('Diagnostic build project differs from the reviewed production project.');
  const allowed = new Set(DIAGNOSTIC_PATHS);
  if (changedPaths.length !== allowed.size || changedPaths.some(path => !allowed.has(path))) throw new Error('Diagnostic build source differs from the reviewed path scope.');
  if (env.VIDEO_OS_DB_TARGET_MANIFEST || Object.keys(env).some(isDatabaseCredentialName)) throw new Error('Diagnostic build must not load production database credentials.');
  if (env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN || (env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE && env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE !== 'false')) {
    throw new Error('Diagnostic build must not load an operator token or active maintenance setting.');
  }
  if (localEnvironmentFiles(root).length) throw new Error('Diagnostic build found a local environment file; remove it from this isolated worktree before packaging.');
}

export function diagnosticChangedPaths(root, base = ACTIVE_APP_BASE) {
  const ancestor = spawnSync('git', ['merge-base', 'HEAD', base], { cwd: root, encoding: 'utf8' });
  if (ancestor.status !== 0 || ancestor.stdout.trim() !== base) throw new Error('Diagnostic build is not based on the recorded active source.');
  // Rename detection would report only the destination of a moved file and hide
  // the deleted source path, so compare raw paths with renames disabled.
  const diff = (extra) => {
    const run = spawnSync('git', ['diff', '--no-renames', '--no-ext-diff', '-z', '--name-only', ...extra, base, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (run.status !== 0) throw new Error('Diagnostic build cannot verify the recorded active source base.');
    return run.stdout.split('\0').filter(Boolean);
  };
  // A reviewed path may be modified or added, never deleted: deleting an allowed
  // file (for example a build safeguard) would otherwise still match the scope.
  if (diff(['--diff-filter=D']).length) throw new Error('Diagnostic build source deletes a reviewed path.');
  // A file replaced by a symlink or submodule is a type change, not a reviewed edit.
  if (diff(['--diff-filter=T']).length) throw new Error('Diagnostic build source changes the type of a reviewed path.');
  const changed = diff([]);
  if (changed.length) {
    const tree = spawnSync('git', ['ls-tree', '-z', 'HEAD', '--', ...changed], { cwd: root, encoding: 'utf8' });
    if (tree.status !== 0) throw new Error('Diagnostic build cannot verify reviewed path modes.');
    const modes = new Map(tree.stdout.split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return [line.slice(tab + 1), line.slice(0, line.indexOf(' '))];
    }));
    for (const path of changed) {
      if (!['100644', '100755'].includes(modes.get(path))) throw new Error('Diagnostic build reviewed path is not a regular file.');
    }
  }
  return changed;
}
