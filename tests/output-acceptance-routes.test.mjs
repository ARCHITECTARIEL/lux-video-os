import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('real history/finalize/download handlers agree on persisted acceptance and ownership', () => {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/output-acceptance-routes.mjs'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
