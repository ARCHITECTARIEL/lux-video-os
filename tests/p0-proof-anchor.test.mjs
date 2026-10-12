import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

async function runReserveIntegrationScenario() {
  const schema = await import('../db/schema.js');
  const accountId = 'proof-anchor-account';
  const account = { accountId, balance: 500, reserved: 0 };
  const jobs = [];
  const events = [];
  let reservationUpdates = 0;
  let lastTransactionOptions;

  function rowsFor(table) {
    if (table === schema.entitlements) return [{
      accountId,
      entitlementKey: 'liveRendering',
      enabled: true,
      sourceType: 'admin_tester_grant',
    }];
    if (table === schema.users) return [{ id: accountId, email: 'proof-anchor@example.invalid' }];
    if (table === schema.creditAccounts) return [account];
    if (table === schema.videoJobs) return jobs;
    if (table === schema.jobEvents) return events;
    return [];
  }

  const db = {
    async transaction(callback, options) {
      lastTransactionOptions = options;
      return callback(db);
    },
    async execute() {
      return { rows: [] };
    },
    select() {
      let table;
      const query = {
        from(value) { table = value; return this; },
        where() { return this; },
        for() { return this; },
        limit() { return this; },
        then(resolve, reject) { return Promise.resolve(rowsFor(table).slice(0, 2)).then(resolve, reject); },
      };
      return query;
    },
    update(table) {
      return {
        set(value) {
          return {
            async where() {
              if (table === schema.creditAccounts) {
                reservationUpdates++;
                Object.assign(account, value);
              }
            },
          };
        },
      };
    },
    insert(table) {
      return {
        values(value) {
          if (table === schema.videoJobs) {
            jobs.push(value);
            return { returning: async () => [value] };
          }
          if (table === schema.jobEvents) events.push(value);
          return Promise.resolve();
        },
      };
    },
  };

  mock.module('../db/client.js', { namedExports: { database: () => db } });
  const repository = await import('../db/repositories.js');
  const request = {
    jobId: 'job-proof-anchor',
    accountId,
    idempotencyKey: 'proof-anchor-idempotency',
    correlationId: 'corr-proof-anchor',
    provider: 'heygen',
    title: 'P0 Proof Anchor',
    format: 'landscape',
    costCredits: 90,
    input: { projectId: randomUUID() },
  };

  const created = await repository.reserveRender(request);
  assert.equal(created.replayed, false);
  assert.match(created.proofId, /^[0-9a-f-]{36}$/i);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, created.proofId);
  assert.equal(events[0].eventType, 'render.reserved');
  assert.equal(events[0].jobId, request.jobId);
  assert.equal(events[0].correlationId, request.correlationId);
  assert.deepEqual(events[0].details, { costCredits: request.costCredits });
  assert.equal(reservationUpdates, 1);

  const replayed = await repository.reserveRender(request);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.proofId, created.proofId);
  assert.equal(events.length, 1, 'replay must not create another reservation event');
  assert.equal(reservationUpdates, 1, 'replay must not reserve credits again');

  const readback = await repository.getRenderReservationProof(replayed.job);
  assert.equal(readback, created.proofId);
  assert.deepEqual(lastTransactionOptions, { isolationLevel: 'repeatable read', accessMode: 'read only' });

  events.push({ ...events[0], id: randomUUID() });
  await assert.rejects(
    repository.reserveRender(request),
    { statusCode: 409, failureCategory: 'RECONCILIATION' },
  );
  assert.equal(reservationUpdates, 1);
}

if (process.argv[2] === 'reserve-integration') {
  await runReserveIntegrationScenario();
} else {
  test('reserveRender creates one stable proof anchor and refuses ambiguous replay', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      'tests/p0-proof-anchor.test.mjs',
      'reserve-integration',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        BLOB_READ_WRITE_TOKEN: '',
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('proof validation fails closed for missing, duplicate, or mismatched reservation events', async () => {
    const { exactRenderReservationProofId } = await import('../db/repositories.js');
    const expected = { jobId: 'job-proof-anchor', correlationId: 'corr-proof-anchor' };
    const row = {
      id: randomUUID(),
      jobId: expected.jobId,
      correlationId: expected.correlationId,
      eventType: 'render.reserved',
    };
    assert.equal(exactRenderReservationProofId([row], expected), row.id);
    for (const rows of [
      [],
      [row, { ...row, id: randomUUID() }],
      [{ ...row, correlationId: 'corr-other' }],
      [{ ...row, eventType: 'workflow.prepared' }],
      [{ ...row, id: 'not-a-uuid' }],
      [{ ...row, id: '11111111-1111-1111-8111-111111111111' }],
    ]) {
      assert.throws(
        () => exactRenderReservationProofId(rows, expected),
        { statusCode: 409, failureCategory: 'RECONCILIATION' },
      );
    }
  });

  test('render response binding exposes only the proof anchor and no approval claim', async () => {
    const { renderProofBinding, serverRenderCorrelationId } = await import('../api/video-os-lite/render-v2.js');
    const proofId = randomUUID();
    const binding = renderProofBinding(proofId);
    assert.deepEqual(binding, { proofId });
    assert.equal(Object.isFrozen(binding), true);
    assert.doesNotMatch(JSON.stringify(binding), /approved|verified|gate.?clear/i);
    assert.throws(
      () => renderProofBinding('missing-proof'),
      { statusCode: 409, failureCategory: 'RECONCILIATION' },
    );
    assert.throws(
      () => renderProofBinding('11111111-1111-1111-8111-111111111111'),
      { statusCode: 409, failureCategory: 'RECONCILIATION' },
    );
    const firstCorrelationId = serverRenderCorrelationId();
    const secondCorrelationId = serverRenderCorrelationId();
    assert.match(firstCorrelationId, /^corr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(firstCorrelationId, secondCorrelationId);
    assert.notEqual(firstCorrelationId, 'incoming-diagnostic-request');
  });
}
