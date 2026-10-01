import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('actual stored media decode gates ready/debit; rejection releases and replay settles once', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/finalization-acceptance-scenario.mjs'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
