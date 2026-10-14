import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  getOpsCodeSummary,
  listEntityTimeline,
  listOpsActivity,
  parseActivityQuery,
} from '../routes/video-os-lite/admin.js';

const dialect = new PgDialect();

function capturingDb(rows = []) {
  const calls = [];
  return {
    calls,
    async execute(statement) {
      calls.push(dialect.sqlToQuery(statement));
      return { rows };
    },
  };
}

test('activity query parsing bounds pagination and validates level and time range', () => {
  const parsed = parseActivityQuery(new URL('https://example.test/admin?accountId=acct-1&entityType=JOB&entityId=job-1&event=provider.failed&level=ERROR&code=UPSTREAM&limit=25&offset=50&from=2026-10-13T00:00:00Z&to=2026-10-14T00:00:00Z'));
  assert.equal(parsed.accountId, 'acct-1');
  assert.equal(parsed.entityType, 'job');
  assert.equal(parsed.entityId, 'job-1');
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.offset, 50);
  assert.equal(parsed.from.toISOString(), '2026-10-13T00:00:00.000Z');

  assert.throws(
    () => parseActivityQuery(new URL('https://example.test/admin?level=fatal')),
    /level must be info, warn, or error/,
  );
  assert.throws(
    () => parseActivityQuery(new URL('https://example.test/admin?limit=101')),
    /whole number between 1 and 100/,
  );
  assert.throws(
    () => parseActivityQuery(new URL('https://example.test/admin?from=2026-10-14&to=2026-10-13')),
    /from must be earlier than to/,
  );
  assert.throws(
    () => parseActivityQuery(new URL('https://example.test/admin'), { requireEntity: true }),
    /entityId is required/,
  );
});

test('activity list binds every filter and reports bounded pagination', async () => {
  const hostile = "acct' OR 1=1 --";
  const db = capturingDb([{ id: 'event-1', event: 'provider.failed', totalCount: 51 }]);
  const result = await listOpsActivity({
    accountId: hostile,
    entityType: 'job',
    entityId: 'job-1',
    event: 'provider.failed',
    level: 'error',
    code: 'UPSTREAM',
    from: new Date('2026-10-13T00:00:00Z'),
    to: new Date('2026-10-14T00:00:00Z'),
    limit: 50,
    offset: 0,
  }, db);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /from ops_events/i);
  assert.match(db.calls[0].sql, /order by "createdAt" desc, id desc/i);
  assert.ok(!db.calls[0].sql.includes(hostile), 'request values must never be interpolated into SQL text');
  assert.ok(db.calls[0].params.includes(hostile), 'request values must be carried as bound parameters');
  assert.deepEqual(result.events, [{ id: 'event-1', event: 'provider.failed' }]);
  assert.deepEqual(result.page, { limit: 50, offset: 0, total: 51, hasMore: true });
});

test('entity timeline combines ops, job, and provider lifecycle rows using safe associations in one read-only query', async () => {
  const hostile = "job' UNION SELECT secret --";
  const db = capturingDb([
    { source: 'provider', id: 'provider-event-1', event: 'provider.video.created', totalCount: 3, details: { operationKind: 'video_create', operationState: 'succeeded' } },
    { source: 'job', id: 'job-event-1', event: 'provider.submitted', totalCount: 2, message: 'person@example.com', details: { token: 'unsafe', note: 'postgres://user:pass@127.0.0.1/db' } },
    { source: 'ops', id: 'ops-event-1', event: 'provider.poll.failed', totalCount: 3 },
  ]);
  const result = await listEntityTimeline({ entityId: hostile, entityType: 'job', limit: 20, offset: 0 }, db);

  const query = db.calls[0];
  assert.match(query.sql, /from ops_events oe/i);
  assert.match(query.sql, /union all/i);
  assert.match(query.sql, /from job_events je/i);
  assert.match(query.sql, /inner join video_jobs vj/i);
  assert.match(query.sql, /from provider_lifecycle_events ple/i);
  assert.match(query.sql, /inner join provider_lifecycle_operations plo/i);
  assert.match(query.sql, /plo\.job_id::text/i);
  assert.match(query.sql, /plo\.identity_id::text/i);
  assert.match(query.sql, /plo\.enrollment_id::text/i);
  assert.doesNotMatch(query.sql, /private_evidence_ref/i);
  assert.doesNotMatch(query.sql, /ple\.details/i, 'provider lifecycle raw details must not be exposed');
  assert.ok(!query.sql.includes(hostile));
  assert.ok(query.params.filter((value) => value === hostile).length >= 2);
  assert.equal(result.events[0].source, 'provider');
  assert.equal(result.events[1].details.token, '[redacted]');
  assert.equal(result.events[1].details.note.includes('postgres://'), false);
  assert.equal(result.events[1].message.includes('person@example.com'), false);
  assert.equal(result.page.total, 3);
});

test('pagination keeps the true total when an offset is beyond the last event', async () => {
  const db = capturingDb([{ id: null, totalCount: 51 }]);
  const result = await listOpsActivity({
    accountId: '', entityType: '', entityId: '', event: '', level: '', code: '',
    from: null, to: null, limit: 50, offset: 100,
  }, db);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.page, { limit: 50, offset: 100, total: 51, hasMore: false });
});

test('24 hour error summary is fixed to error level and grouped by code', async () => {
  const db = capturingDb([{ code: 'UPSTREAM_TIMEOUT', count: 3, latestAt: new Date('2026-10-14T00:00:00Z') }]);
  const result = await getOpsCodeSummary(db);
  assert.equal(result[0].count, 3);
  assert.match(db.calls[0].sql, /level = 'error'/i);
  assert.match(db.calls[0].sql, /interval '24 hours'/i);
  assert.match(db.calls[0].sql, /group by coalesce\(code, 'UNCODED'\)/i);
});
