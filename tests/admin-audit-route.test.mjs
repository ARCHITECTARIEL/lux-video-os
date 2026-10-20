import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handleAuthRequest } from '../api/video-os-lite/auth.js';
import { adminActorType, createAdminHandler } from '../routes/video-os-lite/admin.js';
import { makeSession } from '../lib/video-os-account.js';
import { prepareOpsEvent } from '../lib/ops-log.js';

const TEST_ENV = Object.freeze({
  VIDEO_OS_ADMIN_TOKEN: 'proof-admin-token',
  CRON_SECRET: 'proof-cron-secret',
  DATABASE_URL: 'postgres://fixture.invalid/app',
  BLOB_READ_WRITE_TOKEN: 'fixture-blob-token',
  HEYGEN_API_KEY: 'fixture-provider-key',
  VERCEL_DEPLOYMENT_ID: 'dpl_admin_audit_fixture',
  VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'false',
});

function request(operation, body, { method = 'POST', headers = {}, url } = {}) {
  return {
    method, url: url || `/api/video-os-lite/admin?operation=${operation}`,
    headers: { host: 'lux-video-os.vercel.app', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.rawBody = value; this.body = value ? JSON.parse(value) : undefined; this.ended = true; } };
}

test('admin mutations persist exact audit rows before sending the response', async () => {
  const cases = [
    ['grant-credit', { accountId: 'account-1', amount: 12, idempotencyKey: 'once' },
      { grantAdminCredit: async () => ({ duplicate: true, balance: 12 }) },
      { event: 'admin.credit.granted', accountId: 'account-1', code: 'CREDIT_GRANT_REPLAYED', details: { adminActor: 'admin', amount: 12, duplicate: true } }],
    ['quarantine-asset', { mediaAssetId: 'asset-1', reason: 'private@example.com' },
      { quarantineMediaAsset: async () => ({ id: 'asset-1', accountId: 'account-2' }) },
      { event: 'admin.asset.quarantined', accountId: 'account-2', code: null, details: { adminActor: 'admin' } }],
    ['register-tester', { email: 'private.person@example.com', name: 'Private Person', credits: 180 },
      { registerAdminTester: async () => ({ account: { id: 'account-3' } }) },
      { event: 'admin.tester.registered', accountId: 'account-3', code: null, details: { adminActor: 'admin', testerDomain: 'example.com' } }],
  ];
  const originalLog = console.log;
  const lines = [];
  console.log = line => lines.push(line);
  try {
    for (const [operation, body, mutation, expected] of cases) {
      const res = response();
      let releaseRequestAudit;
      let requestAuditEntered;
      const entered = new Promise(resolve => { requestAuditEntered = resolve; });
      const rows = [];
      const running = createAdminHandler({
        isAdminRequest: () => true, env: TEST_ENV, ...mutation,
        opsWriter: row => {
          rows.push(row);
          if (row.event !== 'admin.request.completed') return undefined;
          requestAuditEntered();
          return new Promise(resolve => { releaseRequestAudit = resolve; });
        },
      })(request(operation, body), res);
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} did not persist an audit row`)), 1000))]);
      assert.equal(res.ended, undefined, `${operation} responded before audit persistence completed`);
      assert.equal(rows.length, 2, `${operation} must persist its mutation row and request row`);
      assert.deepEqual(Object.fromEntries(['event', 'accountId', 'code', 'details'].map(key => [key, rows[0][key]])), expected);
      assert.deepEqual(rows[1].details, {
        operation, result: 'succeeded', actorType: 'admin_token',
        ipPrefix: '127.0.0.0/24', userAgent: 'unknown',
        deploymentId: TEST_ENV.VERCEL_DEPLOYMENT_ID, gitSha: TEST_ENV.VERCEL_GIT_COMMIT_SHA,
      });
      assert.equal(Object.hasOwn(rows[1].details, 'ipHash'), false);
      assert.equal(rows[1].httpStatus, 200);
      assert.equal(rows[1].code, 'ADMIN_REQUEST_SUCCEEDED');
      assert.equal(JSON.stringify(rows).includes('private.person@example.com'), false);
      releaseRequestAudit();
      await running;
      assert.equal(res.statusCode, 200);
      assert.equal(res.ended, true);
    }
  } finally { console.log = originalLog; }
  assert.equal(JSON.stringify(lines).includes('private.person@example.com'), false);
});

test('register-tester rejects missing or unsafe credit amounts before calling its mutation', async () => {
  const invalidCases = [
    ['missing', {}],
    ['null', { credits: null }],
    ['boolean', { credits: false }],
    ['numeric string', { credits: '180' }],
    ['object', { credits: {} }],
    ['zero', { credits: 0 }],
    ['below range', { credits: 99 }],
    ['fractional', { credits: 100.5 }],
    ['above range', { credits: 181 }],
    ['unsafe integer', { credits: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  let mutationCalls = 0;
  const handler = createAdminHandler({
    isAdminRequest: () => true,
    env: TEST_ENV,
    registerAdminTester: async () => { mutationCalls += 1; return { account: { id: 'must-not-run' } }; },
    opsWriter: async () => {},
  });

  for (const [label, creditInput] of invalidCases) {
    const res = response();
    await handler(request('register-tester', { email: 'bounded.tester@example.com', ...creditInput }), res);
    assert.equal(res.statusCode, 400, label);
    assert.match(res.body.error, /credits must be a whole number from 100 to 180/i, label);
    assert.equal(mutationCalls, 0, `${label} must fail before registerAdminTester`);
  }
});

test('admin mutation succeeds when audit persistence fails and emits alertable audit failure', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors = [];
  console.log = () => {};
  console.error = line => errors.push(JSON.parse(line));
  try {
    const res = response();
    await createAdminHandler({
      isAdminRequest: () => true, env: TEST_ENV,
      grantAdminCredit: async () => ({ duplicate: false }),
      opsWriter: async () => { throw new Error('private@example.com'); },
    })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(errors.some(({ event, code, auditEvent }) => event === 'ops.audit.persist.failed' && code === 'OPS_AUDIT_PERSIST_FAILED' && auditEvent === 'admin.credit.granted'));
    assert.equal(JSON.stringify(errors).includes('private@example.com'), false);
  } finally { console.log = originalLog; console.error = originalError; }
});

test('admin validation returns safe 4xx text and hides errors without a status', async () => {
  const req = { method: 'GET', url: '/api/video-os-lite/admin?operation=activity&limit=invalid', headers: {} };
  const res = response();
  const originalLog = console.log;
  console.log = () => {};
  try {
    await createAdminHandler({ isAdminRequest: () => true, env: TEST_ENV, opsWriter: async () => {} })(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Expected a whole number between 1 and 100.');
    const failed = response();
    await createAdminHandler({
      isAdminRequest: () => true, env: TEST_ENV, opsWriter: async () => {},
      grantAdminCredit: async () => { throw new Error('private DB detail'); },
    })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }), failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.error, 'Admin request failed.');
  } finally { console.log = originalLog; }
});

test('cron credentials are limited to scheduled operations and every decision is audited', async () => {
  const rows = [];
  const calls = [];
  const handler = createAdminHandler({
    env: TEST_ENV,
    opsWriter: async row => rows.push(row),
    grantAdminCredit: async () => { calls.push('grant-credit'); return { duplicate: false }; },
    handleDeleteVideo: async () => { calls.push('delete-video'); return { id: 'job-1' }; },
    runWatchdogSweep: async () => { calls.push('watchdog-sweep'); return { checked: 0 }; },
    reconcileStripePayments: async () => { calls.push('stripe-reconciliation'); return { mismatchCount: 0, sessionsChecked: 0 }; },
  });
  const cronHeaders = { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` };
  for (const [operation, body] of [
    ['grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }],
    ['delete-video', { jobId: 'job-1' }],
  ]) {
    const res = response();
    await handler(request(operation, body, { headers: cronHeaders }), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, code: 'cron_scope_forbidden' });
  }
  assert.deepEqual(calls, []);

  const watchdog = response();
  await handler(request('watchdog-sweep', {}, { headers: cronHeaders }), watchdog);
  assert.equal(watchdog.statusCode, 200);
  const stripe = response();
  await handler(request('stripe-reconciliation', {}, { headers: cronHeaders }), stripe);
  assert.equal(stripe.statusCode, 200);
  assert.deepEqual(calls, ['watchdog-sweep', 'stripe-reconciliation']);
  assert.ok(rows.some(row => row.event === 'watchdog_heartbeat' && row.httpStatus === 200));
  const requestRows = rows.filter(row => row.event === 'admin.request.completed');
  assert.deepEqual(requestRows.map(row => [row.details.operation, row.httpStatus, row.details.actorType]), [
    ['grant-credit', 403, 'cron_secret'],
    ['delete-video', 403, 'cron_secret'],
    ['watchdog-sweep', 200, 'cron_secret'],
    ['stripe-reconciliation', 200, 'cron_secret'],
  ]);
});

test('admin bearer token retains all scheduled and privileged write operations', async () => {
  const calls = [];
  const handler = createAdminHandler({
    env: TEST_ENV,
    opsWriter: async () => {},
    grantAdminCredit: async () => { calls.push('grant-credit'); return { duplicate: false }; },
    handleDeleteVideo: async () => { calls.push('delete-video'); return { id: 'job-1' }; },
    runWatchdogSweep: async () => { calls.push('watchdog-sweep'); return { checked: 0 }; },
    reconcileStripePayments: async () => { calls.push('stripe-reconciliation'); return { mismatchCount: 0, sessionsChecked: 0 }; },
  });
  const headers = { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` };
  const cases = [
    ['grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }],
    ['delete-video', { jobId: 'job-1' }],
    ['watchdog-sweep', {}],
    ['stripe-reconciliation', {}],
  ];
  for (const [operation, body] of cases) {
    const res = response();
    await handler(request(operation, body, { headers }), res);
    assert.equal(res.statusCode, 200, operation);
  }
  assert.deepEqual(calls, cases.map(([operation]) => operation));
});

test('admin actor classification uses only the four fixed actor types', () => {
  const originalSecret = process.env.VIDEO_OS_SESSION_SECRET;
  process.env.VIDEO_OS_SESSION_SECRET = 'admin-audit-session-secret-with-adequate-length';
  try {
    assert.equal(adminActorType(request('jobs', undefined, { method: 'GET', headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` } }), TEST_ENV), 'admin_token');
    assert.equal(adminActorType(request('jobs', undefined, { method: 'GET', headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } }), TEST_ENV), 'cron_secret');
    const session = makeSession('admin', 'owner@example.invalid', 60);
    assert.equal(adminActorType(request('jobs', undefined, { method: 'GET', headers: { cookie: `vos_admin=${encodeURIComponent(session)}` } }), TEST_ENV), 'session');
    assert.equal(adminActorType(request('jobs', undefined, { method: 'GET' }), TEST_ENV), 'none');
  } finally {
    if (originalSecret === undefined) delete process.env.VIDEO_OS_SESSION_SECRET;
    else process.env.VIDEO_OS_SESSION_SECRET = originalSecret;
  }
});

test('unauthorized, method-rejected, and maintenance-blocked requests keep fixed audit outcomes', async () => {
  const cases = [
    {
      env: TEST_ENV,
      req: request('jobs', undefined, { method: 'GET' }),
      status: 401, result: 'rejected', code: 'ADMIN_REQUEST_REJECTED', actorType: 'none',
    },
    {
      env: TEST_ENV,
      req: request('jobs', undefined, { method: 'DELETE', headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` } }),
      status: 405, result: 'rejected', code: 'ADMIN_REQUEST_REJECTED', actorType: 'admin_token',
    },
    {
      env: { ...TEST_ENV, VIDEO_OS_DIAGNOSTIC_MAINTENANCE: 'true' },
      req: request('jobs', undefined, { method: 'GET', headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` } }),
      status: 503, result: 'failed', code: 'ADMIN_REQUEST_FAILED', actorType: 'admin_token',
    },
  ];
  for (const current of cases) {
    const rows = [];
    const res = response();
    await createAdminHandler({ env: current.env, opsWriter: async row => rows.push(row) })(current.req, res);
    assert.equal(res.statusCode, current.status);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'admin.request.completed');
    assert.equal(rows[0].httpStatus, current.status);
    assert.equal(rows[0].code, current.code);
    assert.equal(rows[0].details.result, current.result);
    assert.equal(rows[0].details.actorType, current.actorType);
  }
});

test('request audit stores bounded request context without raw credentials or full IP', async () => {
  const token = 'admin-token-sentinel-do-not-log';
  const fullIp = '203.0.113.44';
  const uaTail = 'UA_TAIL_SENTINEL';
  const env = { ...TEST_ENV, VIDEO_OS_ADMIN_TOKEN: token };
  const rows = [];
  const logs = [];
  const originalLog = console.log;
  console.log = line => logs.push(String(line));
  try {
    const res = response();
    await createAdminHandler({
      env,
      opsWriter: async row => rows.push(row),
      grantAdminCredit: async () => ({ duplicate: false }),
    })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }, { headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': `${fullIp}, 10.0.0.1`,
      'user-agent': `audit-agent/${'u'.repeat(150)}${uaTail}`,
    } }), res);
    assert.equal(res.statusCode, 200);
  } finally {
    console.log = originalLog;
  }
  const serialized = JSON.stringify({ rows, logs });
  assert.doesNotMatch(serialized, new RegExp(token));
  assert.doesNotMatch(serialized, new RegExp(fullIp.replaceAll('.', '\\.')));
  assert.doesNotMatch(serialized, new RegExp(uaTail));
  const audit = rows.find(row => row.event === 'admin.request.completed');
  assert.equal(audit.details.ipPrefix, '203.0.113.0/24');
  assert.equal(Object.hasOwn(audit.details, 'ipHash'), false);
  assert.doesNotMatch(JSON.stringify(audit.details), new RegExp(createHash('sha256').update(fullIp).digest('hex').slice(0, 24)));
  assert.ok(audit.details.userAgent.length <= 120);
});

test('request audit reduces IPv6 sources to a /48 prefix', async () => {
  const rows = [];
  const res = response();
  await createAdminHandler({ env: TEST_ENV, opsWriter: async row => rows.push(row) })(request('not-real', undefined, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}`,
      'x-forwarded-for': '2001:0db8:85a3:1234:5678:8a2e:0370:7334',
    },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(rows[0].details.ipPrefix, '2001:db8:85a3::/48');
  assert.equal(Object.hasOwn(rows[0].details, 'ipHash'), false);
});

test('admin audit sanitizer bounds userAgent and drops injected IP hashes', () => {
  const details = prepareOpsEvent({ event: 'admin.request.completed', details: {
    operation: 'jobs', result: 'rejected', actorType: 'none', ipPrefix: '2001:db8:85a3::/48',
    ipHash: 'a'.repeat(24), userAgent: 'x'.repeat(500), deploymentId: 'fixture', gitSha: 'a'.repeat(40),
  } }).row.details;
  assert.ok(details.userAgent.length <= 120);
  assert.equal(Object.hasOwn(details, 'ipHash'), false);
});

test('bare cron secret is rejected without Bearer', async () => {
  const res = response();
  await createAdminHandler({ env: TEST_ENV, opsWriter: async () => {} })(request('watchdog-sweep', {}, {
    headers: { authorization: TEST_ENV.CRON_SECRET },
  }), res);
  assert.equal(res.statusCode, 401);
});

test('native cron GET is scoped to the cron secret and persists a heartbeat only after a successful sweep', async () => {
  const calls = [];
  const rows = [];
  const handler = createAdminHandler({
    env: TEST_ENV, opsWriter: async row => rows.push(row),
    watchdogDbProbe: async () => {},
    runWatchdogSweep: async () => { calls.push('sweep'); return { checked: 0, jobs: { alertedIds: ['private-job'] } }; },
  });
  const url = '/api/video-os-lite/watchdog-cron';
  for (const [method, headers, status] of [
    ['GET', {}, 401],
    ['GET', { authorization: 'Bearer incorrect' }, 401],
    ['GET', { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` }, 403],
    ['POST', { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` }, 405],
  ]) {
    const res = response();
    await handler(request('watchdog-sweep', undefined, { method, headers, url }), res);
    assert.equal(res.statusCode, status);
  }
  assert.deepEqual(calls, []);
  assert.equal(rows.some(row => row.event === 'watchdog_heartbeat'), false);

  const res = response();
  await handler(request('watchdog-sweep', undefined, {
    method: 'GET', headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` }, url,
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(calls, ['sweep']);
  assert.equal(rows.filter(row => row.event === 'watchdog_heartbeat').length, 1);
  assert.equal(JSON.stringify(res.body).includes('private-job'), false);
});

test('native cron failure cannot advance the persisted heartbeat', async () => {
  const rows = [];
  const handler = createAdminHandler({
    env: TEST_ENV, opsWriter: async row => rows.push(row),
    watchdogDbProbe: async () => {},
    runWatchdogSweep: async () => { throw new Error('private provider detail'); },
  });
  const res = response();
  await handler(request('watchdog-sweep', undefined, {
    method: 'GET', url: '/api/video-os-lite/watchdog-cron',
    headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
  }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(rows.some(row => row.event === 'watchdog_heartbeat'), false);
  assert.equal(JSON.stringify(res.body).includes('private provider detail'), false);
});

test('native cron reports failure when its completed sweep cannot persist the heartbeat', async () => {
  let calls = 0;
  const handler = createAdminHandler({
    env: TEST_ENV,
    watchdogDbProbe: async () => {},
    opsWriter: async row => { if (row.event === 'watchdog_heartbeat') throw new Error('private database detail'); },
    runWatchdogSweep: async () => { calls += 1; return { checked: 0 }; },
  });
  const res = response();
  await handler(request('watchdog-sweep', undefined, {
    method: 'GET', url: '/api/video-os-lite/watchdog-cron',
    headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
  }), res);
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, code: 'watchdog_heartbeat_unpersisted' });
});

test('native cron does no sweep when a required dependency is absent or the DB probe fails', async () => {
  for (const [env, probe] of [
    [{ ...TEST_ENV, DATABASE_URL: '' }, async () => {}],
    [{ ...TEST_ENV, BLOB_READ_WRITE_TOKEN: '' }, async () => {}],
    [{ ...TEST_ENV, HEYGEN_API_KEY: '' }, async () => {}],
    [{ ...TEST_ENV, HEYGEN_API_KEY: '   ' }, async () => {}],
    [TEST_ENV, async () => { throw new Error('private DB detail'); }],
  ]) {
    let sweeps = 0;
    const handler = createAdminHandler({
      env, watchdogDbProbe: probe, opsWriter: async () => {},
      runWatchdogSweep: async () => { sweeps += 1; return {}; },
    });
    const res = response();
    await handler(request('watchdog-sweep', undefined, {
      method: 'GET', url: '/api/video-os-lite/watchdog-cron',
      headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
    }), res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { ok: false, code: 'watchdog_dependencies_unhealthy' });
    assert.equal(sweeps, 0);
  }
});

test('GitHub fallback POST fails when the sweep heartbeat cannot be persisted', async () => {
  const handler = createAdminHandler({
    env: TEST_ENV,
    opsWriter: async row => { if (row.event === 'watchdog_heartbeat') throw new Error('private DB detail'); },
    runWatchdogSweep: async () => ({ checked: 0 }),
  });
  const res = response();
  await handler(request('watchdog-sweep', {}, {
    headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
  }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, code: 'watchdog_heartbeat_unpersisted' });
});

test('overlapping watchdog deliveries do not certify a fresh heartbeat', async () => {
  const rows = [];
  const handler = createAdminHandler({
    env: TEST_ENV, watchdogDbProbe: async () => {}, opsWriter: async row => rows.push(row),
    runWatchdogSweep: async () => ({ claimConflicts: 1 }),
  });
  for (const [method, url, body] of [
    ['GET', '/api/video-os-lite/watchdog-cron', undefined],
    ['POST', '/api/video-os-lite/admin?operation=watchdog-sweep', {}],
  ]) {
    const res = response();
    await handler(request('watchdog-sweep', body, {
      method, url, headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
    }), res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { ok: false, code: 'watchdog_overlap_detected' });
  }
  assert.equal(rows.some(row => row.event === 'watchdog_heartbeat'), false);
});

test('failed anonymous alert flood is deduped and responses never wait for Slack', async () => {
  const env = { ...TEST_ENV, WATCHDOG_SLACK_WEBHOOK_URL: 'https://hooks.slack.invalid/fixture' };
  let calls = 0;
  const handler = createAdminHandler({ env, opsWriter: async () => {},
    fetchImpl: () => { calls += 1; return new Promise(() => {}); } });
  for (let i = 0; i < 50; i++) {
    const res = response();
    await Promise.race([
      handler(request('grant-credit', {}), res),
      new Promise((_, reject) => setTimeout(() => reject(new Error('response waited for Slack')), 250)),
    ]);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(calls, 1);
});

test('request waitUntil receives the Slack promise without delaying the response', async () => {
  const symbol = Symbol.for('@vercel/request-context');
  const previous = globalThis[symbol];
  let registered;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  globalThis[symbol] = { get: () => ({ waitUntil(promise) { registered = promise; } }) };
  try {
    const res = response();
    await createAdminHandler({
      env: { ...TEST_ENV, WATCHDOG_SLACK_WEBHOOK_URL: 'https://hooks.slack.invalid/fixture' },
      opsWriter: async () => {},
      grantAdminCredit: async () => ({ duplicate: false }),
      fetchImpl: () => pending,
    })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'wait-until' }, {
      headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
    assert.ok(registered instanceof Promise);
  } finally {
    release({ ok: true });
    if (previous === undefined) delete globalThis[symbol];
    else globalThis[symbol] = previous;
  }
});

test('missing Slack URL never calls fetch', async () => {
  let calls = 0;
  const res = response();
  await createAdminHandler({ env: TEST_ENV, opsWriter: async () => {},
    fetchImpl: () => { calls += 1; throw new Error('unexpected fetch'); } })(request('grant-credit', {}), res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test('optional Slack write alert has a four-field text payload and never changes the response', async () => {
  const env = {
    ...TEST_ENV,
    WATCHDOG_SLACK_WEBHOOK_URL: 'https://hooks.slack.invalid/services/private-webhook-sentinel',
  };
  const requests = [];
  const res = response();
  await createAdminHandler({
    env,
    opsWriter: async () => {},
    grantAdminCredit: async () => ({ duplicate: false }),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
  })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }, { headers: {
    authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}`,
    'x-forwarded-for': '198.51.100.77',
    'user-agent': 'private-user-agent-sentinel',
  } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 1);
  const slackBody = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(slackBody), ['text']);
  const slackText = JSON.parse(slackBody.text);
  assert.deepEqual(slackText, {
    operation: 'grant-credit', status: 200, actorType: 'admin_token', deploymentId: TEST_ENV.VERCEL_DEPLOYMENT_ID,
  });
  const serialized = JSON.stringify(slackBody);
  for (const sentinel of [TEST_ENV.VIDEO_OS_ADMIN_TOKEN, '198.51.100.77', 'private-user-agent-sentinel']) {
    assert.equal(serialized.includes(sentinel), false);
  }
  assert.ok(requests[0].options.signal instanceof AbortSignal);

  const failedAlert = response();
  await createAdminHandler({
    env,
    opsWriter: async () => {},
    grantAdminCredit: async () => ({ duplicate: false }),
    fetchImpl: async () => { throw new Error('Slack unavailable with private detail'); },
  })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'twice' }, {
    headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` },
  }), failedAlert);
  assert.equal(failedAlert.statusCode, 200);

  let forbiddenAlertCalls = 0;
  const noAlertHandler = createAdminHandler({
    env,
    opsWriter: async () => {},
    runWatchdogSweep: async () => ({ checked: 0 }),
    fetchImpl: async () => { forbiddenAlertCalls += 1; return { ok: true }; },
  });
  const cron = response();
  await noAlertHandler(request('watchdog-sweep', {}, {
    headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
  }), cron);
  assert.equal(cron.statusCode, 200);
  const read = response();
  await noAlertHandler(request('job-events', undefined, {
    method: 'GET', headers: { authorization: `Bearer ${TEST_ENV.VIDEO_OS_ADMIN_TOKEN}` },
  }), read);
  assert.equal(read.statusCode, 400);
  assert.equal(forbiddenAlertCalls, 0);
});

test('admin login requests are awaited-audited, including cron rejection', async () => {
  const previous = Object.fromEntries(['VIDEO_OS_ADMIN_USERNAME', 'VIDEO_OS_ADMIN_PASSWORD', 'VIDEO_OS_SESSION_SECRET'].map(key => [key, process.env[key]]));
  process.env.VIDEO_OS_ADMIN_USERNAME = 'audit-owner';
  process.env.VIDEO_OS_ADMIN_PASSWORD = 'audit-password';
  process.env.VIDEO_OS_SESSION_SECRET = 'admin-login-audit-session-secret-with-adequate-length';
  const rows = [];
  try {
    const ok = response();
    let releaseAudit;
    let auditEntered;
    const entered = new Promise(resolve => { auditEntered = resolve; });
    const running = handleAuthRequest(request('admin-login', { username: 'audit-owner', password: 'audit-password' }, {
      url: '/api/video-os-lite/admin-login',
    }), ok, { env: TEST_ENV, opsWriter: row => {
      rows.push(row);
      auditEntered();
      return new Promise(resolve => { releaseAudit = resolve; });
    } });
    await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('admin-login audit did not start')), 1000))]);
    assert.equal(ok.ended, undefined);
    releaseAudit();
    await running;
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers['Set-Cookie']), /^vos_admin=/);

    const rejected = response();
    const originalError = console.error;
    console.error = () => {};
    try {
      await handleAuthRequest(request('admin-login', { username: 'audit-owner', password: 'wrong-password' }, {
        url: '/api/video-os-lite/admin-login',
      }), rejected, { env: TEST_ENV, opsWriter: async row => rows.push(row) });
    } finally { console.error = originalError; }
    assert.equal(rejected.statusCode, 401);

    const cron = response();
    await handleAuthRequest(request('admin-login', {}, {
      url: '/api/video-os-lite/admin-login', headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` },
    }), cron, { env: TEST_ENV, opsWriter: async row => rows.push(row) });
    assert.equal(cron.statusCode, 403);
    assert.deepEqual(cron.body, { ok: false, code: 'cron_scope_forbidden' });

    for (const authorization of [TEST_ENV.CRON_SECRET, `Basic ${TEST_ENV.CRON_SECRET}`]) {
      const invalidScheme = response();
      const originalError = console.error;
      console.error = () => {};
      try {
        await handleAuthRequest(request('admin-login', { username: 'audit-owner', password: 'wrong-password' }, {
          url: '/api/video-os-lite/admin-login', headers: { authorization },
        }), invalidScheme, { env: TEST_ENV, opsWriter: async row => rows.push(row) });
      } finally { console.error = originalError; }
      assert.equal(invalidScheme.statusCode, 401);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(rows.map(row => [row.event, row.httpStatus, row.details.operation, row.details.actorType]), [
    ['admin.request.completed', 200, 'admin-login', 'none'],
    ['admin.request.completed', 401, 'admin-login', 'none'],
    ['admin.request.completed', 403, 'admin-login', 'cron_secret'],
    ['admin.request.completed', 401, 'admin-login', 'none'],
    ['admin.request.completed', 401, 'admin-login', 'none'],
  ]);
});
