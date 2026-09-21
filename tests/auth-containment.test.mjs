import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  clearAdminCookie,
  clearSessionCookie,
  makeSession,
  verifySessionToken,
} from '../lib/video-os-account.js';
import { issueAccountSession } from '../api/video-os-lite/auth.js';

test('rotating the session secret invalidates old sessions and accepts newly issued sessions', () => {
  const original = process.env.VIDEO_OS_SESSION_SECRET;
  try {
    process.env.VIDEO_OS_SESSION_SECRET = 'containment-old-secret-with-adequate-length';
    const oldSession = makeSession('user-containment', 'contained@example.invalid', 300);
    assert.equal(verifySessionToken(oldSession)?.accountId, 'user-containment');
    process.env.VIDEO_OS_SESSION_SECRET = 'containment-new-secret-with-adequate-length';
    assert.throws(() => verifySessionToken(oldSession), (error) => error?.statusCode === 401);
    const newSession = makeSession('user-containment', 'contained@example.invalid', 300);
    assert.equal(verifySessionToken(newSession)?.accountId, 'user-containment');
  } finally {
    if (original === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    else process.env.VIDEO_OS_SESSION_SECRET = original;
  }
});

test('magic-link persistence records a hash and never the raw token', async () => {
  const source = await readFile(new URL('../lib/video-os-account.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function saveMagicToken');
  const end = source.indexOf('export async function consumeMagicToken');
  assert.ok(start >= 0 && end > start, 'magic-token persistence block must remain recognizable');
  const persistenceBlock = source.slice(start, end);
  assert.match(persistenceBlock, /tokenHash/);
  assert.match(persistenceBlock, /writeBlobJson\(`\$\{AUTH_PREFIX\}\$\{tokenHash\}\.json`, record\)/);
  assert.doesNotMatch(persistenceBlock, /\n\s*token\s*:/);
});

test('password-login validates payload passwords but issues sessions from account records only', async () => {
  const source = await readFile(new URL('../api/video-os-lite/auth.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /loadPasswordAccount/);
  const start = source.indexOf("if (action === 'password-login') {");
  const end = source.indexOf("if (action === 'admin-login') {");
  assert.ok(start >= 0 && end > start, 'password-login handler block must remain recognizable');
  const routeBlock = source.slice(start, end);
  assert.match(routeBlock, /resolvePasswordAccess\('workspace', payload\.username, payload\.password\)/);
  assert.match(routeBlock, /loadWorkspaceAccount\(\)/);
  assert.doesNotMatch(routeBlock, /loadWorkspaceAccount\(payload\./);
  assert.match(routeBlock, /const session = issueAccountSession\(account, 60 \* 60 \* 24 \* 30\);/);
  assert.doesNotMatch(routeBlock, /makeSession\(payload\./);
  assert.doesNotMatch(routeBlock, /issueAccountSession\(payload\./);
  // The customer-facing password-login flow must never be able to mint the
  // admin cookie -- that's action=admin-login's job, reachable only from
  // /admin-console.
  assert.doesNotMatch(routeBlock, /adminCookie/);
});

test('malformed and legacy session values fail closed without echoing input', () => {
  const marker = 'legacy-sensitive-marker';
  const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
  try {
    process.env.VIDEO_OS_SESSION_SECRET = 'containment-session-secret-with-adequate-length';
    for (const value of [marker, `${marker}.bad-signature`, '', null]) {
      assert.throws(
        () => verifySessionToken(value),
        (error) => {
          assert.equal(error?.statusCode, 401);
          assert.doesNotMatch(String(error?.message || ''), new RegExp(marker));
          return true;
        },
      );
    }
  } finally {
    if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    else process.env.VIDEO_OS_SESSION_SECRET = originalSecret;
  }
});

test('issueAccountSession ignores extra non-sensitive credential markers', () => {
  const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
  try {
    process.env.VIDEO_OS_SESSION_SECRET = 'containment-session-secret-with-adequate-length';
    const session = issueAccountSession({
      accountId: 'acct-demo',
      email: 'demo@example.invalid',
      credentialMarker: 'operator-demo-hint',
    });
    const payload = verifySessionToken(session);
    assert.deepEqual(Object.keys(payload).sort(), ['accountId', 'email', 'exp']);
    assert.equal(payload.accountId, 'acct-demo');
    assert.equal(payload.email, 'demo@example.invalid');
    assert.doesNotMatch(session, /operator-demo-hint/);
  } finally {
    if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    else process.env.VIDEO_OS_SESSION_SECRET = originalSecret;
  }
});

test('logout cookie helpers revoke both user and privileged cookies', () => {
  for (const cookie of [clearSessionCookie(), clearAdminCookie()]) {
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
  }
});
