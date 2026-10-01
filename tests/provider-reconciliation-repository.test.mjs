import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['snapshot', 'rotation', 'binding-holds', 'legacy-membership', 'resource-recording']) {
  test(`provider reconciliation repository: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      'tests/helpers/provider-reconciliation-repository-scenario.mjs',
      scenario,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        BLOB_READ_WRITE_TOKEN: '',
        HEYGEN_API_KEY: '',
        HEYGEN_TOKEN: '',
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
