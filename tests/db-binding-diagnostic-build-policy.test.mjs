import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDiagnosticBuildInputs, diagnosticDatabaseEvidence, DIAGNOSTIC_PATHS } from '../tools/db-binding-diagnostic-build-policy.mjs';

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
