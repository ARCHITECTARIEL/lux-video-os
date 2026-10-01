import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('provider claim rejects identity resources from another binding, origin, or verified scope', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    'tests/helpers/provider-binding-scope-scenario.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      DATABASE_URL: '',
      DATABASE_URL_UNPOOLED: '',
      HEYGEN_API_KEY: '',
      HEYGEN_TOKEN: '',
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
