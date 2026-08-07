import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reconcileAuthenticatedEntitlements } from '../db/repositories.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Postgres is the sole runtime account, entitlement, and credit authority', async () => {
  const [auth, providers, repositories, account, credits] = await Promise.all([
    read('api/video-os-lite/auth.js'),
    read('routes/video-os-lite/providers.js'),
    read('db/repositories.js'),
    read('lib/video-os-account.js'),
    read('lib/video-os-credits.js'),
  ]);
  assert.match(auth, /getAccountContext/);
  assert.match(auth, /updateAuthenticatedAccount/);
  assert.doesNotMatch(auth, /\bloadAccount\b|\bsaveAccount\b|\baccountPayload\b/);
  assert.match(providers, /getAccountContext/);
  assert.doesNotMatch(providers, /\bloadAccount\b|\baccountPayload\b/);
  assert.match(repositories, /onConflictDoNothing\(\)/);
  assert.match(repositories, /updateAuthenticatedAccount/);
  assert.match(repositories, /getAccountContext/);
  assert.doesNotMatch(account, /video-os\/(accounts|rate|jobs|credit-state|stripe-events)\//);
  assert.doesNotMatch(account, /video-os-credits|\bloadAccount\b|\bsaveAccount\b|\bloadJobs\b|\bupsertJob\b/);
  assert.doesNotMatch(credits, /@vercel\/blob|putPrivateBlob|CREDIT_PREFIX|EVENT_PREFIX/);
});

test('ordinary account ensure never overwrites authenticated profile or reseeds credits', async () => {
  const repositories = await read('db/repositories.js');
  const ordinary = repositories.slice(repositories.indexOf('export async function ensureAccount'), repositories.indexOf('export async function updateAuthenticatedAccount'));
  assert.match(ordinary, /onConflictDoNothing\(\)/);
  assert.doesNotMatch(ordinary, /onConflictDoUpdate|role|entitlements/);
  const authenticated = repositories.slice(repositories.indexOf('export async function updateAuthenticatedAccount'), repositories.indexOf('export async function getAccount'));
  assert.match(authenticated, /onConflictDoUpdate/);
  assert.match(authenticated, /creditAccounts[\s\S]*?onConflictDoNothing\(\)/);
});
test('validated authentication replaces stale auth grants without weakening independent grants', () => {
  const grants = [
    { entitlementKey: 'ownerAccess', sourceType: 'validated_auth', enabled: true },
    { entitlementKey: 'fullAccess', sourceType: 'validated_auth', enabled: true },
    { entitlementKey: 'liveRendering', sourceType: 'validated_auth', enabled: true },
    { entitlementKey: 'billingSeat', sourceType: 'stripe', enabled: true },
  ];
  const result = reconcileAuthenticatedEntitlements(grants, ['magicLinkAccess']);
  assert.deepEqual(result.desiredKeys, ['magicLinkAccess']);
  assert.deepEqual(result.disableKeys.sort(), ['fullAccess', 'liveRendering', 'ownerAccess']);
  assert.deepEqual(result.preservedKeys, ['billingSeat']);
  assert.throws(
    () => reconcileAuthenticatedEntitlements([{ entitlementKey: 'magicLinkAccess', sourceType: 'stripe', enabled: true }], ['magicLinkAccess']),
    { statusCode: 409, failureCategory: 'RECONCILIATION' },
  );
});

test('magic-link verification provisions before one-time compare-and-set consumption', async () => {
  const [auth, account] = await Promise.all([
    read('api/video-os-lite/auth.js'),
    read('lib/video-os-account.js'),
  ]);
  const validateAt = auth.indexOf('await validateMagicToken(token)');
  const provisionAt = auth.indexOf('await updateAuthenticatedAccount', validateAt);
  const consumeAt = auth.indexOf('await consumeMagicToken(token)', provisionAt);
  assert.ok(validateAt >= 0 && validateAt < provisionAt && provisionAt < consumeAt);
  assert.match(account, /ifMatch: found\.etag/);
  assert.match(account, /BlobPreconditionFailedError/);
});
