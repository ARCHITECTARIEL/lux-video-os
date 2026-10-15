import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { creditAccounts, entitlements, users } from '../db/schema.js';
import { DEFAULT_TRIAL_CREDITS } from '../lib/video-os-account.js';

let activeDatabase;

function accountDatabaseHarness() {
  const state = { user: null, credits: null, grants: [] };
  const dialect = new PgDialect();

  function selectedRows(table, fields) {
    if (table === users) {
      if (!state.user) return [];
      if (fields?.user === users && fields?.credits === creditAccounts) {
        return state.credits ? [{ user: { ...state.user }, credits: { ...state.credits } }] : [];
      }
      return [{ ...state.user }];
    }
    if (table === entitlements) return state.grants.map((grant) => ({ ...grant }));
    if (table === creditAccounts) return state.credits ? [{ ...state.credits }] : [];
    return [];
  }

  const db = {
    async transaction(callback) { return callback(db); },
    async execute() { return []; },
    insert(table) {
      return {
        values(values) {
          return {
            async onConflictDoNothing() {
              if (table === users && !state.user) state.user = { role: 'customer', ...values };
              if (table === creditAccounts && !state.credits) state.credits = { reserved: 0, purchased: 0, spent: 0, ...values };
              if (table === entitlements && !state.grants.some((grant) => grant.accountId === values.accountId && grant.entitlementKey === values.entitlementKey)) state.grants.push({ ...values });
            },
            async onConflictDoUpdate(config) {
              if (table === users) {
                state.user = state.user ? { ...state.user, ...config.set } : { ...values };
                return;
              }
              if (table === creditAccounts) {
                if (!state.credits) {
                  state.credits = { reserved: 0, purchased: 0, spent: 0, ...values };
                  return;
                }
                const rendered = dialect.sqlToQuery(config.set.balance);
                assert.match(rendered.sql, /greatest/i, 'tester credit updates must use a non-decreasing balance floor');
                state.credits = {
                  ...state.credits,
                  balance: Math.max(state.credits.balance, values.balance),
                  updatedAt: config.set.updatedAt,
                };
                return;
              }
              if (table === entitlements) {
                const index = state.grants.findIndex((grant) => grant.accountId === values.accountId && grant.entitlementKey === values.entitlementKey);
                if (index === -1) state.grants.push({ ...values });
                else state.grants[index] = { ...state.grants[index], ...config.set };
              }
            },
          };
        },
      };
    },
    select(fields) {
      let table;
      const query = {
        from(value) { table = value; return query; },
        innerJoin() { return query; },
        where() { return query; },
        for() { return query; },
        limit() { return query; },
        then(resolve, reject) { return Promise.resolve(selectedRows(table, fields)).then(resolve, reject); },
      };
      return query;
    },
    update(table) {
      return {
        set(values) {
          return {
            async where() {
              if (table === users && state.user) state.user = { ...state.user, ...values };
              if (table === entitlements) state.grants = state.grants.map((grant) => ({ ...grant, ...values }));
              return [];
            },
          };
        },
      };
    },
  };

  return { db, state };
}

const REVIEWED_SAFE_CLAIMS = [
  'Rendering requires credits; no complimentary render or automatic trial credits are included.',
  'Completed, accepted videos are available in your account for download.',
  'Creating a video sends the inputs needed for that workflow to configured service providers under their applicable terms.',
  'A reusable enrolled presenter and voice may be used for later scripts you authorize until you revoke them; legacy narration workflows may use render-specific inputs.',
];

const UNSUPPORTED_PUBLIC_CLAIMS = [
  ['static dollar price', /\$\s*\d+(?:[.,]\d{1,2})?/i],
  ['ownership absolute', /\b(?:owned by you|you own|belongs to you|yours to own)\b/i],
  ['sharing absolute', /\b(?:never shared|nothing is shared|not shared with anyone)\b/i],
  ['training absolute', /\b(?:(?:never|not|is not|isn't)\s+(?:used\s+)?(?:for\s+)?(?:training|to train)|used to train other models)\b/i],
];

async function runAccountPolicyScenario() {
  const realClient = await import('../db/client.js');
  mock.module('../db/client.js', { namedExports: {
    ...realClient,
    database: () => {
      assert.ok(activeDatabase, 'an in-memory account database must be active');
      return activeDatabase;
    },
  } });
  const { ensureAccount, setAccountRole, updateAuthenticatedAccount } = await import('../db/repositories.js');

  let harness = accountDatabaseHarness();
  activeDatabase = harness.db;
  const regular = await ensureAccount({ accountId: 'regular-account', email: 'regular@example.test', name: 'Regular account' });
  assert.equal(regular.credits.balance, 0, 'ordinary account creation must use the repository zero-credit default');

  harness = accountDatabaseHarness();
  activeDatabase = harness.db;
  const tester = await updateAuthenticatedAccount({
    accountId: 'tester-account', email: 'tester@example.test', name: 'Tester account', role: 'tester',
    initialCredits: 5000, registerAsTester: true,
  });
  assert.equal(tester.credits.balance, 5000, 'the explicit tester path may establish its configured credit floor');

  harness = accountDatabaseHarness();
  activeDatabase = harness.db;
  await ensureAccount({ accountId: 'existing-account', email: 'existing@example.test', name: 'Existing account', initialCredits: 7300 });
  const afterRegularSignIn = await updateAuthenticatedAccount({
    accountId: 'existing-account', email: 'existing@example.test', name: 'Existing account', initialCredits: DEFAULT_TRIAL_CREDITS,
  });
  assert.equal(afterRegularSignIn.credits.balance, 7300, 'ordinary sign-in must preserve an existing nonzero balance');
  const afterTesterSignIn = await updateAuthenticatedAccount({
    accountId: 'existing-account', email: 'existing@example.test', name: 'Existing account', role: 'tester',
    initialCredits: 5000, registerAsTester: true,
  });
  assert.equal(afterTesterSignIn.credits.balance, 7300, 'a tester credit floor must never reduce a larger existing balance');

  for (const preservedRole of ['ceo', 'workspace']) {
    harness = accountDatabaseHarness();
    activeDatabase = harness.db;
    await ensureAccount({ accountId: 'ariel-account', email: 'ariel@luxmarketingcompany.com', name: 'Ariel' });
    await setAccountRole('ariel-account', preservedRole, { actor: 'system_bootstrap' });
    harness.state.grants.push({ accountId: 'ariel-account', entitlementKey: 'tester', enabled: true, sourceType: 'admin_tester_grant' });
    for (const signInRole of ['customer', 'tester']) {
      const account = await updateAuthenticatedAccount({
        accountId: 'ariel-account', email: 'ariel@luxmarketingcompany.com', name: 'Ariel', role: signInRole,
      });
      assert.equal(account.user.role, preservedRole, `${signInRole} sign-in must preserve ${preservedRole}`);
    }
  }

  harness = accountDatabaseHarness();
  activeDatabase = harness.db;
  const bootstrapped = await updateAuthenticatedAccount({
    accountId: 'bootstrap-ceo', email: 'ariel@luxmarketingcompany.com', name: 'Ariel',
    role: 'ceo', actor: 'system_bootstrap', entitlementKeys: ['ceoPreview'],
  });
  assert.equal(bootstrapped.user.role, 'ceo', 'credential-gated bootstrap promotes in the sign-in transaction');
}

if (process.argv[2] === '--account-policy-scenario') {
  await runAccountPolicyScenario();
} else {
  test('regular signups receive no automatic render credits and Welcome makes no free-video promise', async () => {
    const landing = await readFile(new URL('../public/landing.html', import.meta.url), 'utf8');
    assert.equal(DEFAULT_TRIAL_CREDITS, 0);
    assert.doesNotMatch(landing, /free video|first video is free|free trial credits|enough credits to create one video|included for free/i);
    for (const claim of REVIEWED_SAFE_CLAIMS) assert.match(landing, new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const unreviewedCopy = REVIEWED_SAFE_CLAIMS.reduce((copy, claim) => copy.replaceAll(claim, ''), landing);
    for (const [label, pattern] of UNSUPPORTED_PUBLIC_CLAIMS) assert.doesNotMatch(unreviewedCopy, pattern, label);
    assert.match(landing, /Regular new accounts start with zero render credits\./);
    assert.match(landing, /<a[^>]+href="\/\?signin=1"[^>]*>Sign in to start<\/a>/);
  });

  test('account creation grants zero credits, tester grants are explicit, and neither sign-in path reduces an existing balance', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      fileURLToPath(import.meta.url),
      '--account-policy-scenario',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '' },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
