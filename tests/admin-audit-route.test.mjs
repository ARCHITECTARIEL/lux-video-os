import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminHandler } from '../routes/video-os-lite/admin.js';

function request(operation, body) {
  return {
    method: 'POST', url: `/api/video-os-lite/admin?operation=${operation}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
}

function response() {
  return { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); this.ended = true; } };
}

test('admin mutations persist exact audit rows before sending the response', async () => {
  const cases = [
    ['grant-credit', { accountId: 'account-1', amount: 12, idempotencyKey: 'once' },
      { grantAdminCredit: async () => ({ duplicate: true, balance: 12 }) },
      { event: 'admin.credit.granted', accountId: 'account-1', code: 'CREDIT_GRANT_REPLAYED', details: { adminActor: 'admin', amount: 12, duplicate: true } }],
    ['quarantine-asset', { mediaAssetId: 'asset-1', reason: 'private@example.com' },
      { quarantineMediaAsset: async () => ({ id: 'asset-1', accountId: 'account-2' }) },
      { event: 'admin.asset.quarantined', accountId: 'account-2', code: null, details: { adminActor: 'admin' } }],
    ['register-tester', { email: 'private.person@example.com', name: 'Private Person' },
      { registerAdminTester: async () => ({ account: { id: 'account-3' } }) },
      { event: 'admin.tester.registered', accountId: 'account-3', code: null, details: { adminActor: 'admin', testerDomain: 'example.com' } }],
  ];
  const originalLog = console.log;
  const lines = [];
  console.log = line => lines.push(line);
  try {
    for (const [operation, body, mutation, expected] of cases) {
      const res = response();
      let releaseWriter;
      let writerEntered;
      const entered = new Promise(resolve => { writerEntered = resolve; });
      const rows = [];
      const running = createAdminHandler({
        isAdminRequest: () => true, ...mutation,
        opsWriter: row => { rows.push(row); writerEntered(); return new Promise(resolve => { releaseWriter = resolve; }); },
      })(request(operation, body), res);
      await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error(`${operation} did not persist an audit row`)), 1000))]);
      assert.equal(res.ended, undefined, `${operation} responded before audit persistence completed`);
      assert.equal(rows.length, 1, `${operation} must persist exactly one row`);
      assert.deepEqual(Object.fromEntries(['event', 'accountId', 'code', 'details'].map(key => [key, rows[0][key]])), expected);
      assert.equal(JSON.stringify(rows).includes('private.person@example.com'), false);
      releaseWriter();
      await running;
      assert.equal(res.statusCode, 200);
      assert.equal(res.ended, true);
    }
  } finally { console.log = originalLog; }
  assert.equal(JSON.stringify(lines).includes('private.person@example.com'), false);
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
      isAdminRequest: () => true,
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
    await createAdminHandler({ isAdminRequest: () => true })(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Expected a whole number between 1 and 100.');
    const failed = response();
    await createAdminHandler({
      isAdminRequest: () => true, grantAdminCredit: async () => { throw new Error('private DB detail'); },
    })(request('grant-credit', { accountId: 'account-1', amount: 1, idempotencyKey: 'once' }), failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.error, 'Admin request failed.');
  } finally { console.log = originalLog; }
});
