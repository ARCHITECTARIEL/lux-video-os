// Proves server/index.js's routing actually reproduces vercel.json's
// src/dest table against a real listening socket -- not just that the
// regex-building code parses, but that requests for a static asset, the
// SPA fallback, and a real API handler all resolve to the right file and
// produce the right response, the same way Vercel's router would.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createServer, logUncaughtException, logUnhandledRejection } from '../server/index.js';

async function withServer(run) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('server router: healthz responds without touching the route table', async () => {
  await withServer(async (base) => {
    const res = await request(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('server router: static JS asset is served from public/ with the right content type', async () => {
  await withServer(async (base) => {
    const res = await request(`${base}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/javascript/);
    assert.ok(res.body.length > 0);
  });
});

test('server router: explicit /public/ prefixed dest (/admin-console) and implicit (/identity) both resolve', async () => {
  await withServer(async (base) => {
    const adminConsole = await request(`${base}/admin-console`);
    assert.equal(adminConsole.status, 200);
    assert.equal(adminConsole.headers['cache-control'], 'no-store');
    const identity = await request(`${base}/identity`);
    assert.equal(identity.status, 200);
    assert.match(identity.body, /<html/i);
  });
});

test('server router: retired /dashboard route falls back to the SPA shell, not the legacy cockpit', async () => {
  await withServer(async (base) => {
    const res = await request(`${base}/dashboard`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /Hosted MVP Mode/);
  });
});

test('server router: unmatched deep path falls back to the SPA shell', async () => {
  await withServer(async (base) => {
    const res = await request(`${base}/some/deep/client/route`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<html/i);
  });
});

test('server router: a real API route dispatches to its handler and gets a structured JSON response', async () => {
  await withServer(async (base) => {
    const res = await request(`${base}/api/video-os-lite/providers`);
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
  });
});

test('server router: a POST body is readable via readJson() after transport-level buffering', async () => {
  await withServer(async (base) => {
    // auth-request reads the body with readJson() (not req.body) and only
    // fails past that point on missing RESEND_API_KEY config -- reaching
    // that 501 proves the buffered/replayed body was parsed successfully.
    const res = await request(`${base}/api/video-os-lite/auth-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    assert.equal(res.status, 501);
    assert.match(JSON.parse(res.body).error, /Email sign-in is not configured/);
  });
});

test('server router: enrollment and scripted APIs dispatch through the shared workspace function', async () => {
  await withServer(async (base) => {
    for (const route of ['enrollments', 'scripted-photo']) {
      const res = await request(`${base}/api/video-os-lite/${route}`);
      assert.equal(res.status, 401, route);
      assert.equal(JSON.parse(res.body).ok, false);
    }
    const upload = await request(`${base}/api/video-os-lite/enrollment-upload`);
    assert.equal(upload.status, 405);
    assert.match(JSON.parse(upload.body).error, /POST/);
  });
});

test('server router: a matched static route whose file is missing on disk 404s cleanly', async () => {
  await withServer(async (base) => {
    // vercel.json's file-extension rule matches this path (it ends in
    // .png), but nothing on disk backs it -- proves the missing-file
    // branch in serveStatic()/send404() is reachable and doesn't throw,
    // distinct from paths that fall through to the SPA index.html rule.
    const res = await request(`${base}/this-file-does-not-exist.png`);
    assert.equal(res.status, 404);
  });
});

test('logUncaughtException logs a structured, diagnosable line and exits 1 rather than hanging or crashing silently', () => {
  const logged = [];
  const exitCodes = [];
  logUncaughtException(new Error('simulated background-timer bug'), { error: (line) => logged.push(line) }, (code) => exitCodes.push(code));
  assert.equal(exitCodes.length, 1);
  assert.equal(exitCodes[0], 1);
  const parsed = JSON.parse(logged[0]);
  assert.equal(parsed.event, 'server.uncaught_exception');
  assert.match(parsed.error, /simulated background-timer bug/);
});

test('logUnhandledRejection logs a structured, diagnosable line and exits 1', () => {
  const logged = [];
  const exitCodes = [];
  logUnhandledRejection(new Error('simulated unawaited promise'), { error: (line) => logged.push(line) }, (code) => exitCodes.push(code));
  assert.equal(exitCodes.length, 1);
  assert.equal(exitCodes[0], 1);
  const parsed = JSON.parse(logged[0]);
  assert.equal(parsed.event, 'server.unhandled_rejection');
  assert.match(parsed.reason, /simulated unawaited promise/);
});

test('logUnhandledRejection handles a non-Error rejection reason without throwing', () => {
  const logged = [];
  logUnhandledRejection('a plain string rejection reason', { error: (line) => logged.push(line) }, () => {});
  const parsed = JSON.parse(logged[0]);
  assert.match(parsed.reason, /a plain string rejection reason/);
});
