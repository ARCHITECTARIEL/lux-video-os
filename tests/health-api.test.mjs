import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHealthHandler } from '../lib/health.js';
import notFound from '../lib/api-not-found.js';

function response() {
  const headers = {};
  return {
    headers, statusCode: 200, body: '',
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body) { this.body = body || ''; },
  };
}

async function health(method = 'GET', overrides = {}, deps = {}) {
  const res = response();
  await createHealthHandler({
    env: {
      DATABASE_URL: 'postgres://db-secret.invalid/app', BLOB_READ_WRITE_TOKEN: 'blob-secret',
      HEYGEN_API_KEY: 'provider-secret', VERCEL_DEPLOYMENT_ID: 'deployment-123',
      VERCEL_GIT_COMMIT_SHA: 'abc123', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_ENV: 'production',
      ...overrides,
    },
    dbProbe: async () => {}, lastSweep: async () => '2026-10-15T00:00:00.000Z', ...deps,
  })({ method }, res);
  return res;
}

test('health reports an ok JSON response with identity, checks, and short CDN cache', async () => {
  const res = await health();
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, s-maxage=15, max-age=0');
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'lux-video-os');
  assert.equal(body.deploymentId, 'deployment-123');
  assert.equal(body.gitSha, 'abc123');
  assert.equal(body.gitRef, 'main');
  assert.equal(body.env, 'production');
  assert.ok(Date.parse(body.startedAt));
  assert.ok(Date.parse(body.checkedAt));
  assert.deepEqual(body.checks.blob, { ok: true, critical: true, configured: true });
  assert.deepEqual(body.checks.provider, { ok: true, critical: false, configured: true });
  assert.equal(body.checks.db.ok, true);
  assert.equal(body.checks.watchdog.lastSweepAt, '2026-10-15T00:00:00.000Z');
});

test('health fails on missing and unavailable DB or Blob; degrades on missing provider', async () => {
  for (const [env, deps, statusCode, status, check] of [
    [{ DATABASE_URL: '' }, {}, 503, 'fail', 'db'],
    [{}, { dbProbe: async () => { throw new Error('postgres://private.invalid'); } }, 503, 'fail', 'db'],
    [{ BLOB_READ_WRITE_TOKEN: '' }, {}, 503, 'fail', 'blob'],
    [{ HEYGEN_API_KEY: '' }, {}, 200, 'degraded', 'provider'],
  ]) {
    const res = await health('GET', env, deps);
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, statusCode);
    assert.equal(body.status, status);
    assert.equal(body.checks[check].ok, false);
    assert.doesNotMatch(res.body, /private\.invalid|postgres:\/\//);
  }
});

test('health DB timeout is fail with a sanitized code', async () => {
  const res = await health('GET', {}, { dbProbe: () => new Promise(() => {}) });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).checks.db.code, 'db_timeout');
});

test('health never echoes configuration secrets and nulls absent deployment identity', async () => {
  const res = await health('GET', {
    DATABASE_URL: 'postgres://SENTINEL_DB@private.invalid/app',
    BLOB_READ_WRITE_TOKEN: 'SENTINEL_BLOB', HEYGEN_API_KEY: 'SENTINEL_PROVIDER',
    VERCEL_DEPLOYMENT_ID: '', VERCEL_GIT_COMMIT_SHA: '',
  });
  assert.equal(JSON.parse(res.body).deploymentId, null);
  assert.equal(JSON.parse(res.body).gitSha, null);
  assert.doesNotMatch(res.body, /SENTINEL_|postgres:\/\//);
});

test('health HEAD is bodyless and POST returns 405 JSON', async () => {
  const head = await health('HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const post = await health('POST');
  assert.equal(post.statusCode, 405);
  assert.equal(JSON.parse(post.body).code, 'method_not_allowed');
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('API fallback gives JSON 404 for any method and drops query text', () => {
  for (const method of ['GET', 'POST']) {
    const res = response();
    notFound({ method, url: '/api/zz-unknown?token=SENTINEL' }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'not_found', path: '/api/zz-unknown' });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('Vercel routes preserve explicit API and static destinations before fallback', () => {
  const routes = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url))).routes;
  const resolve = path => routes.find(route => new RegExp(`^${route.src}$`).test(path))?.dest;
  assert.equal(resolve('/api/health'), '/api/video-os-lite/workspace.js');
  assert.equal(resolve('/api/zz-unknown'), '/api/video-os-lite/workspace.js');
  for (const path of ['script', 'export', 'account', 'finish', 'avatar', 'assets', 'assets/recommend']) {
    assert.equal(resolve(`/api/video-os-lite/${path}`), '/api/video-os-lite/workspace.js', path);
  }
  for (const [path, dest] of [
    ['/api/video-os-lite/admin', '/api/video-os-lite/workspace.js'],
    ['/api/video-os-lite/render', '/api/video-os-lite/render-v2.js'],
    ['/api/video-os-lite/checkout', '/api/video-os-lite/checkout-v2.js'],
    ['/api/video-os-lite/stripe-webhook', '/api/video-os-lite/stripe-webhook-v2.js'],
    ['/api/video-os-lite/luxify', '/api/video-os-lite/workspace.js'],
    ['/api/video-os/talent', '/api/video-os/talent.js'],
    ['/welcome', '/landing.html'],
    ['/captions.vtt', '/$1'],
  ]) assert.equal(resolve(path), dest, path);
  const apiFallback = routes.findIndex(route => route.src === '/api/(.*)');
  assert.ok(apiFallback > routes.findIndex(route => route.src === '/api/video-os-lite/admin'));
  assert.ok(apiFallback < routes.findIndex(route => route.src === '/(.*\\.vtt)'));
  assert.ok(apiFallback < routes.findIndex(route => route.src === '/(.*)'));
});
