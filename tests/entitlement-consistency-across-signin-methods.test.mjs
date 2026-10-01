// Covers audit finding #2 from the 2026-09-23 deep audit: every sign-in
// method in api/video-os-lite/auth.js used to compute contained-rendering
// eligibility (the VIDEO_OS_RENDER_ACCOUNT_ID allowlist and the
// VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS domain rule) independently -- only
// google-callback actually checked either one. Magic-link and workspace
// login granted their own fixed entitlement sets regardless of eligibility,
// so an eligible account that signed in via a different method than Google
// would silently lose liveRendering/standardRendering, because
// updateAuthenticatedAccount() fully replaces an account's entitlements on
// every sign-in (see reconcileAuthenticatedEntitlements() in
// db/repositories.js). This proves the shared containedRenderingEntitlementKeys()
// helper (lib/video-os-security.js) now makes magic-link compute the same
// answer Google does, and that switching methods no longer loses the grant.
//
// Magic-link tokens live in Blob storage (lib/video-os-account.js's
// saveMagicToken/validateMagicToken), not the database, so these tests need
// both DATABASE_URL and BLOB_READ_WRITE_TOKEN -- same guard pattern as
// tests/admin-route-http.test.mjs's blob-dependent live tests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { entitlements, users } from '../db/schema.js';
import authHandler from '../api/video-os-lite/auth.js';
import { ensureAccount, getAccountContext, listAdminTesters } from '../db/repositories.js';
import { isTesterAccountId } from '../lib/video-os-security.js';
import { accountIdForEmail, saveMagicToken } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

let blobAvailable = dbAvailable;
try {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('no blob token');
} catch {
  blobAvailable = false;
}

const ORIGIN = 'https://video-os-entitlement-consistency-test.invalid';
const originalEnvironment = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  VIDEO_OS_PUBLIC_ORIGIN: process.env.VIDEO_OS_PUBLIC_ORIGIN,
  VIDEO_OS_RENDER_ACCOUNT_ID: process.env.VIDEO_OS_RENDER_ACCOUNT_ID,
  VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS: process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS,
  VIDEO_OS_SESSION_SECRET: process.env.VIDEO_OS_SESSION_SECRET,
};
const originalFetch = globalThis.fetch;

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
test.afterEach(restoreEnvironment);

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

async function verifyMagicLink(email) {
  const { token } = await saveMagicToken(email);
  const res = response();
  await authHandler({
    method: 'GET',
    url: `/api/video-os-lite/auth-verify?token=${encodeURIComponent(token)}`,
    headers: { host: 'video-os-entitlement-consistency-test.invalid' },
    async *[Symbol.asyncIterator]() {},
  }, res);
  assert.equal(res.statusCode, 302, 'auth-verify must succeed for a freshly issued token');
  return res;
}

async function signInWithGoogle(email, state) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'access-token-proof' }), { status: 200 });
    if (String(url).includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ email, email_verified: true, name: 'Google Test User' }), { status: 200 });
    throw new Error(`unexpected fetch to ${url}`);
  };
  const res = response();
  await authHandler({
    method: 'GET',
    url: `/api/video-os-lite/google-callback?code=proof-code&state=${state}`,
    headers: { host: 'video-os-entitlement-consistency-test.invalid', cookie: `vos_oauth_state=${state}` },
    async *[Symbol.asyncIterator]() {},
  }, res);
  assert.equal(res.statusCode, 302);
}

function setupCommonEnv() {
  process.env.GOOGLE_CLIENT_ID = 'client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
  if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'entitlement-consistency-test-secret-with-adequate-length';
}

test(
  'magic-link sign-in grants liveRendering+standardRendering to an account on the ID allowlist (previously granted neither)',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    const email = `magic-allowlisted-${crypto.randomUUID()}@example.com`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${accountId}`;

    await verifyMagicLink(email);
    const context = await getAccountContext(accountId);
    assert.equal(context.entitlements.liveRendering, true, 'an ID-allowlisted account must get liveRendering via magic-link too, not just Google');
    assert.equal(context.entitlements.standardRendering, true, 'an ID-allowlisted account must get standardRendering via magic-link too');
    assert.equal(context.entitlements.magicLinkAccess, true);
  },
);

test(
  'magic-link sign-in grants standardRendering only (never liveRendering) for an email-domain match',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account-not-in-this-test';
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const email = `magic-domain-${crypto.randomUUID()}@trusted-test-domain.example`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });

    await verifyMagicLink(email);
    const context = await getAccountContext(accountId);
    assert.equal(context.entitlements.standardRendering, true, 'a domain-matched account must get standardRendering via magic-link too');
    assert.equal(context.entitlements.liveRendering, undefined, 'a domain match must never grant liveRendering, magic-link included -- Premium\'s backend gate only checks accountId');
  },
);

test(
  'magic-link sign-in grants nothing extra for an account eligible by neither mechanism (no over-grant regression)',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account-not-in-this-test';
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const email = `magic-ineligible-${crypto.randomUUID()}@example.com`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });

    await verifyMagicLink(email);
    const context = await getAccountContext(accountId);
    assert.equal(context.entitlements.liveRendering, undefined);
    assert.equal(context.entitlements.standardRendering, undefined);
    assert.equal(context.entitlements.magicLinkAccess, true, 'the account\'s own real entitlement must still be granted');
  },
);

test(
  'switching sign-in methods no longer loses contained-rendering entitlements for the same eligible account',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    const email = `switch-methods-${crypto.randomUUID()}@example.com`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${accountId}`;

    // Sign in with Google first -- grants liveRendering+standardRendering.
    await signInWithGoogle(email, 'switch-methods-google-state');
    const afterGoogle = await getAccountContext(accountId);
    assert.equal(afterGoogle.entitlements.liveRendering, true);
    assert.equal(afterGoogle.entitlements.standardRendering, true);

    // Now sign in via magic link instead -- before this fix, this would have
    // wiped both (magic-link granted only magicLinkAccess, unconditionally).
    await verifyMagicLink(email);
    const afterMagicLink = await getAccountContext(accountId);
    assert.equal(afterMagicLink.entitlements.liveRendering, true, 'switching to magic-link must not lose liveRendering for an account that is still ID-allowlisted');
    assert.equal(afterMagicLink.entitlements.standardRendering, true, 'switching to magic-link must not lose standardRendering');
    assert.equal(afterMagicLink.entitlements.magicLinkAccess, true);
    assert.equal(afterMagicLink.entitlements.googleAccess, undefined, 'the earlier googleAccess grant is correctly gone -- only contained-rendering entitlements are meant to persist across methods, not method-specific markers');
  },
);

// The most important open question from the domain-match liveRendering leak
// fix (lib/video-os-security.js, lib/video-os-testers.js): the fix stops NEW
// over-grants, but does a sign-in AFTER the fix actually CORRECT an account
// that was already over-granted liveRendering BEFORE the fix shipped, or
// does a stale DB row silently survive? Traced db/repositories.js's
// updateAuthenticatedAccount() directly: it disables ALL existing
// AUTH_ENTITLEMENT_SOURCE grants first (unconditionally), then re-enables
// only the freshly-computed desiredKeys -- a full reconcile, not an
// additive insert-if-missing. This proves that behavior end to end against
// a real stale row, not just by reading the transaction code.
test(
  'a stale liveRendering grant from before this fix is correctly disabled on the account\'s next sign-in -- the fix corrects PAST over-grants, not just future ones',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account-not-in-this-test';
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const email = `stale-downgrade-${crypto.randomUUID()}@trusted-test-domain.example`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });

    // Simulate the pre-fix state directly: a user row plus a wrongly-granted,
    // still-enabled liveRendering entitlement -- exactly what the old buggy
    // containedRenderingEntitlementKeys() used to write for a pure domain
    // match. This deliberately bypasses the (now-fixed) real grant path --
    // the point is to prove a sign-in AFTER the fix corrects a row that was
    // already wrong BEFORE the fix, not to re-derive it fresh from scratch.
    await ensureAccount({ accountId, email, name: 'Video OS Account' });
    await database().insert(entitlements).values({ accountId, entitlementKey: 'liveRendering', enabled: true, sourceType: 'validated_auth', sourceId: 'pre-fix-stale-grant-simulation' });
    const beforeSignIn = await getAccountContext(accountId);
    assert.equal(beforeSignIn.entitlements.liveRendering, undefined, 'stale auth-derived Premium overgrants are denied even before another sign-in');

    await verifyMagicLink(email);
    const afterSignIn = await getAccountContext(accountId);
    assert.equal(afterSignIn.entitlements.liveRendering, undefined, 'a fresh sign-in after the fix must disable a stale pre-fix liveRendering over-grant for a domain-only match, not just avoid granting new ones');
    assert.equal(afterSignIn.entitlements.standardRendering, true, 'the correct standardRendering grant must still be present after reconciliation');
  },
);

// Real bug found and fixed during a follow-up beta-test pass (2026-09-28):
// a pure domain-matched sign-in (magic-link OR Google) sets role: 'tester'
// purely for the extra-starting-credits/admin-visibility distinction --
// deliberately broad, accepted, and unrelated to entitlement granting. But
// updateAuthenticatedAccount() used to call registerTesterAccountId()
// whenever role === 'tester', which feeds isTesterAccountId() -- treated by
// containedRenderingEntitlementKeys() as equivalent to an exact,
// individually-designated tester: full liveRendering, not just Standard.
// That meant literally ANY domain-matched account's first sign-in silently
// registered itself into the global tester-bypass set, and its very next
// sign-in (or an in-flight render-authorization check on the same warm
// instance) would then get full Premium access -- reopening the exact leak
// containedRenderingEntitlementKeys() was fixed to close, through a fourth
// path, and the only one of the four that fires on ordinary customer
// sign-in rather than an explicit admin action.
test(
  'a pure domain-matched magic-link sign-in never registers the account into the global tester bypass set -- and a SECOND sign-in still grants Standard only, not liveRendering',
  { skip: !blobAvailable && 'DATABASE_URL / BLOB_READ_WRITE_TOKEN not configured; skipping live integration test' },
  async (t) => {
    setupCommonEnv();
    process.env.VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS = 'trusted-test-domain.example';
    const email = `plain-employee-${crypto.randomUUID()}@trusted-test-domain.example`;
    const accountId = accountIdForEmail(email);
    t.after(async () => { await database().delete(users).where(eq(users.id, accountId)).catch(() => {}); });

    assert.equal(isTesterAccountId(accountId), false, 'sanity check: a freshly generated account must not already be tester-registered');

    await verifyMagicLink(email);
    assert.equal(isTesterAccountId(accountId), false, 'a pure domain match must NEVER register into the global tester bypass set, even though role is set to \'tester\' for credit-amount purposes -- that is a deliberately separate signal');
    const afterFirstSignIn = await getAccountContext(accountId);
    assert.equal(afterFirstSignIn.user.role, 'customer');
    await listAdminTesters();
    assert.equal(afterFirstSignIn.entitlements.liveRendering, undefined, 'the first sign-in itself must not grant liveRendering for a pure domain match');
    assert.equal(afterFirstSignIn.entitlements.standardRendering, true, 'the first sign-in must still grant standardRendering');

    // The real regression: before this fix, the FIRST sign-in's registration
    // side-effect would poison isTesterAccountId() for every sign-in after
    // it. Prove the second sign-in is equally correct, not just the first.
    await verifyMagicLink(email);
    assert.equal(isTesterAccountId(accountId), false, 'a second sign-in by the same domain-matched account must still not be tester-registered');
    const afterSecondSignIn = await getAccountContext(accountId);
    assert.equal(afterSecondSignIn.entitlements.liveRendering, undefined, 'a second sign-in by the same pure domain match must still never grant liveRendering -- this is the exact case that was broken before this fix');
    assert.equal(afterSecondSignIn.entitlements.standardRendering, true, 'standardRendering must still be correctly granted on the second sign-in');
  },
);
