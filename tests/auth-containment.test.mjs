import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  clearAdminCookie,
  clearSessionCookie,
  makeSession,
  verifySessionToken,
} from '../lib/video-os-account.js';

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

test('logout cookie helpers revoke both user and privileged cookies', () => {
  for (const cookie of [clearSessionCookie(), clearAdminCookie()]) {
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
  }
});
