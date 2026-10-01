import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['hash', 'extract', 'failure', 'cleanup', 'cleanup-failure', 'expiry', 'expiry-terminal-failed', 'expiry-retryable-failed']) {
  test(`identity enrollment workflow: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/enrollment-workflow-scenario.mjs', scenario], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secret' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
