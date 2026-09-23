// Covers a real gap found live-testing Standard-tier rendering in production
// on 2026-09-23: db/standard-narration-repository.js's requireCurrentEntitlement()
// requires standardRendering/fullAccess/ownerAccess, but no sign-in path ever
// granted standardRendering -- meaning no real customer account could ever
// clear it. This test proves the workspace password login (which already
// grants liveRendering unconditionally) now grants standardRendering the
// same way. See tests/google-signin-route.test.mjs for the matching,
// allowlist-conditional coverage on the Google sign-in path.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { assertDatabaseConfigured, database } from '../db/client.js';
import { users } from '../db/schema.js';
import authHandler from '../api/video-os-lite/auth.js';
import { getAccountContext } from '../db/repositories.js';
import { accountIdForEmail } from '../lib/video-os-account.js';

let dbAvailable = true;
try {
  assertDatabaseConfigured();
} catch {
  dbAvailable = false;
}

const ORIGIN = 'https://video-os-workspace-test.invalid';
const originalEnvironment = {
  VIDEO_OS_WORKSPACE_USERNAME: process.env.VIDEO_OS_WORKSPACE_USERNAME,
  VIDEO_OS_WORKSPACE_PASSWORD: process.env.VIDEO_OS_WORKSPACE_PASSWORD,
  VIDEO_OS_WORKSPACE_EMAIL: process.env.VIDEO_OS_WORKSPACE_EMAIL,
  VIDEO_OS_PUBLIC_ORIGIN: process.env.VIDEO_OS_PUBLIC_ORIGIN,
  VIDEO_OS_SESSION_SECRET: process.env.VIDEO_OS_SESSION_SECRET,
};

function request({ body }) {
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  return {
    method: 'POST',
    url: '/api/video-os-lite/password-login',
    headers: { host: 'video-os-workspace-test.invalid', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield bodyBuffer; },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body ? JSON.parse(body) : undefined; },
  };
}

test.afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test(
  'workspace password login grants standardRendering alongside liveRendering, so Standard-tier requests are reachable',
  { skip: !dbAvailable && 'DATABASE_URL not configured; skipping live integration test' },
  async (t) => {
    const email = `workspace-entitlement-test-${crypto.randomUUID()}@example.invalid`;
    process.env.VIDEO_OS_WORKSPACE_USERNAME = 'workspace-test-user';
    process.env.VIDEO_OS_WORKSPACE_PASSWORD = 'workspace-test-password';
    process.env.VIDEO_OS_WORKSPACE_EMAIL = email;
    process.env.VIDEO_OS_PUBLIC_ORIGIN = ORIGIN;
    if (!originalEnvironment.VIDEO_OS_SESSION_SECRET) process.env.VIDEO_OS_SESSION_SECRET = 'workspace-login-entitlement-test-secret-with-adequate-length';
    const accountId = accountIdForEmail(email);
    t.after(async () => {
      await database().delete(users).where(eq(users.id, accountId)).catch(() => {});
    });

    const res = response();
    await authHandler(request({ body: { username: 'workspace-test-user', password: 'workspace-test-password' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);

    const context = await getAccountContext(accountId);
    assert.equal(context.entitlements.liveRendering, true);
    assert.equal(context.entitlements.standardRendering, true, 'workspace login must grant standardRendering, or requireCurrentEntitlement() blocks every Standard-tier request from this account');
    assert.equal(context.entitlements.passwordAccess, true);
  },
);
