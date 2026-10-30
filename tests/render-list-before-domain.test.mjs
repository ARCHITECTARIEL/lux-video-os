// VIDEO_OS_RENDER_ACCOUNT_ID is checked before the Standard-only staff
// domain rule in containedRenderingEntitlementKeys(): an individually listed
// staff account gets Premium (liveRendering), unlisted staff stay Standard,
// and the list is matched exactly. Sign-in, delisting and the persisted
// render gate run in a child process with module mocks (no DB, no network).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  accountAllowedForContainedRendering,
  containedRenderingEntitlementKeys,
  requireRenderAccountAuthorization,
} from '../lib/video-os-security.js';
import { configuredPremiumIdentity } from '../lib/video-os-render-authorization.js';

const STAFF_ID = 'acct-render-list-staff-listed';
const STAFF_EMAIL = 'render-list-staff@luxmarketingcompany.com';
const OTHER_STAFF_ID = 'acct-render-list-staff-unlisted';
const OTHER_STAFF_EMAIL = 'render-list-other-staff@luxmarketingcompany.com';
const PREMIUM = ['liveRendering', 'standardRendering'];
const STANDARD = ['standardRendering'];

function withList(value, fn) {
  const original = process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
  if (value === undefined) delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
  else process.env.VIDEO_OS_RENDER_ACCOUNT_ID = value;
  try { return fn(); } finally {
    if (original === undefined) delete process.env.VIDEO_OS_RENDER_ACCOUNT_ID;
    else process.env.VIDEO_OS_RENDER_ACCOUNT_ID = original;
  }
}

test('a staff account listed in VIDEO_OS_RENDER_ACCOUNT_ID gets Premium despite the Standard-only domain', () => {
  for (const list of [STAFF_ID, `other-account,${STAFF_ID}`, ` other-account , ${STAFF_ID} `]) {
    withList(list, () => {
      assert.deepEqual(containedRenderingEntitlementKeys(STAFF_ID, STAFF_EMAIL), PREMIUM, list);
      assert.deepEqual(containedRenderingEntitlementKeys(STAFF_ID, STAFF_EMAIL.toUpperCase()), PREMIUM, 'email case does not matter');
      assert.equal(requireRenderAccountAuthorization(STAFF_ID, STAFF_EMAIL), true);
      assert.equal(configuredPremiumIdentity(STAFF_ID, STAFF_EMAIL), true, 'the persisted-grant gate agrees');
    });
  }
});

test('listing grants Premium, never the explicit tester key', () => {
  withList(STAFF_ID, () => {
    assert.equal(containedRenderingEntitlementKeys(STAFF_ID, STAFF_EMAIL).includes('tester'), false);
  });
});

test('a staff account NOT on the list stays Standard only (a domain match never gets liveRendering)', () => {
  for (const list of [undefined, 'some-other-account', `${STAFF_ID}`]) {
    withList(list, () => {
      assert.deepEqual(containedRenderingEntitlementKeys(OTHER_STAFF_ID, OTHER_STAFF_EMAIL), STANDARD, String(list));
      assert.equal(configuredPremiumIdentity(OTHER_STAFF_ID, OTHER_STAFF_EMAIL), false);
      assert.equal(accountAllowedForContainedRendering(OTHER_STAFF_ID, OTHER_STAFF_EMAIL), false);
    });
  }
  // Listing one staff account does not lift any other staff account.
  withList(STAFF_ID, () => {
    assert.throws(() => requireRenderAccountAuthorization(OTHER_STAFF_ID, OTHER_STAFF_EMAIL), { statusCode: 403 });
  });
});

test('a listed account with a non-staff email is unchanged (Premium), and an unlisted outsider gets nothing', () => {
  withList(STAFF_ID, () => {
    assert.deepEqual(containedRenderingEntitlementKeys(STAFF_ID, 'outsider@example.com'), PREMIUM);
    assert.deepEqual(containedRenderingEntitlementKeys('acct-outsider', 'outsider@example.com'), []);
  });
});

test('an empty, whitespace-only or malformed list grants nothing', () => {
  const lists = [undefined, '', ' ', '   ', '\t\n', ',', ',,,', ' , , ', '\u00a0',
    `${STAFF_ID};other`, `other;${STAFF_ID}`, `"${STAFF_ID}"`, `'${STAFF_ID}'`, `[${STAFF_ID}]`,
    `${STAFF_ID}|other`, `${STAFF_ID} other`, `${STAFF_ID}\nother`, '*', '.*', `${STAFF_ID.slice(0, 5)}*`];
  for (const list of lists) {
    withList(list, () => {
      const label = JSON.stringify(list ?? null);
      assert.deepEqual(containedRenderingEntitlementKeys(STAFF_ID, STAFF_EMAIL), STANDARD, `staff ${label}`);
      assert.deepEqual(containedRenderingEntitlementKeys('acct-outsider', 'outsider@example.com'), [], `outsider ${label}`);
      assert.equal(configuredPremiumIdentity(STAFF_ID, STAFF_EMAIL), false, `gate ${label}`);
      assert.equal(accountAllowedForContainedRendering(STAFF_ID), false, label);
      // An empty or blank account id never matches either.
      assert.deepEqual(containedRenderingEntitlementKeys('', STAFF_EMAIL), STANDARD, `blank id ${label}`);
      assert.deepEqual(containedRenderingEntitlementKeys('   ', STAFF_EMAIL), STANDARD, `space id ${label}`);
    });
  }
});

test('matching is exact on the whole id: not case-insensitive, not by prefix, suffix or substring', () => {
  const variants = [
    STAFF_ID.toUpperCase(),
    STAFF_ID[0].toUpperCase() + STAFF_ID.slice(1),
    STAFF_ID.slice(0, -1),
    STAFF_ID.slice(0, 8),
    `${STAFF_ID}x`,
    `x${STAFF_ID}`,
    STAFF_ID.slice(1),
  ];
  // Each variant is listed; the real id must not match it.
  for (const listed of variants) {
    withList(`other-account,${listed}`, () => {
      assert.deepEqual(containedRenderingEntitlementKeys(STAFF_ID, STAFF_EMAIL), STANDARD, `listed ${listed}`);
      assert.equal(configuredPremiumIdentity(STAFF_ID, STAFF_EMAIL), false, `gate listed ${listed}`);
    });
  }
  // The real id is listed; a variant account id must not match it.
  withList(STAFF_ID, () => {
    for (const candidate of variants) {
      assert.deepEqual(containedRenderingEntitlementKeys(candidate, STAFF_EMAIL), STANDARD, `candidate ${candidate}`);
      assert.equal(configuredPremiumIdentity(candidate, STAFF_EMAIL), false, `gate candidate ${candidate}`);
    }
  });
});

for (const scenario of ['signin', 'delist', 'gate']) {
  test(`render-list sign-in scenario: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/render-list-staff-scenario.mjs', scenario], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '', VIDEO_OS_RENDER_ACCOUNT_ID: '', VIDEO_OS_STANDARD_RENDER_EMAIL_DOMAINS: '' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`render-list scenario ${scenario} ok`));
  });
}
