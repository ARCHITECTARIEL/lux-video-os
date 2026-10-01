import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['repository', 'workflow', 'route']) {
  test(`scripted-photo backend: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/scripted-photo-backend-scenario.mjs', scenario], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        BLOB_READ_WRITE_TOKEN: '',
        HEYGEN_API_KEY: '',
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
