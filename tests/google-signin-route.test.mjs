// HTTP-handler-level test for the google-login/google-callback routes added
// to api/video-os-lite/auth.js. Follows the same request()/response() mock
// pattern as tests/standard-route-http.test.mjs, and stubs globalThis.fetch
// for the Google token/userinfo calls the same way tests/heygen-identity.test.mjs
// stubs HeyGen's API -- these are the two established conventions for external
// providers in this suite (real DB writes, stubbed third-party HTTP).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { users } from '../db/schema.js';
import authHandler from '../api/video-os-lite/auth.js';
import { verifySessionToken } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

const ORIGIN = 'https://video-os-google-test.invalid';
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  VIDEO_OS_PUBLIC_ORIGIN: process.env.VIDEO_OS_PUBLIC_ORIGIN,
};

function request({ method = 'GET', url, cookie }) {
  return {
    method,
    url,
    headers: { host: 'video-os-google-test.invalid', cookie },
    async *[Symbol.asyncIterator]() {},
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.afterEach(restoreEnvironment);

test('google-login is a clean 501 when GOOGLE_CLIENT_ID/SECRET are not configured', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const res = response();
  await authHandler(request({ url: '/api/video-os-lite/google-login' }), res);
  assert.equal(res.statusCode, 501);
});

test('google-login redirects to Google with a state cookie and matching state param', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  const res = response();
  await authHandler(request({ url: '/api/video-os-lite/google-login' }), res);
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.Location);
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/api/video-os-lite/google-callback`);
  const stateFromUrl = location.searchParams.get('state');
  assert.match(res.headers['Set-Cookie'], /vos_oauth_state=/);
  const cookieState = decodeURIComponent(res.headers['Set-Cookie'].match(/vos_oauth_state=([^;]+)/)[1]);
  assert.equal(cookieState, stateFromUrl);
});

test('google-callback rejects a missing or mismatched state before calling Google', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called'); };

  const noState = response();
  await authHandler(request({ url: '/api/video-os-lite/google-callback?code=abc' }), noState);
  assert.equal(noState.statusCode, 401);

  const mismatched = response();
  await authHandler(request({ url: '/api/video-os-lite/google-callback?code=abc&state=wrong', cookie: 'vos_oauth_state=right' }), mismatched);
  assert.equal(mismatched.statusCode, 401);
  assert.equal(fetchCalled, false);
});

test('google-callback rejects Google-reported errors (e.g. user cancelled consent)', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  const res = response();
  await authHandler(request({ url: '/api/video-os-lite/google-callback?error=access_denied' }), res);
  assert.equal(res.statusCode, 401);
});

test(
  'google-callback with a verified state exchanges the code, creates the account, and signs in',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    const email = `google-signin-test-${crypto.randomUUID()}@example.com`;
    t.after(async () => {
      const accountId = `user-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 24)}`;
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    globalThis.fetch = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
      if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ email, email_verified: true, name: 'Google Test User', sub: 'google-sub-proof' }), { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    };

    const state = 'proof-state-value';
    const res = response();
    await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${state}`, cookie: `vos_oauth_state=${state}` }), res);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, '/?signed_in=1');
    const setCookies = [].concat(res.headers['Set-Cookie']);
    const sessionCookieHeader = setCookies.find((cookie) => cookie.startsWith('vos_session='));
    assert.ok(sessionCookieHeader, 'a session cookie must be issued');
    const token = decodeURIComponent(sessionCookieHeader.split(';')[0].split('=')[1]);
    const payload = verifySessionToken(token);
    assert.equal(payload.email, email.toLowerCase());
    assert.ok(setCookies.some((cookie) => cookie.startsWith('vos_oauth_state=') && cookie.includes('Max-Age=0')), 'the state cookie must be cleared');
  },
);

test('google-callback rejects an unverified Google email without creating a session', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
    return new Response(JSON.stringify({ email: 'unverified@example.com', email_verified: false }), { status: 200 });
  };
  const state = 'proof-state-value-2';
  const res = response();
  await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${state}`, cookie: `vos_oauth_state=${state}` }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['Set-Cookie'], undefined);
});
