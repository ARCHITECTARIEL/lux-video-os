import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeGlobalCounter } from '../db/repositories.js';
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
