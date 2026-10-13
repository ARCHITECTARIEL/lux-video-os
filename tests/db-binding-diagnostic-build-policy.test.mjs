import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACTIVE_APP_BASE, assertDiagnosticBuildInputs, diagnosticChangedPaths, diagnosticDatabaseEvidence, DIAGNOSTIC_PATHS, isDatabaseCredentialName } from '../tools/db-binding-diagnostic-build-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = { head: 'a'.repeat(40), dirty: false, project: { name: 'lux-video-os', id: 'prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW' } };
const input = (overrides = {}) => ({ root, env: {}, changedPaths: [...DIAGNOSTIC_PATHS], source, ...overrides });

test('diagnostic production evidence explicitly leaves only live database checks unresolved', () => {
  const evidence = diagnosticDatabaseEvidence();
  assert.equal(evidence.verified, false);
  assert.equal(evidence.environment, 'production');
  assert.deepEqual(evidence.deferredChecks, [
    'canonical DATABASE_URL and optional unpooled target preflight',
    'strict live migration, schema and database identity preflight',
    'canonical DATABASE_URL and optional unpooled target postflight',
    'strict live migration, schema and database identity postflight',
    'preflight/postflight database stability comparison',
  ]);
});

test('diagnostic packaging requires clean reviewed project and bounded paths', () => {
  assert.doesNotThrow(() => assertDiagnosticBuildInputs(input()));
  for (const invalid of [
    { source: { ...source, dirty: true } },
    { source: { ...source, project: { ...source.project, id: 'wrong' } } },
    { changedPaths: ['db/canceled-standard-job-repair.js'] },
    { changedPaths: ['routes/video-os-lite/identities.js'] },
    { changedPaths: DIAGNOSTIC_PATHS.slice(1) },
    { changedPaths: [...DIAGNOSTIC_PATHS, 'db/canceled-standard-job-repair.js'] },
    { changedPaths: [] },
  ]) assert.throws(() => assertDiagnosticBuildInputs(input(invalid)));
});

test('diagnostic packaging rejects database credentials in process memory', () => {
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'VIDEO_OS_DB_TARGET_MANIFEST']) {
    assert.throws(() => assertDiagnosticBuildInputs(input({ env: { [name]: 'synthetic-secret' } })));
  }
});

test('reviewed path scope covers every deployed API function and the maintenance guard', () => {
  const routes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).routes;
  const apiFunctions = new Set(routes.filter(({ dest }) => dest.startsWith('/api/')).map(({ dest }) => dest.slice(1)));
  assert.equal(apiFunctions.size, 9);
  for (const path of apiFunctions) assert.ok(DIAGNOSTIC_PATHS.includes(path), path);
  for (const path of [
    'lib/diagnostic-maintenance-gate.js',
    'tests/diagnostic-maintenance-gate.test.mjs',
    'tests/diagnostic-maintenance-server-routing.test.mjs',
    'docs/execution-notes/20261006-diagnostic-maintenance-gate.md',
    'tools/build-browser-clients.mjs',
  ]) assert.ok(DIAGNOSTIC_PATHS.includes(path), path);
  assert.equal(DIAGNOSTIC_PATHS.some((path) => path.startsWith('db/') || path.startsWith('workflows/')), false);
});

test('diagnostic packaging rejects a local operator token or active maintenance mode', () => {
  for (const env of [
    { VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN: 'synthetic-only' },
    { VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'true' },
    { VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'malformed' },
  ]) assert.throws(() => assertDiagnosticBuildInputs(input({ env })));
  assert.doesNotThrow(() => assertDiagnosticBuildInputs(input({ env: { VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'false' } })));
});

test('diagnostic scope is pinned to the reviewed vos-002 base and its exact 20-file RC delta', () => {
  assert.equal(ACTIVE_APP_BASE, '61c907e32eea84d65bfe5ab51f0b00f8a265f94f');
  assert.equal(DIAGNOSTIC_PATHS.length, 20);
  assert.equal(new Set(DIAGNOSTIC_PATHS).size, 20);
});

function scratchRepo({ absentFromBase = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'diag-policy-'));
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=policy-test', '-c', 'user.email=policy-test@local', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const write = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  git('init', '-q');
  for (const path of DIAGNOSTIC_PATHS) if (!absentFromBase.includes(path)) write(path, 'base ' + path + '\n');
  write('lib/enrollment-dto.js', 'export const enrollmentDto = "unreviewed runtime file";\n'.repeat(20));
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const modifyAllowedExcept = (...skip) => { for (const path of DIAGNOSTIC_PATHS) if (!skip.includes(path)) write(path, 'reviewed ' + path + '\n'); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'candidate'); };
  const paths = () => diagnosticChangedPaths(dir, base);
  return { dir, base, git, write, modifyAllowedExcept, commit, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const accepts = (changedPaths) => assertDiagnosticBuildInputs(input({ changedPaths }));

test('control: a candidate changing exactly the reviewed paths is accepted', () => {
  const repo = scratchRepo();
  try { repo.modifyAllowedExcept(); repo.commit(); assert.doesNotThrow(() => accepts(repo.paths())); } finally { repo.cleanup(); }
});

test('QA rename attack: unreviewed file moved onto a reviewed path is rejected', () => {
  // lib/diagnostic-maintenance-gate.js is new relative to the real base, which is the case
  // where default rename detection reports only the destination and hides the deletion.
  for (const absentFromBase of [['lib/diagnostic-maintenance-gate.js'], []]) {
    const repo = scratchRepo({ absentFromBase });
    try {
      repo.modifyAllowedExcept('lib/diagnostic-maintenance-gate.js');
      if (!absentFromBase.length) repo.git('rm', '-q', 'lib/diagnostic-maintenance-gate.js');
      repo.git('mv', 'lib/enrollment-dto.js', 'lib/diagnostic-maintenance-gate.js');
      repo.commit();
      if (absentFromBase.length) {
        const withRenames = repo.git('diff', '-M', '--name-only', repo.base, 'HEAD').split(/\r?\n/);
        assert.equal(withRenames.includes('lib/enrollment-dto.js'), false, 'rename detection hides the moved source');
      }
      assert.throws(() => accepts(repo.paths()), /deletes a reviewed path|reviewed path scope/);
    } finally { repo.cleanup(); }
  }
});

test('hidden deletion of the browser-client build safeguard is rejected', () => {
  for (const variant of ['delete', 'move-onto-reviewed-path']) {
    const repo = scratchRepo();
    try {
      if (variant === 'delete') {
        repo.modifyAllowedExcept('tools/build-browser-clients.mjs');
        repo.git('rm', '-q', 'tools/build-browser-clients.mjs');
      } else {
        repo.modifyAllowedExcept('tools/build-browser-clients.mjs', 'lib/diagnostic-maintenance-gate.js');
        repo.git('rm', '-q', 'lib/diagnostic-maintenance-gate.js');
        repo.git('mv', 'tools/build-browser-clients.mjs', 'lib/diagnostic-maintenance-gate.js');
      }
      repo.commit();
      assert.throws(() => accepts(repo.paths()), /deletes a reviewed path|reviewed path scope/, variant);
    } finally { repo.cleanup(); }
  }
});

test('any database connection variable family is rejected', () => {
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_URL_POOLED', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_URL_NO_SSL',
    'NEON_API_KEY', 'NEON_PROJECT_ID', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT', 'PGSSLMODE', 'pghost']) {
    assert.equal(isDatabaseCredentialName(name), true, name);
    assert.throws(() => assertDiagnosticBuildInputs(input({ env: { [name]: 'synthetic-secret' } })), /database credentials/, name);
  }
  for (const name of ['PATH', 'NODE_ENV', 'VERCEL_ENV', 'VIDEO_OS_PUBLIC_ORIGIN']) assert.equal(isDatabaseCredentialName(name), false, name);
});

test('any root .env* or .vercel/.env* file is rejected', () => {
  for (const path of ['.env', '.env.local', '.env.preview', '.env.development.local', '.env.staging', '.envrc', '.vercel/.env.production.local', '.vercel/.env.preview.local', '.vercel/.env']) {
    const root = mkdtempSync(join(tmpdir(), 'diag-env-'));
    try {
      assert.doesNotThrow(() => assertDiagnosticBuildInputs(input({ root })), 'empty root');
      mkdirSync(join(root, '.vercel'), { recursive: true });
      writeFileSync(join(root, path), 'X=1\n');
      assert.throws(() => assertDiagnosticBuildInputs(input({ root })), /local environment file/, path);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
