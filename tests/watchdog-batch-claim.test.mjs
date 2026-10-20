import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

if (process.argv.includes('--batch-claim-fixture')) {
  let rows = new Map();
  let turn = Promise.resolve();
  const db = {
    async transaction(callback) {
      const previous = turn;
      let release;
      turn = new Promise(resolve => { release = resolve; });
      await previous;
      const pending = new Map(rows);
      const tx = { insert() { return { values(value) { return { onConflictDoUpdate() { return {
        returning: async () => {
          const old = pending.get(value.key);
          const count = old && old.expiresAt > new Date() ? old.count + 1 : 1;
          pending.set(value.key, { ...value, count });
          return [{ count }];
        },
      }; } }; } }; } };
      try {
        const result = await callback(tx);
        rows = pending;
        return result;
      } finally { release(); }
    },
  };
  mock.module('../db/client.js', { namedExports: { database: () => db } });
  const { claimWatchdogJobs } = await import('../db/repositories.js');
  const first = { id: 'synthetic-job-a', accountId: 'synthetic-account' };
  const second = { id: 'synthetic-job-b', accountId: 'synthetic-account' };
  const [winner, loser] = await Promise.all([
    claimWatchdogJobs([first, second]), claimWatchdogJobs([first, second]),
  ]);
  assert.deepEqual([winner, loser], [true, false]);
  assert.equal(rows.size, 2);
  assert.ok([...rows.values()].every(row => row.count === 1), 'losing transaction must roll back all increments');

  const third = { id: 'synthetic-job-c', accountId: 'synthetic-account' };
  assert.equal(await claimWatchdogJobs([first, third]), false);
  assert.equal(rows.size, 2, 'a partial batch must not claim an unowned job');
  for (const row of rows.values()) row.expiresAt = new Date(Date.now() - 1);
  assert.equal(await claimWatchdogJobs([first, second]), true, 'expired claims are reclaimable');
} else {
  test('watchdog batch claims are all-or-nothing and expire for retry', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)), '--batch-claim-fixture',
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
