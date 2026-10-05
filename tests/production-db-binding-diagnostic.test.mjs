import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import target from '../config/database-target.production.json' with { type: 'json' };
import { evaluateProductionDbBinding, handleProductionDbBindingDiagnostic } from '../lib/production-db-binding-diagnostic.js';
import adminHandler from '../routes/video-os-lite/admin.js';
import { makeSession } from '../lib/video-os-account.js';

const NOW = Date.parse('2026-10-05T15:20:00.000Z');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const targetFileSha256 = digest(readFileSync(new URL('../config/database-target.production.json', import.meta.url)));
const deployment = 'fixture-deployment';
const source = 'fixture-source';
const project = 'fixture-project';
const databaseUrl = ['postgresql://', encodeURIComponent(target.roles[0]), ':synthetic-only@',
  target.hosts[0], ':', target.port, '/', target.database, '?sslmode=require'].join('');

test('release baseline is raw UTF-8 JSON accepted by the production build reader', () => {
  const raw = readFileSync(new URL('../config/release-baseline.json', import.meta.url), 'utf8');
  const baseline = JSON.parse(raw);
  assert.equal(baseline.sourceByteAttestation, false);
  assert.equal(baseline.state, 'READY');
});

function options(overrides = {}) {
  const env = {
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED: 'true',
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT: new Date(NOW).toISOString(),
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT: new Date(NOW + 15 * 60_000).toISOString(),
    VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: deployment,
    VERCEL_GIT_COMMIT_SHA: source, VERCEL_PROJECT_ID: project,
    DATABASE_URL: databaseUrl,
    ...overrides.env,
  };
  const req = { method: 'GET', headers: {
    host: 'lux-video-os.vercel.app',
    'x-expected-deployment-sha256': digest(deployment),
    'x-expected-git-commit-sha256': digest(source),
    'x-expected-project-sha256': digest(project),
    'x-expected-target-manifest-sha256': targetFileSha256,
    ...overrides.headers,
  } };
  let queries = 0;
  const db = () => ({ transaction: async (fn, config) => {
    assert.deepEqual(config, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    return fn({ execute: async () => {
      queries += 1;
      return { rows: [{ database: target.database, role: target.roles[0], read_only: 'on' }] };
    } });
  } });
  return { req, env, db, now: NOW, getQueries: () => queries };
}

test('exact deployment, source, project and canonical database match with read-only query', async () => {
  const input = options();
  const result = await evaluateProductionDbBinding(input);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.readOnly, true);
  assert.equal(result.body.sourceByteAttested, false);
  assert.equal(input.getQueries(), 1);
  assert.equal(JSON.stringify(result).includes(databaseUrl), false);
  assert.equal(JSON.stringify(result).includes(target.hosts[0]), false);
});

test('deployment mismatch and wrong target fail before opening the database', async () => {
  const mismatch = options({ headers: { 'x-expected-deployment-sha256': digest('other') } });
  const result = await evaluateProductionDbBinding(mismatch);
  assert.equal(result.status, 409);
  assert.equal(result.body.deploymentMatched, false);
  assert.equal(mismatch.getQueries(), 0);
  const wrongUrl = options({ env: { DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/wrong' } });
  const rejected = await evaluateProductionDbBinding(wrongUrl);
  assert.equal(rejected.body.canonicalUrlMatchesTarget, false);
  assert.equal(wrongUrl.getQueries(), 0);
  const wrongManifest = options({ headers: { 'x-expected-target-manifest-sha256': digest('other manifest') } });
  assert.equal((await evaluateProductionDbBinding(wrongManifest)).body.targetManifestMatched, false);
  assert.equal(wrongManifest.getQueries(), 0);
});

test('diagnostic is off by default and expires within its bounded window', async () => {
  const disabled = options({ env: { VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED: undefined } });
  assert.equal((await evaluateProductionDbBinding(disabled)).status, 404);
  const longWindow = options({ env: { VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT: new Date(NOW + 31 * 60_000).toISOString() } });
  assert.equal((await evaluateProductionDbBinding(longWindow)).status, 404);
  const delayed = options({ env: {
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT: new Date(NOW - 24 * 60 * 60_000).toISOString(),
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT: new Date(NOW + 15 * 60_000).toISOString(),
  } });
  assert.equal((await evaluateProductionDbBinding(delayed)).status, 404);
  assert.equal(disabled.getQueries() + longWindow.getQueries(), 0);
});

test('wrong live identity or a writable transaction never attests', async () => {
  for (const row of [
    { database: 'wrong', role: target.roles[0], read_only: 'on' },
    { database: target.database, role: 'wrong', read_only: 'on' },
    { database: target.database, role: target.roles[0], read_only: 'off' },
  ]) {
    const input = options();
    input.db = () => ({ transaction: async (fn) => fn({ execute: async () => ({ rows: [row] }) }) });
    const result = await evaluateProductionDbBinding(input);
    assert.equal(result.status, 409);
    assert.equal(result.body.connectedDatabaseMatchesTarget, false);
  }
});

test('wrong host, method, environment and malformed expected digest fail closed', async () => {
  for (const change of [
    { headers: { host: 'unreviewed.invalid' } },
    { env: { VERCEL_ENV: 'preview' } },
    { headers: { 'x-expected-project-sha256': 'invalid' } },
  ]) {
    const input = options(change);
    assert.notEqual((await evaluateProductionDbBinding(input)).status, 200);
    assert.equal(input.getQueries(), 0);
  }
  const input = options(); input.req.method = 'POST';
  assert.equal((await evaluateProductionDbBinding(input)).status, 404);
  assert.equal(input.getQueries(), 0);
});

test('response prevents caching and conceals database failures', async () => {
  const input = options();
  input.db = () => ({ transaction: async () => { throw new Error(databaseUrl); } });
  const headers = {};
  let body;
  const res = { setHeader: (name, value) => { headers[name] = value; }, end: (value) => { body = value; } };
  await handleProductionDbBindingDiagnostic(input.req, res, input);
  assert.equal(res.statusCode, 503);
  assert.match(headers['Cache-Control'], /no-store/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(body.includes(databaseUrl), false);
});

test('admin route excludes cron bearer from diagnostic operator access', async () => {
  const previousAdmin = process.env.VIDEO_OS_ADMIN_TOKEN;
  const previousCron = process.env.CRON_SECRET;
  const previousSession = process.env.VIDEO_OS_SESSION_SECRET;
  process.env.VIDEO_OS_ADMIN_TOKEN = 'synthetic-admin-token';
  process.env.CRON_SECRET = 'synthetic-cron-token';
  process.env.VIDEO_OS_SESSION_SECRET = 'synthetic-diagnostic-test-secret';
  try {
    const cookie = `vos_admin=${encodeURIComponent(makeSession('admin', 'synthetic@fixture.invalid'))}`;
    for (const { auth, cookieHeader } of [
      { auth: 'Bearer synthetic-cron-token' }, { auth: 'synthetic-admin-token' },
      { auth: 'Basic synthetic-admin-token' }, { auth: 'Bearer ' },
      { auth: 'Bearer synthetic-admin-token extra' }, { auth: '', cookieHeader: cookie },
    ]) {
      const req = { method: 'GET', url: '/api/video-os-lite/admin?operation=db-binding',
        headers: { host: 'lux-video-os.vercel.app', authorization: auth, cookie: cookieHeader } };
      const headers = {};
      let body;
      const res = { setHeader: (key, value) => { headers[key] = value; }, end: (value) => { body = value; } };
      await adminHandler(req, res);
      assert.equal(res.statusCode, 401);
      assert.match(headers['Cache-Control'], /no-store/);
      assert.notEqual(JSON.parse(body).ok, true);
    }
    const authorized = { method: 'GET', url: '/api/video-os-lite/admin?operation=db-binding',
      headers: { host: 'lux-video-os.vercel.app', authorization: 'Bearer synthetic-admin-token' } };
    const res = { setHeader() {}, end(value) { this.body = value; } };
    await adminHandler(authorized, res);
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).code, 'diagnostic_unavailable');
  } finally {
    if (previousAdmin === undefined) delete process.env.VIDEO_OS_ADMIN_TOKEN;
    else process.env.VIDEO_OS_ADMIN_TOKEN = previousAdmin;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
    if (previousSession === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    else process.env.VIDEO_OS_SESSION_SECRET = previousSession;
  }
});
