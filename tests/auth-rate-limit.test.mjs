// Dedicated coverage for the magic-link request route's rate limiting
// (action=auth-request in api/video-os-lite/auth.js). Unlike uploads.js and
// render-v2.js, this route isn't behind a dependency-injection factory, so
// it's tested the same way tests/google-signin-route.test.mjs tests this
// same file's other actions: real authHandler, real DB (skipped when
// DATABASE_URL isn't configured), with the external provider (Resend, via
// sendMagicEmail's fetch call) stubbed rather than actually sent.
//
// The property under test is the one the rate limit exists for (see the
// comment above magicLinkHourlyLimit() in auth.js): a flood of sign-in link
// requests against any email address must stop sending real emails once the
// limit is hit, not just report a friendly 429.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import authHandler from '../api/video-os-lite/auth.js';
import { accountIdForEmail, normalizeEmail } from '../lib/video-os-account.js';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { consumeRateLimit, ensureAccount } from '../db/repositories.js';
import { rateLimits, users } from '../db/schema.js';

const originalFetch = globalThis.fetch;
const originalEnvironment = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  AUTH_FROM_EMAIL: process.env.AUTH_FROM_EMAIL,
  VIDEO_OS_MAGIC_LINK_HOURLY_LIMIT: process.env.VIDEO_OS_MAGIC_LINK_HOURLY_LIMIT,
};

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test.afterEach(restoreEnvironment);

function request(body) {
  return {
    method: 'POST',
    url: '/api/video-os-lite/auth-request',
    headers: { host: 'video-os-auth-rate-limit-test.invalid' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ? JSON.parse(body) : null; },
  };
}

test('the auth-request handler checks the magic-link rate limit before saving a token or sending an email', () => {
  const source = readFileSync(new URL('../api/video-os-lite/auth.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (action === 'auth-request') {");
  const end = source.indexOf("if (action === 'auth-verify') {");
  assert.ok(start >= 0 && end > start, 'auth-request handler block must remain recognizable');
  const routeBlock = source.slice(start, end);
  const rateLimitIndex = routeBlock.indexOf('consumeRateLimit(');
  const saveTokenIndex = routeBlock.indexOf('saveMagicToken(');
  const sendEmailIndex = routeBlock.indexOf('sendMagicEmail(');
  assert.ok(rateLimitIndex >= 0 && saveTokenIndex > rateLimitIndex, 'rate limit must be consumed before a magic token is saved');
  assert.ok(sendEmailIndex > saveTokenIndex, 'the email is only sent after the token is saved, which is already gated on the rate limit');
  assert.match(routeBlock, /if \(!allowed\) return send\(res, 429, \{ ok: false, code: 'rate_limited'/);
});

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test(
  'a flood of sign-in link requests is cut off with 429 and never reaches the email provider',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.RESEND_API_KEY = 'test-key-never-sent';
    process.env.AUTH_FROM_EMAIL = 'test-from@example.invalid';
    process.env.VIDEO_OS_MAGIC_LINK_HOURLY_LIMIT = '1';

    const email = `auth-rate-limit-test-${crypto.randomUUID()}@example.com`;
    const normalizedEmail = normalizeEmail(email);
    const accountId = accountIdForEmail(normalizedEmail);
    const key = `magic-link:hourly:${normalizedEmail}`;
    t.after(async () => {
      await database().delete(rateLimits).where(eq(rateLimits.key, key)).catch(() => {});
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    // The handler itself calls ensureAccount() before consuming the rate
    // limit (rate_limits.account_id is a real foreign key into users, and
    // no account may exist yet on a first-ever sign-in attempt) -- doing it
    // here first lets this test pre-exhaust the limit directly against the
    // real limiter before the handler ever runs, so the very first handler
    // call below is already blocked and sendMagicEmail is provably never
    // reached, without needing a working Blob store to exercise the
    // allowed path too.
    await ensureAccount({ accountId, email: normalizedEmail, name: normalizedEmail });
    assert.equal(await consumeRateLimit({ accountId, key, limit: 1, windowMs: 60 * 60 * 1000 }), true);

    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; throw new Error('sendMagicEmail must not be called once the limit is exhausted'); };

    const res = response();
    await authHandler(request({ email: normalizedEmail }), res);

    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'rate_limited');
    assert.equal(fetchCalled, false, 'the Resend API must never be called once the magic-link rate limit is exhausted');
  },
);

test(
  'the limit is scoped per email address, not global',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    process.env.RESEND_API_KEY = 'test-key-never-sent';
    process.env.AUTH_FROM_EMAIL = 'test-from@example.invalid';
    process.env.VIDEO_OS_MAGIC_LINK_HOURLY_LIMIT = '1';

    const exhaustedEmail = `auth-rate-limit-exhausted-${crypto.randomUUID()}@example.com`;
    const freshEmail = `auth-rate-limit-fresh-${crypto.randomUUID()}@example.com`;
    const exhaustedAccountId = accountIdForEmail(normalizeEmail(exhaustedEmail));
    const freshAccountId = accountIdForEmail(normalizeEmail(freshEmail));
    const exhaustedKey = `magic-link:hourly:${normalizeEmail(exhaustedEmail)}`;
    const freshKey = `magic-link:hourly:${normalizeEmail(freshEmail)}`;
    t.after(async () => {
      await database().delete(rateLimits).where(eq(rateLimits.key, exhaustedKey)).catch(() => {});
      await database().delete(rateLimits).where(eq(rateLimits.key, freshKey)).catch(() => {});
      await database().delete(users).where(eq(users.id, exhaustedAccountId)).catch(() => {});
      await database().delete(users).where(eq(users.id, freshAccountId)).catch(() => {});
    });

    await ensureAccount({ accountId: exhaustedAccountId, email: normalizeEmail(exhaustedEmail), name: 'exhausted' });
    assert.equal(await consumeRateLimit({ accountId: exhaustedAccountId, key: exhaustedKey, limit: 1, windowMs: 60 * 60 * 1000 }), true);

    // The handler's next step after the rate-limit check (saveMagicToken)
    // writes to Blob storage, which this test environment doesn't have
    // configured -- so the fresh email's request is expected to fail past
    // the rate-limit gate, not at it. The property under test here is
    // scoping, proved directly against the real rate_limits row rather than
    // by asserting a particular downstream HTTP status.
    globalThis.fetch = async () => { throw new Error('must not be called before saveMagicToken in this scenario'); };

    const exhaustedRes = response();
    await authHandler(request({ email: exhaustedEmail }), exhaustedRes);
    assert.equal(exhaustedRes.statusCode, 429);
    assert.equal(exhaustedRes.body.code, 'rate_limited');

    const freshRes = response();
    await authHandler(request({ email: freshEmail }), freshRes);
    assert.notEqual(freshRes.statusCode, 429, 'a different, unexhausted email address must not be blocked by another address\'s exhausted limit');
    assert.notEqual(freshRes.body?.code, 'rate_limited');

    const [freshRow] = await database().select().from(rateLimits).where(eq(rateLimits.key, freshKey));
    assert.ok(freshRow, 'the fresh email must have its own independent rate_limits row');
    assert.equal(freshRow.count, 1, 'the fresh email\'s own counter must start from zero, unaffected by the exhausted email');
  },
);
