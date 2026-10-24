import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { consumeGlobalCounter, globalCountersReady } from '../db/repositories.js';
import { globalCounters } from '../db/schema.js';

function fakeDatabase() {
  const rows = new Map();
  const calls = [];
  return {
    rows, calls,
    insert(table) {
      assert.equal(table, globalCounters);
      const call = { table };
      calls.push(call);
      return {
        values(values) {
          call.values = values;
          assert.deepEqual(Object.keys(values).sort(), ['count', 'expiresAt', 'key', 'windowStart']);
          return {
            onConflictDoUpdate(update) {
              call.update = update;
              assert.equal(update.target, globalCounters.key);
              return {
                async returning() {
                  call.returned = true;
                  const old = rows.get(values.key);
                  const live = old && old.expiresAt > values.windowStart;
                  const row = live
                    ? { ...old, count: old.count + 1 }
                    : { ...values };
                  rows.set(values.key, row);
                  return [row];
                },
              };
            },
          };
        },
      };
    },
  };
}

test('global counter consumes one unit per upsert, denies above limit, and resets expired windows', async () => {
  const executor = fakeDatabase();
  const args = { key: 'copywriter:global:daily:v1', limit: 2, windowMs: 86_400_000, executor };
  assert.equal(await consumeGlobalCounter(args), true);
  assert.equal(await consumeGlobalCounter(args), true);
  assert.equal(await consumeGlobalCounter(args), false);
  assert.equal(executor.rows.get(args.key).count, 3);
  assert.equal(executor.calls.length, 3);
  assert.ok(executor.calls.every(call => call.returned && call.update.set.count && call.update.set.windowStart && call.update.set.expiresAt));
  executor.rows.get(args.key).expiresAt = new Date(0);
  assert.equal(await consumeGlobalCounter(args), true);
  assert.equal(executor.rows.get(args.key).count, 1);
  assert.equal(executor.rows.get(args.key).windowStart.getTime() > 0, true);
});

test('global keys are independent and have no account field', async () => {
  const executor = fakeDatabase();
  assert.equal(await consumeGlobalCounter({ key: 'one', limit: 1, windowMs: 1000, executor }), true);
  assert.equal(await consumeGlobalCounter({ key: 'one', limit: 1, windowMs: 1000, executor }), false);
  assert.equal(await consumeGlobalCounter({ key: 'two', limit: 1, windowMs: 1000, executor }), true);
  assert.equal(executor.rows.size, 2);
});

test('global counter propagates executor failures', async () => {
  const failure = new Error('fake insert failure');
  const executor = { insert() { throw failure; } };
  await assert.rejects(consumeGlobalCounter({ key: 'one', limit: 1, windowMs: 1000, executor }), error => error === failure);
});

test('global counter upsert renews count, start, and expiry only after window expiration', async () => {
  const executor = fakeDatabase();
  await consumeGlobalCounter({ key: 'one', limit: 2, windowMs: 86_400_000, executor });
  const { values, update } = executor.calls[0];
  const dialect = new PgDialect();
  const render = expression => dialect.sqlToQuery(expression);
  const count = render(update.set.count);
  const start = render(update.set.windowStart);
  const expiry = render(update.set.expiresAt);
  assert.match(count.sql, /case when .*"expires_at" > now\(\) then .*"count" \+ 1 else 1 end/i);
  assert.match(start.sql, /case when .*"expires_at" > now\(\) then .*"window_start" else now\(\) end/i);
  assert.match(expiry.sql, /case when .*"expires_at" > now\(\) then .*"expires_at" else \$\d+::timestamptz end/i);
  assert.equal(expiry.params.length, 1);
  assert.equal(new Date(expiry.params[0]).getTime(), values.windowStart.getTime() + 86_400_000);
});

test('global counter rejects invalid limits and windows before using the executor', async () => {
  let touched = 0;
  const executor = { insert() { touched++; throw new Error('unexpected'); } };
  for (const value of [NaN, Infinity, 0, -1, null, undefined, '1', 1.5]) {
    await assert.rejects(consumeGlobalCounter({ key: 'one', limit: value, windowMs: 1000, executor }), RangeError);
  }
  for (const value of [NaN, Infinity, 0, -1, null, undefined, '1000']) {
    await assert.rejects(consumeGlobalCounter({ key: 'one', limit: 1, windowMs: value, executor }), RangeError);
  }
  assert.equal(touched, 0);
});

test('global counter readiness probe uses a read-only regclass check and fails closed', async () => {
  const statements = [];
  const executor = { async execute(query) { statements.push(new PgDialect().sqlToQuery(query)); return { rows: [{ ready: true }] }; } };
  assert.equal(await globalCountersReady(executor), true);
  assert.match(statements[0].sql, /select to_regclass\('public\.global_counters'\) is not null as ready/i);
  assert.equal(await globalCountersReady({ execute: async () => ({ rows: [{ ready: false }] }) }), false);
  assert.equal(await globalCountersReady({ execute: async () => { throw new Error('fake missing relation'); } }), false);
});
