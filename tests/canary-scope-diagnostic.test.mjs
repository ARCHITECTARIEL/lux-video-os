import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createCanaryScopeState, evaluateCanaryScope, handleCanaryScopeDiagnostic } from '../lib/canary-scope-diagnostic.js';
import { createDiagnosticLimiter } from '../lib/operator-diagnostic-guard.js';
import { DETAIL_KEYS, diagnosticAuditDetails } from '../lib/operator-diagnostic-audit.js';
import { prepareOpsEvent } from '../lib/ops-log.js';
import { handleProductionDbBindingDiagnostic } from '../lib/production-db-binding-diagnostic.js';
import { buildCanaryRequest, runCanaryScopeCheck } from '../tools/canary-scope-check.mjs';
import adminHandler from '../routes/video-os-lite/admin.js';
import workspaceHandler from '../api/video-os-lite/workspace.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const manifest = '987c494527adb6f4e7a08c0b68c38be6a1eb3d7430cdbdd4927ce6cfdd9961ef';
const deployment = 'fixture-deployment';
const pin = 'opaque-fixture-pin';

function fixture({ env: envChanges = {}, headers: headerChanges = {}, now = NOW, state = createCanaryScopeState() } = {}) {
  const env = {
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED: 'true',
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT: new Date(NOW).toISOString(),
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT: new Date(NOW + 30 * 60_000).toISOString(),
    VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN: 'operator-fixture',
    VIDEO_OS_ADMIN_TOKEN: 'admin-fixture', CRON_SECRET: 'cron-fixture',
    VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: deployment,
    VERCEL_GIT_COMMIT_SHA: 'commit-fixture', VERCEL_PROJECT_ID: 'project-fixture',
    VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: pin,
    VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: pin,
    VIDEO_OS_PROVIDER_CREATION_ENABLED: 'true',
    VIDEO_OS_IDENTITY_PROVIDER_ENABLED: 'true',
    HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED: 'true',
    VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED: 'true',
    VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'true',
    ...envChanges,
  };
  const nonce = randomBytes(32).toString('hex');
  const issuedAt = new Date(now).toISOString();
  const mac = (expectedPin = pin, deploymentId = deployment, issued = issuedAt) =>
    createHmac('sha256', Buffer.from(nonce, 'hex')).update(`vos-canary-pin/v1|${digest(deploymentId)}|${issued}|${expectedPin}`).digest('hex');
  const req = { method: 'GET', headers: {
    host: 'lux-video-os.vercel.app', authorization: 'Bearer operator-fixture',
    'x-expected-deployment-sha256': digest(deployment),
    'x-expected-git-commit-sha256': digest('commit-fixture'),
    'x-expected-project-sha256': digest('project-fixture'),
    'x-expected-target-manifest-sha256': manifest,
    'x-canary-nonce': nonce, 'x-canary-issued-at': issuedAt,
    'x-expected-canary-pin-mac': mac(), ...headerChanges,
  } };
  return { req, env, now, state, nonce, mac };
}

test('404 gate precedes authentication for closed window, method, environment and host', async () => {
  for (const change of [
    { env: { VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED: undefined } },
    { env: { VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT: new Date(NOW).toISOString() } },
    { env: { VERCEL_ENV: 'preview' } }, { headers: { host: 'wrong.example' } },
  ]) {
    const input = fixture(change); input.req.headers.authorization = '';
    assert.deepEqual(await evaluateCanaryScope(input), { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } });
  }
  const input = fixture(); input.req.method = 'POST'; input.req.headers.authorization = '';
  assert.equal((await evaluateCanaryScope(input)).status, 404);
});

test('operator token requires strict Bearer and cannot collide with admin or cron', async () => {
  for (const auth of ['', 'Bearer wrong', 'Bearer admin-fixture', 'Bearer cron-fixture',
    'Basic operator-fixture', 'Bearer operator-fixture extra', 'Bearer  operator-fixture']) {
    const input = fixture({ headers: { authorization: auth } });
    assert.deepEqual(await evaluateCanaryScope(input), { status: 401, body: { ok: false, code: 'operator_required' } });
  }
  for (const name of ['VIDEO_OS_ADMIN_TOKEN', 'CRON_SECRET']) {
    const input = fixture({ env: { [name]: 'operator-fixture' } });
    assert.equal((await evaluateCanaryScope(input)).status, 401);
  }
});

test('expected identity is required and mismatches return false booleans', async () => {
  const missing = fixture({ headers: { 'x-expected-project-sha256': undefined } });
  assert.deepEqual(await evaluateCanaryScope(missing), { status: 400, body: { ok: false, code: 'expected_identity_required' } });
  for (const name of ['x-expected-deployment-sha256', 'x-expected-git-commit-sha256',
    'x-expected-project-sha256', 'x-expected-target-manifest-sha256']) {
    const mismatch = fixture({ headers: { [name]: digest('wrong') } });
    const result = await evaluateCanaryScope(mismatch);
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    for (const value of Object.values(result.body)) if (typeof value === 'boolean') assert.equal(value, false);
  }
});

test('MAC is deployment-bound, case-sensitive, skew-limited and nonce single-use', async () => {
  const right = fixture();
  assert.equal((await evaluateCanaryScope(right)).body.canaryPinMatchesExpected, true);
  assert.deepEqual((await evaluateCanaryScope(right)).body, { ok: false, code: 'nonce_replayed' });
  for (const expectedPin of ['wrong', pin.toUpperCase(), `${pin} `]) {
    const input = fixture(); input.req.headers['x-expected-canary-pin-mac'] = input.mac(expectedPin);
    assert.equal((await evaluateCanaryScope(input)).body.canaryPinMatchesExpected, false);
  }
  const wrongDeploy = fixture();
  wrongDeploy.req.headers['x-expected-canary-pin-mac'] = wrongDeploy.mac(pin, 'other-deployment');
  assert.equal((await evaluateCanaryScope(wrongDeploy)).body.canaryPinMatchesExpected, false);
  for (const nonce of ['', 'ab', 'A'.repeat(64)]) {
    const input = fixture({ headers: { 'x-canary-nonce': nonce } });
    assert.deepEqual((await evaluateCanaryScope(input)).body, { ok: false, code: 'nonce_invalid' });
  }
  const stale = fixture({ headers: { 'x-canary-issued-at': new Date(NOW - 61_000).toISOString() } });
  assert.deepEqual((await evaluateCanaryScope(stale)).body, { ok: false, code: 'skew' });
});

test('scope matrix preserves pin containment and checks synthetic account separately', async () => {
  for (const flag of [undefined, 'TRUE ', 'yes', 'true']) {
    for (const activePin of ['', ' ', pin]) {
      const input = fixture({ env: { VIDEO_OS_PROVIDER_CREATION_ENABLED: flag, VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: activePin } });
      const result = await evaluateCanaryScope(input);
      assert.equal(result.body.providerCreationFlagExactlyTrue, flag === 'TRUE ' || flag === 'true');
      if (activePin.trim()) {
        assert.equal(result.body.providerCreationEnabledWithoutAccount, false);
        assert.equal(result.body.providerCreationEnabledForSyntheticAccount, false);
      }
    }
  }
  const input = fixture();
  let seen;
  const result = await evaluateCanaryScope({ ...input, syntheticAccount: () => 'synthetic-account',
    providerStatus: (_env, account) => { seen = account; return { enabled: account === pin }; } });
  assert.equal(seen, 'synthetic-account');
  assert.equal(result.body.providerCreationEnabledForSyntheticAccount, false);
});

test('diagnostic reports allowlist metadata without disclosing account IDs', async () => {
  const ids = 'opaque-fixture-pin,second-secret-account';
  const input = fixture({ env: { VIDEO_OS_IDENTITY_ALLOWED_ACCOUNT_IDS: ids } });
  const result = await evaluateCanaryScope(input);
  assert.equal(result.body.allowlistSource, 'allowlist');
  assert.equal(result.body.allowlistCount, 2);
  assert.equal(result.body.identityProviderPinMatchesCanaryPin, true);
  assert.equal(JSON.stringify(result.body).includes('second-secret-account'), false);
  const mismatch = await evaluateCanaryScope(fixture({ env: { VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'other' } }));
  assert.equal(mismatch.body.allowlistSource, 'legacy_pin_mismatch');
  assert.equal(mismatch.body.allowlistCount, 0);
});

test('every required scope condition independently fails the all-expected baseline', async () => {
  assert.equal((await evaluateCanaryScope(fixture())).status, 200);
  const cases = [
    ['pin absent', { VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: '' }, {}, 'canaryPinPresent'],
    ['pin mismatch', { VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: 'different-pin' }, {}, 'canaryPinMatchesExpected'],
    ['creation off', { VIDEO_OS_PROVIDER_CREATION_ENABLED: 'false' }, {}, 'providerCreationFlagExactlyTrue'],
    ['provider pin disabled', {}, { providerStatus: () => ({ enabled: false }) }, 'providerCreationEnabledForExpectedPin'],
    ['unscoped creation', {}, { providerStatus: (_env, account) => ({ enabled: account === pin || account === undefined }) }, 'providerCreationEnabledWithoutAccount'],
    ['synthetic creation', {}, { providerStatus: (_env, account) => ({ enabled: account === pin || account === 'synthetic-account' }), syntheticAccount: () => 'synthetic-account' }, 'providerCreationEnabledForSyntheticAccount'],
    ['identity provider off', { VIDEO_OS_IDENTITY_PROVIDER_ENABLED: 'false' }, {}, 'identityProviderEnabled'],
    ['privacy unconfirmed', { HEYGEN_IDENTITY_ASSET_PRIVACY_CONFIRMED: 'false' }, {}, 'identityAssetPrivacyConfirmed'],
    ['identity pin differs', { VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: 'different-pin' }, {}, 'identityProviderPinMatchesCanaryPin'],
    ['identity pin unset', { VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: undefined }, {}, 'identityProviderPinMatchesCanaryPin'],
    ['consent off', { VIDEO_OS_HOSTED_SUBJECT_CONSENT_ENABLED: 'false' }, {}, 'hostedSubjectConsentEnabled'],
    ['billing on', { VIDEO_OS_BILLING_ENABLED: 'true' }, {}, 'billingDisabled'],
    ['durable render on', { VIDEO_OS_DURABLE_WORKFLOW_ENABLED: 'true' }, {}, 'durableRenderDisabled'],
    ['standard render on', { VIDEO_OS_STANDARD_RENDER_ENABLED: 'true' }, {}, 'standardRenderDisabled'],
    ['scripted photo on', { VIDEO_OS_SCRIPTED_PHOTO_ENABLED: 'true' }, {}, 'scriptedPhotoDisabled'],
    ['phone enrollment on', { VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED: 'true' }, {}, 'phoneEnrollmentDisabled'],
    ['phone extraction on', { VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED: 'true' }, {}, 'phoneExtractionDisabled'],
    ['maintenance off', { VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'false' }, {}, 'maintenanceAdmissionActive'],
  ];
  for (const [name, env, overrides, field] of cases) {
    const result = await evaluateCanaryScope({ ...fixture({ env }), ...overrides });
    assert.equal(result.status, 409, name);
    assert.equal(result.body.ok, false, name);
    assert.equal(result.body.canaryScopeAsExpected, false, name);
    assert.equal(result.body[field], field.includes('WithoutAccount') || field.includes('SyntheticAccount'), name.includes('creation') && !name.includes('off'), name);
  }
});

test('wrong MAC cannot claim provider creation for the expected pin', async () => {
  const input = fixture();
  input.req.headers['x-expected-canary-pin-mac'] = input.mac('different-pin');
  const result = await evaluateCanaryScope(input);
  assert.equal(result.body.canaryPinMatchesExpected, false);
  assert.equal(result.body.providerCreationEnabledForExpectedPin, false);
  assert.equal(result.status, 409);
});

test('audit details accept only listed boolean fields and fixed codes', () => {
  const unknown = 'privatePin';
  const nonBooleans = ['true', 1, 'a'.repeat(64), { ok: true }, null];
  for (const value of nonBooleans) {
    assert.deepEqual(diagnosticAuditDetails({ ok: value, canaryPinPresent: value, [unknown]: true, code: value }), {});
  }
  assert.deepEqual(diagnosticAuditDetails({ ok: true, canaryPinPresent: false, code: 'nonce_replayed', [unknown]: true }),
    { ok: true, code: 'nonce_replayed', canaryPinPresent: false });
  for (const code of ['unexpected', 'nonce_replayed_extra', 'a'.repeat(64)]) {
    assert.deepEqual(diagnosticAuditDetails({ code }), {});
  }
  assert.equal(DETAIL_KEYS.includes(unknown), false);
  const { row } = prepareOpsEvent({ event: 'admin.canary_scope.checked', details: {
    ok: true, code: 'diagnostic_unavailable', canaryPinPresent: false,
    privatePin: 'secret', canaryPinMatchesExpected: 'true',
  } });
  assert.deepEqual(row.details, { ok: true, code: 'diagnostic_unavailable', canaryPinPresent: false });
});

test('MAC comparator is injectable and its output is never serialized', async () => {
  const input = fixture(); let called = 0;
  const result = await evaluateCanaryScope({ ...input, compareMac: (actual, expected) => {
    called += 1; assert.equal(actual.length, 32); assert.equal(expected.length, 32); return true;
  } });
  assert.equal(called, 1);
  assert.equal(JSON.stringify(result).includes(input.mac()), false);
});

test('response and audit leak neither random pin, its digest nor its MAC', async () => {
  for (let i = 0; i < 4; i += 1) {
    const secretPin = randomBytes(20).toString('hex');
    const input = fixture({ env: { VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: secretPin,
      VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID: secretPin } });
    input.req.headers['x-expected-canary-pin-mac'] = input.mac(secretPin);
    const audits = [];
    const res = { setHeader() {}, end(value) { this.body = value; } };
    await handleCanaryScopeDiagnostic(input.req, res, { ...input, audit: async (event, body) => audits.push({ event, body }) });
    const serialized = JSON.stringify({ response: res.body, audits });
    for (const forbidden of [secretPin, digest(secretPin), input.mac(secretPin)]) assert.equal(serialized.includes(forbidden), false);
    assert.equal(audits[0].event, 'admin.canary_scope.checked');
  }
});

test('durable canary audit row contains only allow-listed booleans and fixed code', async () => {
  const secretPin = randomBytes(20).toString('hex');
  const input = fixture({ env: { VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID: secretPin } });
  input.req.headers['x-expected-canary-pin-mac'] = input.mac(secretPin);
  const lines = [];
  const rows = [];
  const previous = console.log;
  console.log = (line) => lines.push(line);
  try {
    const res = { setHeader() {}, end(value) { this.body = value; } };
    await handleCanaryScopeDiagnostic(input.req, res, { ...input,
      db: () => { throw new Error('diagnostic DB opened'); }, auditWriter: async row => rows.push(row) });
    const combined = JSON.stringify({ lines, rows, response: res.body });
    for (const forbidden of [secretPin, digest(secretPin), input.mac(secretPin)]) assert.equal(combined.includes(forbidden), false);
    assert.equal(lines.length, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'admin.canary_scope.checked');
    assert.deepEqual(rows[0].details, JSON.parse(lines[0]).details);
    assert.ok(Object.entries(rows[0].details).every(([key, value]) =>
      DETAIL_KEYS.includes(key) && (typeof value === 'boolean' || (key === 'code' && typeof value === 'string'))));
  } finally { console.log = previous; }
});

test('canary audit write failure preserves the evaluated response', async () => {
  const input = fixture();
  const res = { setHeader() {}, end(value) { this.body = value; } };
  await handleCanaryScopeDiagnostic(input.req, res, { ...input, auditWriter: async () => { throw new Error('private audit failure'); } });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('rate limit denies sixth request per minute and twenty-first per window', async () => {
  const state = createCanaryScopeState();
  for (let i = 0; i < 21; i += 1) {
    const input = fixture({ now: NOW + Math.floor(i / 5) * 60_000, state });
    const result = await evaluateCanaryScope(input);
    assert.equal(result.status, i < 20 ? 200 : 429, `attempt ${i + 1}`);
  }
  const minute = createCanaryScopeState();
  for (let i = 0; i < 6; i += 1) {
    const input = fixture({ state: minute });
    assert.equal((await evaluateCanaryScope(input)).status, i < 5 ? 200 : 429);
  }
});

test('anonymous availability failures cannot reset minute, window, or nonce state', async () => {
  for (const [name, mutate] of [
    ['POST', (input) => { input.req.method = 'POST'; }],
    ['wrong host', (input) => { input.req.headers.host = 'wrong.example'; }],
    ['non-production', (input) => { input.env.VERCEL_ENV = 'preview'; }],
  ]) {
    const state = createCanaryScopeState();
    const first = fixture({ state });
    assert.equal((await evaluateCanaryScope(first)).status, 200, name);
    const anonymous = fixture({ state });
    anonymous.req.headers.authorization = '';
    mutate(anonymous);
    assert.equal((await evaluateCanaryScope(anonymous)).status, 404, name);
    assert.deepEqual((await evaluateCanaryScope(first)).body, { ok: false, code: 'nonce_replayed' }, name);
    for (let i = 0; i < 3; i += 1) assert.equal((await evaluateCanaryScope(fixture({ state }))).status, 200, name);
    assert.equal((await evaluateCanaryScope(fixture({ state }))).status, 429, name);

    const windowState = createCanaryScopeState();
    for (let i = 0; i < 20; i += 1) {
      const now = NOW + Math.floor(i / 5) * 60_000;
      assert.equal((await evaluateCanaryScope(fixture({ now, state: windowState }))).status, 200, `${name} ${i}`);
      const denied = fixture({ now, state: windowState });
      denied.req.headers.authorization = '';
      mutate(denied);
      assert.equal((await evaluateCanaryScope(denied)).status, 404, name);
    }
    assert.equal((await evaluateCanaryScope(fixture({ now: NOW + 4 * 60_000, state: windowState }))).status, 429, name);
  }
});

test('authentication precedes rate limit; rate limit precedes identity checks', async () => {
  const state = createCanaryScopeState();
  for (let i = 0; i < 5; i += 1) assert.equal((await evaluateCanaryScope(fixture({ state }))).status, 200);
  for (const authorization of ['', 'Bearer wrong']) {
    const invalid = fixture({ state, headers: { authorization } });
    assert.deepEqual(await evaluateCanaryScope(invalid), { status: 401, body: { ok: false, code: 'operator_required' } });
  }
  const missingIdentity = fixture({ state, headers: { 'x-expected-project-sha256': undefined } });
  assert.deepEqual(await evaluateCanaryScope(missingIdentity), { status: 429, body: { ok: false, code: 'rate_limited' } });
  const fresh = createCanaryScopeState();
  const unauthorized = fixture({ state: fresh, headers: { authorization: '' } });
  assert.equal((await evaluateCanaryScope(unauthorized)).status, 401);
  for (let i = 0; i < 5; i += 1) assert.equal((await evaluateCanaryScope(fixture({ state: fresh }))).status, 200);
  assert.equal((await evaluateCanaryScope(fixture({ state: fresh }))).status, 429);
});

test('db-binding handler adds rate limit and awaited audit without changing evaluation', async () => {
  const input = fixture();
  const audit = [];
  const rateLimit = createDiagnosticLimiter();
  for (let i = 0; i < 6; i += 1) {
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await handleProductionDbBindingDiagnostic(input.req, res, { env: input.env, now: NOW,
      rateLimit, requireOperator: true, audit: async (event, body) => audit.push({ event, body }),
      db: () => { throw new Error('DB should not open on mismatch'); } });
    assert.equal(res.statusCode, i < 5 ? 409 : 429);
  }
  assert.equal(audit.length, 6);
  assert.ok(audit.every((entry) => entry.event === 'admin.db_binding.checked'));
  const windowLimit = createDiagnosticLimiter();
  for (let i = 0; i < 21; i += 1) {
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    await handleProductionDbBindingDiagnostic(input.req, res, { env: input.env,
      now: NOW + Math.floor(i / 5) * 60_000, rateLimit: windowLimit, requireOperator: true,
      audit: async () => {}, db: () => { throw new Error('DB opened'); } });
    assert.equal(res.statusCode, i < 20 ? 409 : 429);
  }
});

test('anonymous nonproduction diagnostics fail at the handlers before auth or state changes', async () => {
  const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); } });
  for (const vercelEnv of [undefined, 'development', 'preview']) {
    const input = fixture({ env: { VERCEL_ENV: vercelEnv }, headers: { authorization: '' } });
    const rateCalls = [];
    const rateLimit = { consume() { rateCalls.push('consume'); return true; }, clear() { rateCalls.push('clear'); } };
    const dbRes = response();
    await handleProductionDbBindingDiagnostic(input.req, dbRes, {
      env: input.env, now: NOW, requireOperator: true, rateLimit, audit: async () => {},
      db: () => { throw new Error('DB opened'); },
    });
    assert.equal(dbRes.statusCode, 404);
    assert.equal(dbRes.body.code, 'diagnostic_unavailable');
    assert.deepEqual(rateCalls, []);

    const stateCalls = [];
    const state = { resetIfWindowChanged() { stateCalls.push('reset'); },
      rateLimit: { consume() { stateCalls.push('consume'); return true; } },
      useNonce() { stateCalls.push('nonce'); return true; } };
    const canaryRes = response();
    await handleCanaryScopeDiagnostic(input.req, canaryRes, { env: input.env, now: NOW, state, audit: async () => {} });
    assert.equal(canaryRes.statusCode, 404);
    assert.equal(canaryRes.body.code, 'diagnostic_unavailable');
    assert.deepEqual(stateCalls, []);

    const envNames = Object.keys(input.env);
    const prior = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, input.env);
      if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
      process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT = new Date(Date.now() - 1000).toISOString();
      process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
      for (const operation of ['db-binding', 'canary-scope']) {
        const req = { method: 'GET', url: `/api/video-os-lite/admin?operation=${operation}`,
          headers: { host: 'lux-video-os.vercel.app', authorization: '' } };
        const res = response();
        await adminHandler(req, res);
        assert.equal(res.statusCode, 404, operation);
        assert.equal(res.body.code, 'diagnostic_unavailable', operation);
      }
    } finally {
      for (const name of envNames) {
        if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
      }
    }
  }

  const input = fixture({ headers: { authorization: '' } });
  input.req.method = 'POST';
  const res = response();
  await handleProductionDbBindingDiagnostic(input.req, res, { env: input.env, now: NOW,
    requireOperator: true, rateLimit: { consume() { throw new Error('rate touched'); },
      clear() { throw new Error('rate cleared'); } }, audit: async () => {} });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'diagnostic_unavailable');
});

test('admin canary dispatch returns 404 before auth and never grants ordinary admin access', async () => {
  const input = fixture();
  const names = Object.keys(input.env);
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, input.env);
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT = new Date(Date.now() - 1000).toISOString();
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
    const call = async (method, operation, auth = '', handler = adminHandler) => {
      const req = { method, url: `/api/video-os-lite/admin?operation=${operation}`,
        headers: { host: 'lux-video-os.vercel.app', authorization: auth } };
      const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
      await handler(req, res);
      return res;
    };
    assert.equal((await call('POST', 'canary-scope')).statusCode, 405);
    assert.equal((await call('POST', 'canary-scope', '', workspaceHandler)).statusCode, 503);
    assert.equal((await call('GET', 'canary-scope', 'Bearer wrong')).statusCode, 401);
    assert.equal((await call('GET', 'jobs', 'Bearer operator-fixture')).statusCode, 401);
    process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED = 'false';
    assert.equal((await call('GET', 'canary-scope', 'Bearer wrong')).statusCode, 404);
  } finally {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  }
});

test('non-GET canary route never invokes diagnostic audit or state', async () => {
  const lines = [];
  const priorLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    for (const method of ['POST', 'HEAD', 'DELETE']) {
      const req = { method, url: '/api/video-os-lite/admin?operation=canary-scope',
        headers: { host: 'lux-video-os.vercel.app' } };
      const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
        end(value) { this.body = value; } };
      await adminHandler(req, res);
      assert.equal(res.statusCode, 405, method);
      assert.equal(res.headers.Allow, 'GET', method);
    }
    assert.deepEqual(lines, []);
  } finally { console.log = priorLog; }
});

test('canary operation never opens a DB and CLI sends one GET only with --send', async () => {
  const input = fixture();
  const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
  await handleCanaryScopeDiagnostic(input.req, res, { ...input, db: () => { throw new Error('DB opened'); }, audit: async () => {} });
  assert.equal(res.statusCode, 200);
  const nonce = Buffer.alloc(32, 7);
  const request = buildCanaryRequest({ url: 'https://lux-video-os.vercel.app/admin', pin,
    deploymentId: deployment, gitCommit: 'commit-fixture', projectId: 'project-fixture',
    targetManifestSha256: manifest, operatorToken: 'operator-fixture', now: new Date(NOW), nonce });
  assert.equal(request.headers['x-expected-canary-pin-mac'], createHmac('sha256', nonce)
    .update(`vos-canary-pin/v1|${digest(deployment)}|${new Date(NOW).toISOString()}|${pin}`).digest('hex'));
  let calls = 0; const logs = [];
  const args = ['--url', 'https://lux-video-os.vercel.app/admin', '--pin-file', 'pin.txt',
    '--deployment-id', deployment, '--git-commit', 'commit-fixture', '--project-id', 'project-fixture',
    '--target-manifest-sha256', manifest];
  const injected = { readPin: () => `${pin}\n`, env: { VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN: 'operator-fixture' },
    now: new Date(NOW), nonce, log: (line) => logs.push(line), fetchImpl: async (_url, init) => {
      calls += 1; assert.equal(init.method, 'GET'); return { text: async () => '{"ok":true,"canaryPinPresent":true}' };
    } };
  await runCanaryScopeCheck(args, injected);
  assert.equal(calls, 0); assert.equal(logs[0].includes('operator-fixture'), false);
  const dryRun = JSON.parse(logs[0]);
  assert.equal(dryRun.headers['x-canary-nonce'], '[redacted]');
  assert.equal(dryRun.headers['x-expected-canary-pin-mac'], '[redacted]');
  assert.equal(logs[0].includes(nonce.toString('hex')), false);
  assert.equal(logs[0].includes(request.headers['x-expected-canary-pin-mac']), false);
  await runCanaryScopeCheck([...args, '--send'], injected);
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(logs[1]), {
    ok: true, canaryPinPresent: true, responseBodySha256: digest('{"ok":true,"canaryPinPresent":true}'),
  });
});
