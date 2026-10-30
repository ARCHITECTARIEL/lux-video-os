// Child-process scenarios for tests/render-list-before-domain.test.mjs.
// Module mocks replace the database, magic-link tokens and Google OAuth, so
// the real auth.js sign-in handler runs with no DB and no network.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { REGISTERED_TESTER_ACCOUNTS } from '../../lib/video-os-testers.js';

const scenario = process.argv[2];
const account = await import('../../lib/video-os-account.js');
const oauth = await import('../../lib/google-oauth.js');
const STAFF_EMAIL = 'render-list-staff@luxmarketingcompany.com';
const OTHER_STAFF_EMAIL = 'render-list-other-staff@luxmarketingcompany.com';
const STAFF_ID = account.accountIdForEmail(STAFF_EMAIL);
const OTHER_STAFF_ID = account.accountIdForEmail(OTHER_STAFF_EMAIL);
assert.notEqual(STAFF_ID, OTHER_STAFF_ID);

let currentEmail = STAFF_EMAIL;
const captured = [];
const query = { from() { return this; }, leftJoin() { return this; }, where() { return this; }, orderBy() { return []; } };
mock.module('../../db/client.js', { namedExports: { database: () => ({ select: () => query }) } });
const repo = await import('../../db/repositories.js');
mock.module('../../db/repositories.js', { namedExports: { ...repo,
  authenticatedAccountId: async id => id,
  recordSignIn: async () => {},
  updateAuthenticatedAccount: async input => {
    captured.push(input);
    return { user: { id: input.accountId, email: input.email }, credits: { balance: input.initialCredits }, entitlements: Object.fromEntries(input.entitlementKeys.map(key => [key, true])) };
  },
} });
mock.module('../../lib/video-os-account.js', { namedExports: { ...account,
  validateMagicToken: async () => ({ accountId: account.accountIdForEmail(currentEmail), email: currentEmail }),
  consumeMagicToken: async () => {},
} });
mock.module('../../lib/google-oauth.js', { namedExports: { ...oauth,
  exchangeGoogleCode: async () => ({ access_token: 'synthetic' }),
  fetchGoogleProfile: async () => ({ email: currentEmail, name: 'Synthetic' }),
} });
process.env.VIDEO_OS_SESSION_SECRET = 'synthetic-test-session-secret-32-characters';
process.env.VIDEO_OS_PUBLIC_ORIGIN = 'https://test.example';
process.env.GOOGLE_CLIENT_ID = 'synthetic-client';
process.env.GOOGLE_CLIENT_SECRET = 'synthetic-secret';
const { default: handler } = await import('../../api/video-os-lite/auth.js');
const METHODS = ['auth-verify', 'google-callback'];
const METHOD_KEY = { 'auth-verify': 'magicLinkAccess', 'google-callback': 'googleAccess' };

async function signIn(method, email) {
  currentEmail = email;
  const res = { setHeader() {}, end(raw) { this.body = raw; } };
  await handler({ method: 'GET', url: `/api/video-os-lite/${method}?token=synthetic&code=synthetic&state=test-state`, headers: { cookie: 'vos_oauth_state=test-state' } }, res);
  assert.equal(res.statusCode, 302, `${method}: ${res.body}`);
  const provision = captured.at(-1);
  assert.equal(provision.email, email);
  assert.ok(provision.entitlementKeys.includes(METHOD_KEY[method]));
  assert.equal(provision.registerAsTester, false, 'staff never join the tester bypass set');
  assert.equal(provision.role, 'customer');
  assert.equal(provision.entitlementKeys.includes('tester'), false);
  return provision;
}
const has = (provision, key) => provision.entitlementKeys.includes(key);
const asGrants = (provision, sourceId) => provision.entitlementKeys.map(entitlementKey => ({ accountId: provision.accountId, entitlementKey, enabled: true, sourceType: 'validated_auth', sourceId }));

if (scenario === 'signin') {
  for (const method of METHODS) {
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${STAFF_ID}`;
    const listed = await signIn(method, STAFF_EMAIL);
    assert.equal(listed.accountId, STAFF_ID);
    assert.equal(has(listed, 'liveRendering'), true, `${method}: listed staff gets Premium`);
    assert.equal(has(listed, 'standardRendering'), true, `${method}: listed staff keeps Standard`);
    assert.equal(listed.initialCredits, 5000, 'staff credit policy is unchanged');
    const unlisted = await signIn(method, OTHER_STAFF_EMAIL);
    assert.equal(has(unlisted, 'liveRendering'), false, `${method}: unlisted staff stays Standard`);
    assert.equal(has(unlisted, 'standardRendering'), true);
    for (const blank of ['', '   ', ' , ,', `${STAFF_ID};x`, STAFF_ID.toUpperCase(), STAFF_ID.slice(0, -2)]) {
      process.env.VIDEO_OS_RENDER_ACCOUNT_ID = blank;
      const again = await signIn(method, STAFF_EMAIL);
      assert.equal(has(again, 'liveRendering'), false, `${method}: list ${JSON.stringify(blank.length)} chars grants nothing`);
      assert.equal(has(again, 'standardRendering'), true);
    }
  }
  assert.equal(REGISTERED_TESTER_ACCOUNTS.size, 0);
} else if (scenario === 'delist') {
  // Sign in listed by one method, delist, sign in again by each method: the
  // fresh sign-in drops liveRendering and reconciliation disables the old grant.
  for (const first of METHODS) {
    for (const second of METHODS) {
      process.env.VIDEO_OS_RENDER_ACCOUNT_ID = STAFF_ID;
      const listed = await signIn(first, STAFF_EMAIL);
      assert.equal(has(listed, 'liveRendering'), true);
      const existing = asGrants(listed, first === 'auth-verify' ? 'magic_link' : 'google_oauth');
      process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account';
      const delisted = await signIn(second, STAFF_EMAIL);
      assert.equal(has(delisted, 'liveRendering'), false, `${first} -> ${second}: delisted staff loses Premium`);
      assert.equal(has(delisted, 'standardRendering'), true);
      const plan = repo.reconcileAuthenticatedEntitlements(existing, delisted.entitlementKeys);
      assert.equal(plan.disableKeys.includes('liveRendering'), true, 'the old liveRendering grant is switched off');
      assert.equal(plan.desiredKeys.includes('liveRendering'), false);
      assert.equal(plan.disableKeys.includes('standardRendering'), false);
    }
  }
} else if (scenario === 'gate') {
  // Quote/render time: requirePersistedRenderAuthorization reads persisted
  // grants and re-checks configuredPremiumIdentity for auth-derived Premium.
  const schema = await import('../../db/schema.js');
  const executorFor = (grants, user) => ({ select() {
    let table;
    const q = { from(value) { table = value; return q; }, where() { return q; }, for() { return q; }, limit() { return q; },
      then(resolve, reject) { return Promise.resolve(table === schema.entitlements ? grants : table === schema.users ? [user] : []).then(resolve, reject); } };
    return q;
  } });
  for (const method of METHODS) {
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${STAFF_ID}`;
    const listed = await signIn(method, STAFF_EMAIL);
    const grants = asGrants(listed, method === 'auth-verify' ? 'magic_link' : 'google_oauth');
    const executor = executorFor(grants, { id: STAFF_ID, email: STAFF_EMAIL });
    const premium = await repo.requirePersistedRenderAuthorization(STAFF_ID, 'premium', executor);
    assert.equal(premium.entitlementKey, 'liveRendering', `${method}: listed staff passes the Premium gate`);
    assert.equal((await repo.requirePersistedRenderAuthorization(STAFF_ID, 'standard', executor)).entitlementKey, 'standardRendering');
    // Delisted without a fresh sign-in: the stale auth-derived grant is refused.
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = 'some-other-account';
    await assert.rejects(repo.requirePersistedRenderAuthorization(STAFF_ID, 'premium', executor), { statusCode: 403 });
    assert.equal((await repo.requirePersistedRenderAuthorization(STAFF_ID, 'standard', executor)).entitlementKey, 'standardRendering');
    // Unlisted staff never get past the Premium gate, even with a forged grant row.
    const unlisted = await signIn(method, OTHER_STAFF_EMAIL);
    const forged = [...asGrants(unlisted, 'google_oauth'), { accountId: OTHER_STAFF_ID, entitlementKey: 'liveRendering', enabled: true, sourceType: 'validated_auth', sourceId: 'google_oauth' }];
    process.env.VIDEO_OS_RENDER_ACCOUNT_ID = `other-account,${STAFF_ID}`;
    await assert.rejects(repo.requirePersistedRenderAuthorization(OTHER_STAFF_ID, 'premium', executorFor(forged, { id: OTHER_STAFF_ID, email: OTHER_STAFF_EMAIL })), { statusCode: 403 });
  }
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
console.log(`render-list scenario ${scenario} ok`);
