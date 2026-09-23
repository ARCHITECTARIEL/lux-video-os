// Covers the 2026-09-23 production incident: the first real standard-
// narration consent request hung indefinitely with no error and no non-2xx
// response. Root cause -- db/client.js's cached WebSocket pool had no
// query-level timeout and no eviction on a detected connection error, so a
// single silently-stale connection could hang every subsequent query on it
// forever. These tests are pure configuration/state checks against a
// syntactically-valid but unreachable connection string -- @neondatabase/
// serverless's Pool is lazy (construction never opens a socket), so none of
// this touches a real database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPoolForTests, database, resetDatabaseForTests } from '../db/client.js';

const TEST_DATABASE_URL = 'postgres://user:pass@127.0.0.1:59999/lux_test_unreachable';
const originalDatabaseUrl = process.env.DATABASE_URL;

test.beforeEach(() => {
  resetDatabaseForTests();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
});

test.afterEach(() => {
  resetDatabaseForTests();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

test('database() configures a query-level timeout so a stalled connection cannot hang forever', () => {
  database();
  const pool = currentPoolForTests();
  assert.equal(pool.options.query_timeout, 10_000, 'query_timeout is enforced client-side even if the socket never responds');
  assert.equal(pool.options.statement_timeout, 10_000, 'statement_timeout is Postgres-enforced defense in depth');
});

test('a pool-level error evicts the cached pool so the next call rebuilds a fresh one', () => {
  database();
  const firstPool = currentPoolForTests();
  assert.ok(firstPool, 'a pool should be cached after the first call');

  firstPool.emit('error', new Error('simulated dead connection'));

  database();
  const secondPool = currentPoolForTests();
  assert.notEqual(secondPool, firstPool, 'a detected connection error must evict the cached pool, not let it be reused');
});

test('a healthy pool is reused across calls, not rebuilt every time', () => {
  database();
  const firstPool = currentPoolForTests();

  database();
  const secondPool = currentPoolForTests();

  assert.equal(secondPool, firstPool, 'database() should cache the pool across calls when nothing has failed');
});

test('an error on a pool that has already been evicted does not disturb the pool that replaced it', () => {
  database();
  const firstPool = currentPoolForTests();

  firstPool.emit('error', new Error('simulated dead connection'));
  database();
  const secondPool = currentPoolForTests();

  // A late/duplicate error event from the already-replaced pool must not
  // evict its replacement -- createPool()'s handler guards on identity.
  firstPool.emit('error', new Error('a second, late error from the stale pool'));
  assert.equal(currentPoolForTests(), secondPool, 'a stale pool\'s error event must not evict the pool that already replaced it');
});
