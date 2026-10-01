// Local diagnosis only: real repository list function and entitlement helpers,
// with a synthetic database result. No network, credentials, or provider calls.
// Run: node --experimental-test-module-mocks docs/execution-notes/02-authorization-reproduction.mjs
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  containedRenderingEntitlementKeys,
  requireRenderAccountAuthorization,
} from '../../lib/video-os-security.js';
import { REGISTERED_TESTER_ACCOUNTS, revokeTesterAccountId } from '../../lib/video-os-testers.js';

const accountId = 'diagnostic-domain-member';
const email = 'synthetic-member@luxmarketingcompany.com';
const auth = await readFile(new URL('../../api/video-os-lite/auth.js', import.meta.url), 'utf8');
// Verify the synthetic row reflects BOTH current authenticated sign-in paths.
assert.equal((auth.match(/const role = isTester \? 'tester' : 'customer';/g) || []).length, 2);
assert.match(auth, /isTesterEmailDomain\(email\) \|\| isTesterAccountId\(accountId\)/);
assert.match(auth, /isTesterEmailDomain\(profile.email\) \|\| isTesterAccountId\(accountId\)/);
const rows = [{ accountId, email, role: 'tester' }];
const query = {
  from() { return this; },
  leftJoin() { return this; },
  where() { return this; },
  orderBy() { return Promise.resolve(rows); },
};
mock.module('../../db/client.js', { namedExports: { database: () => ({ select: () => query }) } });
const { listAdminTesters } = await import('../../db/repositories.js');
const renderSource = await readFile(new URL('../../api/video-os-lite/render-v2.js', import.meta.url), 'utf8');
const handlerSource = renderSource.slice(renderSource.indexOf('export default async function handler'));
assert.ok(handlerSource.indexOf('requireRenderAccountAuthorization(session.accountId, session.email)')
  < handlerSource.indexOf('narrationRequest = isNarrationRequest(body)'));
const workflowSource = await readFile(new URL('../../workflows/video-render.js', import.meta.url), 'utf8');
assert.match(workflowSource, /requireRenderAccountAuthorization\(job.accountId\)/);

try {
  revokeTesterAccountId(accountId);
  const before = containedRenderingEntitlementKeys(accountId, email);
  assert.equal(before.includes('liveRendering'), false);
  assert.equal(before.includes('standardRendering'), true);
  await listAdminTesters();
  assert.equal(REGISTERED_TESTER_ACCOUNTS.has(accountId), true);
  const after = containedRenderingEntitlementKeys(accountId, email);
  assert.equal(after.includes('liveRendering'), true);
  assert.equal(requireRenderAccountAuthorization(accountId), true);
  console.log(JSON.stringify({ diagnosis: 'CONFIRMED', evidence: 'real list function with synthetic database rows', before, after, premiumGateAfterList: 'allowed' }));
  revokeTesterAccountId(accountId);
  assert.throws(() => requireRenderAccountAuthorization(accountId, email));
  console.log(JSON.stringify({ diagnosis: 'CONFIRMED', standardEntitlement: before.includes('standardRendering'), sharedGate: 'denied', tierSelection: 'after shared gate' }));
  const coldAccountId = 'diagnostic-exact-tester-cold-worker';
  revokeTesterAccountId(coldAccountId);
  assert.equal(requireRenderAccountAuthorization(coldAccountId, 'arielsmailbox@gmail.com'), true);
  assert.throws(() => requireRenderAccountAuthorization(coldAccountId));
  console.log(JSON.stringify({ diagnosis: 'CONFIRMED', exactTesterRouteGate: 'allowed', coldWorkerAccountOnlyGate: 'denied' }));
} finally {
  revokeTesterAccountId(accountId);
  mock.restoreAll();
}
