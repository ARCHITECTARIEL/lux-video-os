import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['list', 'route', 'worker', 'worker-standard', 'signin', 'persistence', 'admin', 'claim']) {
  test(`authorization repair: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/authorization-repair-scenario.mjs', scenario], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '', VIDEO_OS_RENDER_ACCOUNT_ID: '' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
