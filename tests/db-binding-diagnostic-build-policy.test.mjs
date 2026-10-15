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
  const apiFunctions = new Set(routes.filter(({ dest }) => dest.startsWith('/api/') &&
    !['/api/health.js', '/api/not-found.js'].includes(dest)).map(({ dest }) => dest.slice(1)));
  assert.equal(apiFunctions.size, 9);
  for (const path of apiFunctions) assert.ok(DIAGNOSTIC_PATHS.includes(path), path);
  for (const path of [
    'lib/diagnostic-maintenance-gate.js',
    'lib/operator-diagnostic-guard.js',
    'lib/operator-diagnostic-audit.js',
    'lib/canary-scope-diagnostic.js',
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

test('diagnostic scope is pinned to the reviewed vos-002 base and its explicit 23-file path set', () => {
  assert.equal(ACTIVE_APP_BASE, '61c907e32eea84d65bfe5ab51f0b00f8a265f94f');
  assert.equal(DIAGNOSTIC_PATHS.length, 23);
  assert.equal(new Set(DIAGNOSTIC_PATHS).size, 23);
});

function scratchRepo({ absentFromBase = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'diag-policy-'));
  const git = (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {};
    const run = spawnSync('git', ['-c', 'user.name=policy-test', '-c', 'user.email=policy-test@local', '-c', 'core.autocrlf=false', '-c', 'core.symlinks=false', ...args], { cwd: dir, encoding: 'utf8', ...options });
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
test('database credential and connection variables are rejected; harmless libpq settings are allowed', () => {
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_URL_POOLED', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_URL_NO_SSL',
    'POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_HOST', 'POSTGRES_DATABASE',
    'PGPASSWORD', 'PGHOST', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE', 'pghost',
    'NEON_API_KEY', 'NEON_PROJECT_ID', 'DB_URL', 'SUPABASE_DB_URL']) {
    assert.equal(isDatabaseCredentialName(name), true, name);
    assert.throws(() => assertDiagnosticBuildInputs(input({ env: { [name]: 'synthetic-secret' } })), /database credentials/, name);
  }
  for (const name of ['PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGAPPNAME', 'PGPORT', 'PATH', 'NODE_ENV', 'VERCEL_ENV', 'VIDEO_OS_PUBLIC_ORIGIN', 'POSTGRES_VERSION']) {
    assert.equal(isDatabaseCredentialName(name), false, name);
    assert.doesNotThrow(() => assertDiagnosticBuildInputs(input({ env: { [name]: 'value' } })), name);
  }
});

test('any .env* file anywhere in the working tree is rejected; node_modules and .git are skipped', () => {
  for (const path of ['.env', '.env.local', '.env.staging', '.envrc', '.vercel/.env.production.local', '.vercel/.env',
    'api/.env', 'api/video-os-lite/.env.local', 'config/deep/nested/.env.production', 'tools/.ENV']) {
    const root = mkdtempSync(join(tmpdir(), 'diag-env-'));
    try {
      assert.doesNotThrow(() => assertDiagnosticBuildInputs(input({ root })), 'empty root');
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'X=1\n');
      assert.throws(() => assertDiagnosticBuildInputs(input({ root })), /local environment file/, path);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const root = mkdtempSync(join(tmpdir(), 'diag-env-skip-'));
  try {
    for (const path of ['node_modules/pkg/.env', '.git/.env', 'api/.environment-notes/readme.md']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'X=1\n');
    }
    assert.doesNotThrow(() => assertDiagnosticBuildInputs(input({ root })));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a symlink or gitlink at a reviewed path is rejected (type change and added path)', () => {
  const cases = [
    { mode: '120000', target: 'tools/build-browser-clients.mjs', inBase: true },
    { mode: '160000', target: 'tools/build-browser-clients.mjs', inBase: true },
    { mode: '120000', target: 'lib/diagnostic-maintenance-gate.js', inBase: false },
    { mode: '160000', target: 'lib/diagnostic-maintenance-gate.js', inBase: false },
  ];
  for (const { mode, target, inBase } of cases) {
    const repo = scratchRepo({ absentFromBase: inBase ? [] : [target] });
    try {
      repo.modifyAllowedExcept(target);
      repo.git('add', '-A');
      if (inBase) repo.git('rm', '-q', '--cached', target);
      const object = mode === '120000'
        ? repo.git('hash-object', '-w', '--stdin', '--path=link', { input: '../lib/enrollment-dto.js' })
        : repo.git('rev-parse', 'HEAD');
      repo.git('update-index', '--add', '--cacheinfo', mode + ',' + object + ',' + target);
      repo.git('commit', '-qm', 'candidate');
      assert.match(repo.git('ls-tree', 'HEAD', '--', target), new RegExp('^' + mode + ' '));
      assert.throws(() => accepts(repo.paths()), /type of a reviewed path|not a regular file/, mode + ' ' + target);
    } finally { repo.cleanup(); }
  }
});

test('an executable (100755) reviewed file is still accepted', () => {
  const repo = scratchRepo();
  try {
    repo.modifyAllowedExcept();
    repo.git('add', '-A');
    repo.git('update-index', '--chmod=+x', 'tools/build-production.mjs');
    repo.git('commit', '-qm', 'candidate');
    assert.doesNotThrow(() => accepts(repo.paths()));
  } finally { repo.cleanup(); }
});
