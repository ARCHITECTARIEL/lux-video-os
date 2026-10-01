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
import { getAccountContext } from '../db/repositories.js';
import { accountIdForEmail } from '../lib/video-os-account.js';
import { verifySessionToken } from '../lib/video-os-account.js';
import { isTesterAccountId } from '../lib/video-os-security.js';

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
  VIDEO_OS_RENDER_ACCOUNT_ID: process.env.VIDEO_OS_RENDER_ACCOUNT_ID,
  VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS: process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS,
  // Not read by google-login (the 501-when-unconfigured test below deletes
  // GOOGLE_CLIENT_ID/SECRET directly and doesn't need this), but
  // google-callback's makeSession() does -- a bare .env.local dev checkout
  // may not define this, which otherwise turns every live-DB test in this
  // file into a confusing 501 that has nothing to do with Google config.
  VIDEO_OS_SESSION_SECRET: process.env.VIDEO_OS_SESSION_SECRET,
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
    if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'google-signin-route-test-secret-with-adequate-length';
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

test(
  'google-callback grants liveRendering and standardRendering only when the resulting account is on the render allowlist',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'google-signin-route-test-secret-with-adequate-length';
    const allowedEmail = `google-allowlisted-${crypto.randomUUID()}@example.com`;
    const deniedEmail = `google-not-allowlisted-${crypto.randomUUID()}@example.com`;
    const allowedAccountId = accountIdForEmail(allowedEmail);
    t.after(async () => {
      await database().delete(users).where(eq(users.id, allowedAccountId)).catch(() => {});
      await database().delete(users).where(eq(users.id, accountIdForEmail(deniedEmail))).catch(() => {});
    });
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${allowedAccountId}`;

    async function signIn(email, state) {
      globalThis.fetch = async (url) => {
        if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
        if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ email, email_verified: true, name: 'Google Test User' }), { status: 200 });
        throw new Error(`unexpected fetch to ${url}`);
      };
      const res = response();
      await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${state}`, cookie: `vos_oauth_state=${state}` }), res);
      assert.equal(res.statusCode, 302);
    }

    await signIn(allowedEmail, 'allowlisted-state');
    const allowedContext = await getAccountContext(allowedAccountId);
    assert.equal(allowedContext.entitlements.liveRendering, true, 'an allowlisted account must get liveRendering so the frontend Premium gate opens too');
    assert.equal(allowedContext.entitlements.standardRendering, true, 'an allowlisted account must also get standardRendering, or requireCurrentEntitlement() blocks every Standard-tier request');
    assert.equal(allowedContext.entitlements.googleAccess, true);

    await signIn(deniedEmail, 'denied-state');
    const deniedContext = await getAccountContext(accountIdForEmail(deniedEmail));
    assert.equal(deniedContext.entitlements.liveRendering, undefined, 'an account outside the allowlist must not get liveRendering');
    assert.equal(deniedContext.entitlements.standardRendering, undefined, 'an account outside the allowlist must not get standardRendering');
  },
);

test(
  'google-callback grants standardRendering only (never liveRendering) via VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS, independent of the ID allowlist',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'google-signin-route-test-secret-with-adequate-length';
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account-not-in-this-test';
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const domainEmail = `google-domain-${crypto.randomUUID()}@trusted-test-domain.example`;
    const domainAccountId = accountIdForEmail(domainEmail);
    t.after(async () => {
      await database().delete(users).where(eq(users.id, domainAccountId)).catch(() => {});
    });

    globalThis.fetch = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
      if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ email: domainEmail, email_verified: true, name: 'Domain Test User' }), { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    };
    const state = 'domain-allowed-state';
    const res = response();
    await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${state}`, cookie: `vos_oauth_state=${state}` }), res);
    assert.equal(res.statusCode, 302);

    const context = await getAccountContext(domainAccountId);
    assert.equal(context.entitlements.standardRendering, true, 'a domain-matched account must get standardRendering');
    assert.equal(context.entitlements.liveRendering, undefined, 'a domain match must never grant liveRendering -- Premium\'s backend gate only checks accountId, not email, so granting it here would recreate a real gate mismatch');
  },
);

// Real bug found and fixed during a follow-up beta-test pass (2026-09-28):
// a pure domain match sets role: 'tester' purely for the extra-starting-
// credits/admin-visibility distinction (deliberately broad, unrelated to
// entitlement granting) -- but updateAuthenticatedAccount() used to call
// registerTesterAccountId() whenever role === 'tester', silently
// registering the account into the global tester-bypass set on its very
// FIRST sign-in. isTesterAccountId() is then treated by
// containedRenderingEntitlementKeys() as equivalent to an exact,
// individually-designated tester -- full liveRendering. So a SECOND
// sign-in by the exact same domain-matched account (or an in-flight
// render-authorization check on the same warm serverless instance) would
// get full Premium, reopening the leak through a fourth path -- the only
// one of the four found so far that fires on ordinary customer sign-in,
// not an explicit admin action.
test(
  'a pure domain-matched Google sign-in never registers the account into the global tester bypass set -- and a SECOND sign-in still grants Standard only',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'google-signin-route-test-secret-with-adequate-length';
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const domainEmail = `google-domain-registration-${crypto.randomUUID()}@trusted-test-domain.example`;
    const domainAccountId = accountIdForEmail(domainEmail);
    t.after(async () => {
      await database().delete(users).where(eq(users.id, domainAccountId)).catch(() => {});
    });

    globalThis.fetch = async (url) => {
      if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
      if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ email: domainEmail, email_verified: true, name: 'Domain Test User' }), { status: 200 });
      throw new Error(`unexpected fetch to ${url}`);
    };

    assert.equal(isTesterAccountId(domainAccountId), false, 'sanity check: a freshly generated account must not already be tester-registered');

    const firstState = 'domain-registration-state-1';
    const firstRes = response();
    await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${firstState}`, cookie: `vos_oauth_state=${firstState}` }), firstRes);
    assert.equal(firstRes.statusCode, 302);
    assert.equal(isTesterAccountId(domainAccountId), false, 'a pure domain match must NEVER register into the global tester bypass set, even though role is set to \'tester\' for credit-amount purposes -- that is a deliberately separate signal');
    const afterFirst = await getAccountContext(domainAccountId);
    assert.equal(afterFirst.user.role, 'customer');
    const { listAdminTesters } = await import('../db/repositories.js');
    await listAdminTesters();
    assert.equal(afterFirst.entitlements.liveRendering, undefined, 'the first sign-in itself must not grant liveRendering');
    assert.equal(afterFirst.entitlements.standardRendering, true, 'the first sign-in must still grant standardRendering');

    // The real regression: before this fix, the FIRST sign-in's
    // registration side-effect would poison isTesterAccountId() for every
    // sign-in after it. Prove the second sign-in is equally correct.
    const secondState = 'domain-registration-state-2';
    const secondRes = response();
    await authHandler(request({ url: `/api/video-os-lite/google-callback?code=proof-code&state=${secondState}`, cookie: `vos_oauth_state=${secondState}` }), secondRes);
    assert.equal(secondRes.statusCode, 302);
    assert.equal(isTesterAccountId(domainAccountId), false, 'a second sign-in by the same domain-matched account must still not be tester-registered');
    const afterSecond = await getAccountContext(domainAccountId);
    assert.equal(afterSecond.entitlements.liveRendering, undefined, 'a second sign-in by the same pure domain match must still never grant liveRendering -- this is the exact case that was broken before this fix');
    assert.equal(afterSecond.entitlements.standardRendering, true, 'standardRendering must still be correctly granted on the second sign-in');
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
