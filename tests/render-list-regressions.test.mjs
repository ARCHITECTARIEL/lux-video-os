// Regression tests for PR #130 QA findings M-1 and L-2.
// M-1: (a) the tester rule must run before the VIDEO_OS_RENDER_ACCOUNT_ID
// allowlist so a tester who is also listed keeps the `tester` key;
// (b) the persisted Premium gate must drop blank list entries so a blank
// entry can never match a blank account id (fail-closed).
// L-2: listing an email is not listing an id; lookalike/subdomain emails get
// nothing; plus-aliases of a listed account stay Standard.
// All ids and emails are made up. The tester identity is mocked in a child.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  accountAllowedForContainedRendering,
  containedRenderingEntitlementKeys as keysFor,
} from '../lib/video-os-security.js';
import { configuredPremiumIdentity as premiumId } from '../lib/video-os-render-authorization.js';
import { accountIdForEmail } from '../lib/video-os-account.js';

const PREMIUM = ['liveRendering', 'standardRendering'];
const STANDARD = ['standardRendering'];
const STAFF_EMAIL = 'regression-staff@luxmarketingcompany.com';
const STAFF_ID = accountIdForEmail(STAFF_EMAIL);

function withList(value, fn) {
  const keys = ['VIDEO_OS_RENDER_ACCOUNT_ID', 'VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS', 'VIDEO_OS_TESTER_EMAIL_DOMAINS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  if (value !== undefined) process.env.VIDEO_OS_RENDER_ACCOUNT_ID = value;
  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('M-1a: a tester who is also listed keeps exactly the tester key set', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/render-list-tester-overlap.mjs'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '', VIDEO_OS_RENDER_ACCOUNT_ID: '', VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS: '', VIDEO_OS_TESTER_EMAIL_DOMAINS: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /render-list tester-overlap ok/);
});

test('M-1b: blank list entries never match a blank or missing account id at the gate', () => {
  for (const list of [undefined, '', ',', ' , ', ',,', '\r\n']) {
    withList(list, () => {
      const label = JSON.stringify(list ?? null);
      for (const id of ['', ' ', undefined, null]) {
        assert.equal(premiumId(id, STAFF_EMAIL), false, `gate ${label} id ${JSON.stringify(id ?? null)}`);
        assert.equal(premiumId(id, ''), false, `gate no email ${label}`);
        assert.deepEqual(keysFor(id, STAFF_EMAIL), STANDARD, `sign-in ${label}`);
        assert.equal(accountAllowedForContainedRendering(id), false, `allow ${label}`);
      }
    });
  }
  // Blank entries around a real entry are tolerated, and still do not match blanks.
  for (const list of [`${STAFF_ID},`, `,${STAFF_ID}`, ` , ${STAFF_ID} , `]) {
    withList(list, () => {
      assert.equal(premiumId(STAFF_ID, STAFF_EMAIL), true, 'listed id still matches');
      assert.equal(premiumId('', STAFF_EMAIL), false, 'blank id never matches');
      assert.equal(premiumId(' ', STAFF_EMAIL), false, 'space id never matches');
    });
  }
});

test('L-2: listing an email (or a domain) never grants Premium to the account', () => {
  for (const list of [STAFF_EMAIL, STAFF_EMAIL.toUpperCase(), `acct-x,${STAFF_EMAIL}`, 'luxmarketingcompany.com', '@luxmarketingcompany.com']) {
    withList(list, () => {
      assert.deepEqual(keysFor(STAFF_ID, STAFF_EMAIL), STANDARD, 'email listed: staff stays Standard');
      assert.equal(premiumId(STAFF_ID, STAFF_EMAIL), false, 'gate agrees');
    });
  }
});

test('L-2: lookalike and subdomain emails get nothing; staff variants get Standard only', () => {
  withList('acct-someone-else', () => {
    for (const email of ['Regression-Staff@LuxMarketingCompany.COM', ' regression-staff@luxmarketingcompany.com ', 'regression-staff+render@luxmarketingcompany.com']) {
      assert.deepEqual(keysFor(accountIdForEmail(email), email), STANDARD, 'staff variant is Standard only');
    }
    for (const email of ['qa@sub.luxmarketingcompany.com', 'qa@luxmarketingcompany.com.evil.example', 'qa@luxmarketingcompany.co',
      'qa@xluxmarketingcompany.com', 'qa@luxmarketingcompany.com.', 'luxmarketingcompany.com', 'qa@luxmarketingcompany\u0441om']) {
      assert.deepEqual(keysFor(accountIdForEmail(email), email), [], 'lookalike/subdomain gets nothing');
    }
  });
});

test('L-2: a plus-alias of a listed staff account stays Standard', () => {
  withList(STAFF_ID, () => {
    for (const alias of ['regression-staff+x@luxmarketingcompany.com', 'regression-staff+@luxmarketingcompany.com', 'REGRESSION-STAFF+render@LUXMARKETINGCOMPANY.COM']) {
      const aliasId = accountIdForEmail(alias);
      assert.notEqual(aliasId, STAFF_ID, 'alias derives a distinct id');
      assert.deepEqual(keysFor(aliasId, alias), STANDARD, 'alias is Standard only');
      assert.equal(premiumId(aliasId, alias), false, 'gate refuses alias');
    }
    const upper = STAFF_EMAIL.toUpperCase();
    assert.deepEqual(keysFor(accountIdForEmail(upper), upper), PREMIUM, 'case variant of the listed email derives the same id');
  });
});
