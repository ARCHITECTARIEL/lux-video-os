// Dedicated coverage for the render submission route's rate limiting.
// render-v2.js deliberately exports assertRenderRateLimit() and
// renderHourlyLimit() as standalone, dependency-injectable functions (see
// its own comment above them) specifically so the 429 path is unit-testable
// without needing 20+ real requests against a live DB, or standing up a
// fully authorized session + entitlement just to reach the rate-limit
// check inside the handler. This file tests that surface directly, plus a
// live consumeRateLimit integration test (the same real-DB, skip-if-
// unconfigured convention used in tests/copywriter.test.mjs) proving the
// exported function is actually wired to the real, atomic rate limiter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertRenderRateLimit, renderHourlyLimit } from '../api/video-os-lite/render-v2.js';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { ensureAccount } from '../db/repositories.js';
import { rateLimits, users } from '../db/schema.js';

test('assertRenderRateLimit resolves without throwing when the limit allows the request', async () => {
  let seenArgs;
  await assertRenderRateLimit('account-allowed', {
    rateLimit: async (args) => { seenArgs = args; return true; },
    limit: 20,
  });
  assert.deepEqual(seenArgs, {
    accountId: 'account-allowed',
    key: 'render:hourly:account-allowed',
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
});

test('assertRenderRateLimit throws a 429 rate_limited error when the limit is exhausted', async () => {
  await assert.rejects(
    () => assertRenderRateLimit('account-blocked', { rateLimit: async () => false, limit: 20 }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'rate_limited');
      assert.match(error.message, /limit reached/i);
      return true;
    },
  );
});

test('assertRenderRateLimit defaults its limit to renderHourlyLimit() when not overridden', async () => {
  const original = process.env.VIDEO_OS_RENDER_HOURLY_LIMIT;
  try {
    process.env.VIDEO_OS_RENDER_HOURLY_LIMIT = '7';
    let seenLimit;
    await assertRenderRateLimit('account-default-limit', { rateLimit: async (args) => { seenLimit = args.limit; return true; } });
    assert.equal(seenLimit, 7);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_RENDER_HOURLY_LIMIT;
    else process.env.VIDEO_OS_RENDER_HOURLY_LIMIT = original;
  }
});

test('renderHourlyLimit defaults to 20 and honors VIDEO_OS_RENDER_HOURLY_LIMIT', () => {
  const original = process.env.VIDEO_OS_RENDER_HOURLY_LIMIT;
  try {
    delete process.env.VIDEO_OS_RENDER_HOURLY_LIMIT;
    assert.equal(renderHourlyLimit(), 20);
    process.env.VIDEO_OS_RENDER_HOURLY_LIMIT = '55';
    assert.equal(renderHourlyLimit(), 55);
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_RENDER_HOURLY_LIMIT;
    else process.env.VIDEO_OS_RENDER_HOURLY_LIMIT = original;
  }
});

test('the handler checks the render rate limit after authorization but before reading the request body', () => {
  const source = readFileSync(new URL('../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
  const start = source.indexOf('export default async function handler(req, res) {');
  const end = source.indexOf('async function handlePremiumRender');
  assert.ok(start >= 0 && end > start, 'handler block must remain recognizable');
  const handlerBlock = source.slice(start, end);
  const authIndex = handlerBlock.indexOf('requireRenderAccountAuthorization(session.accountId)');
  const rateLimitIndex = handlerBlock.indexOf('await assertRenderRateLimit(session.accountId)');
  const readBodyIndex = handlerBlock.indexOf('const body = await readJson(req)');
  assert.ok(authIndex >= 0 && rateLimitIndex > authIndex, 'rate limit must be checked only after account authorization succeeds');
  assert.ok(readBodyIndex > rateLimitIndex, 'rate limit must be checked before the request body is read');
});

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

test(
  'assertRenderRateLimit is wired to the real, atomic consumeRateLimit -- a flood of render requests actually gets cut off',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const accountId = `test-render-rate-${crypto.randomUUID()}`;
    const key = `render:hourly:${accountId}`;
    t.after(async () => {
      await database().delete(rateLimits).where(eq(rateLimits.key, key)).catch(() => {});
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });
    await ensureAccount({ accountId, email: `${accountId}@example.com`, name: 'Render Rate Test' });

    // limit passed explicitly (not via VIDEO_OS_RENDER_HOURLY_LIMIT) so this
    // test stays fast and independent of the real default.
    await assertRenderRateLimit(accountId, { limit: 2 });
    await assertRenderRateLimit(accountId, { limit: 2 });
    await assert.rejects(
      () => assertRenderRateLimit(accountId, { limit: 2 }),
      (error) => error.statusCode === 429 && error.code === 'rate_limited',
    );
  },
);
