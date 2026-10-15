import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock, test } from 'node:test';

if (process.argv.includes('--release-fixture')) {
  const schema = await import('../db/schema.js');
  const job = { id: 'job-release-once', accountId: 'owner', status: 'workflow_started',
    costCredits: 90, correlationId: 'corr-release-once' };
  const account = { accountId: 'owner', reserved: 90 };
  const events = [];
  let accountUpdates = 0;
  const db = {
    transaction: async callback => callback(db),
    select() {
      let table;
      return {
        from(value) { table = value; return this; },
        where() { return this; }, for() { return this; }, limit() { return this; },
        then(resolve, reject) {
          const rows = table === schema.videoJobs ? [job]
            : table === schema.creditAccounts ? [account] : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
    },
    update(table) {
      return { set(value) {
        return { where() {
          if (table === schema.creditAccounts) {
            accountUpdates++;
            Object.assign(account, value);
          } else if (table === schema.videoJobs) Object.assign(job, value);
          return { returning: async () => [job] };
        } };
      } };
    },
    insert(table) { return { values(value) { if (table === schema.jobEvents) events.push(value); return Promise.resolve(); } }; },
  };
  mock.module('../db/client.js', { namedExports: { database: () => db } });
  const { markJobFailedAndRelease } = await import('../db/repositories.js');
  await markJobFailedAndRelease(job.id, 'PROVIDER_TIMEOUT', 'Timed out.');
  await markJobFailedAndRelease(job.id, 'PROVIDER_TIMEOUT', 'Timed out.');
  assert.equal(job.status, 'failed');
  assert.equal(account.reserved, 0);
  assert.equal(accountUpdates, 1, 'terminal replay must not release reserved credits twice');
  assert.equal(events.length, 1);
} else {
  test('markJobFailedAndRelease releases a job reservation exactly once', () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks',
      new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)), '--release-fixture'],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  });
}
