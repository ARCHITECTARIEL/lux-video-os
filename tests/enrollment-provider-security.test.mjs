import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const scenario of ['bytes', 'blocked', 'orphan', 'ambiguous', 'resume', 'binding-reserve-failure', 'binding-claim-failure', 'claim-proof-missing', 'replay-submitting-asset', 'replay-missing-voice']) {
  test(`enrollment provider security: ${scenario}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/enrollment-provider-security-scenario.mjs', scenario], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
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
