import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('quarantined enrollment-derived assets are never served by the customer asset route', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/enrollment-asset-revocation-scenario.mjs'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
