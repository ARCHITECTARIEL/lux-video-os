import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import auth from '../api/video-os-lite/auth.js';
import checkout from '../api/video-os-lite/checkout-v2.js';
import download from '../api/video-os-lite/download-v2.js';
import finalize from '../api/video-os-lite/finalize-v2.js';
import render from '../api/video-os-lite/render-v2.js';
import stripeWebhook from '../api/video-os-lite/stripe-webhook-v2.js';
import uploads from '../api/video-os-lite/uploads.js';
import workspace from '../api/video-os-lite/workspace.js';
import talent from '../api/video-os/talent.js';
import { blockForDiagnosticMaintenance, diagnosticMaintenanceMode } from '../lib/diagnostic-maintenance-gate.js';

const handlers = [
  [auth, '/api/video-os-lite/session'],
  [checkout, '/api/video-os-lite/checkout'],
  [download, '/api/video-os-lite/download'],
  [finalize, '/api/video-os-lite/finalize'],
  [render, '/api/video-os-lite/render'],
  [stripeWebhook, '/api/video-os-lite/stripe-webhook'],
  [uploads, '/api/video-os-lite/uploads'],
  [workspace, '/api/video-os-lite/admin'],
  [talent, '/api/video-os/talent'],
];

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body += String(value); this.headersSent = true; this.endCalls = (this.endCalls || 0) + 1; },
  };
}

const byDestination = new Map([
  ['/api/video-os-lite/auth.js', auth],
  ['/api/video-os-lite/checkout-v2.js', checkout],
  ['/api/video-os-lite/download-v2.js', download],
  ['/api/video-os-lite/finalize-v2.js', finalize],
  ['/api/video-os-lite/render-v2.js', render],
  ['/api/video-os-lite/stripe-webhook-v2.js', stripeWebhook],
  ['/api/video-os-lite/uploads.js', uploads],
  ['/api/video-os-lite/workspace.js', workspace],
  ['/api/video-os/talent.js', talent],
]);
const mappedApiRoutes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  .routes.filter(({ dest }) => dest.startsWith('/api/'));

function setMode(value) {
  if (value === undefined) delete process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
  else process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = value;
}

function poisonedRequest(method, url) {
  const req = { method, url };
  for (const field of ['headers', 'body']) {
    Object.defineProperty(req, field, { get() { throw new Error(`${field} read before maintenance denial`); } });
  }
  req[Symbol.asyncIterator] = async function* () { throw new Error('request body streamed before maintenance denial'); };
  return req;
}

test('all nine API entrypoints retain their unsupported-method response with maintenance absent or false', async () => {
  const prior = process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
  try {
    for (const mode of [undefined, 'false']) {
      if (mode === undefined) delete process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
      else process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = mode;
      for (const [handler, url] of handlers) {
        const res = response();
        await handler({ method: 'DELETE', url, headers: { host: 'lux-video-os.vercel.app' } }, res);
        assert.equal(res.statusCode, 405, `${url} in mode ${mode}`);
      }
    }
  } finally {
    if (prior === undefined) delete process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
    else process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = prior;
  }
});

test('active mode denies all 26 mapped aliases and direct function paths before input or network side effects', async () => {
  assert.equal(mappedApiRoutes.length, 26);
  assert.equal(new Set(mappedApiRoutes.map(({ dest }) => dest)).size, 9);
  assert.deepEqual(new Set(mappedApiRoutes.map(({ dest }) => dest)), new Set(byDestination.keys()));
  const priorMode = process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
  const priorFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    setMode('true');
    globalThis.fetch = async () => { networkCalls += 1; throw new Error('unexpected network call'); };
    const paths = [
      ...mappedApiRoutes.map(({ src, dest }) => [src, byDestination.get(dest)]),
      ...[...byDestination].map(([dest, handler]) => [dest, handler]),
    ];
    for (const [url, handler] of paths) {
      for (const method of ['GET', 'POST', 'OPTIONS', 'DELETE']) {
        const res = response();
        await handler(poisonedRequest(method, url), res);
        assert.equal(res.statusCode, 503, `${method} ${url}`);
        assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'diagnostic_maintenance_active' });
        assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0');
        assert.equal(res.headers['retry-after'], '60');
        assert.equal(res.endCalls, 1);
      }
    }
    assert.equal(networkCalls, 0);
  } finally {
    setMode(priorMode);
    globalThis.fetch = priorFetch;
  }
});

test('only the byte-exact diagnostic GET passes the admission helper', () => {
  const env = { VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'true' };
  const exact = '/api/video-os-lite/admin?operation=db-binding';
  assert.equal(blockForDiagnosticMaintenance({ method: 'GET', url: exact }, response(), { env, allowDiagnostic: true }), false);
  for (const [method, url] of [
    ['POST', exact], ['HEAD', exact], ['OPTIONS', exact],
    ['GET', '/api/video-os-lite/admin?operation=db-binding&operation=grant-credit'],
    ['GET', '/api/video-os-lite/admin?oper%61tion=db-binding'],
    ['GET', '/api/video-os-lite/admin?operation=db-binding&extra=1'],
    ['GET', '/api/video-os-lite/admin/?operation=db-binding'],
    ['GET', '/api/video-os-lite/workspace.js?operation=db-binding'],
    ['GET', 'https://lux-video-os.vercel.app/api/video-os-lite/admin?operation=db-binding'],
  ]) {
    const res = response();
    assert.equal(blockForDiagnosticMaintenance({ method, url }, res, { env, allowDiagnostic: true }), true, `${method} ${url}`);
    assert.equal(res.statusCode, 503);
  }
  const otherFunction = response();
  assert.equal(blockForDiagnosticMaintenance({ method: 'GET', url: exact }, otherFunction, { env }), true);
  assert.equal(otherFunction.statusCode, 503);
});

test('malformed maintenance settings fail closed, including on the diagnostic path', async () => {
  const prior = process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE;
  try {
    for (const mode of ['', 'TRUE', ' true ', '0', 'false ']) {
      setMode(mode);
      assert.equal(diagnosticMaintenanceMode(), 'invalid', mode);
      const res = response();
      await workspace(poisonedRequest('GET', '/api/video-os-lite/admin?operation=db-binding'), res);
      assert.equal(res.statusCode, 503, mode);
      assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'maintenance_configuration_invalid' });
    }
  } finally {
    setMode(prior);
  }
});

test('diagnostic authentication remains separate while active; expiry never reopens other APIs', async () => {
  const keys = [
    'VIDEO_OS_DIAGNOSTIC_MAINTENANCE', 'VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED',
    'VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT', 'VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT',
    'VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN', 'VIDEO_OS_ADMIN_TOKEN', 'CRON_SECRET',
    'VERCEL_ENV', 'VERCEL_URL',
  ];
  const prior = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    const now = Date.now();
    process.env.VIDEO_OS_DIAGNOSTIC_MAINTENANCE = 'true';
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED = 'true';
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT = new Date(now - 1000).toISOString();
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT = new Date(now + 60_000).toISOString();
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN = 'synthetic-diagnostic-token';
    process.env.VIDEO_OS_ADMIN_TOKEN = 'synthetic-admin-token';
    process.env.CRON_SECRET = 'synthetic-cron-token';
    process.env.VERCEL_ENV = 'production';
    const url = '/api/video-os-lite/admin?operation=db-binding';
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer synthetic-admin-token', 'Bearer synthetic-cron-token']) {
      const res = response();
      await workspace({ method: 'GET', url, headers: { host: 'lux-video-os.vercel.app', authorization } }, res);
      assert.equal(res.statusCode, 401);
      assert.equal(JSON.parse(res.body).code, 'operator_required');
    }
    const accepted = response();
    await workspace({ method: 'GET', url, headers: { host: 'lux-video-os.vercel.app', authorization: 'Bearer synthetic-diagnostic-token' } }, accepted);
    assert.equal(accepted.statusCode, 400);
    assert.equal(JSON.parse(accepted.body).code, 'expected_identity_required');
    const uniqueHost = 'fixture-deployment-lux-projects.vercel.app';
    process.env.VERCEL_URL = uniqueHost;
    const unique = response();
    await workspace({ method: 'GET', url, headers: {
      host: uniqueHost,
      authorization: 'Bearer synthetic-diagnostic-token',
      'x-expected-deployment-url-sha256': createHash('sha256').update(uniqueHost).digest('hex'),
    } }, unique);
    assert.equal(unique.statusCode, 400);
    assert.equal(JSON.parse(unique.body).code, 'expected_identity_required');

    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT = new Date(now - 1).toISOString();
    const expired = response();
    await workspace({ method: 'GET', url, headers: { host: 'lux-video-os.vercel.app', authorization: 'Bearer synthetic-diagnostic-token' } }, expired);
    assert.equal(expired.statusCode, 404);
    const blocked = response();
    await checkout(poisonedRequest('POST', '/api/video-os-lite/checkout'), blocked);
    assert.equal(blocked.statusCode, 503);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
