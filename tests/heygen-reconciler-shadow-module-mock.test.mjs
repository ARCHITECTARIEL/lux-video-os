import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('shadow reconciler avoids default repository and binding imports', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks',
    'tests/helpers/heygen-reconciler-shadow-module-mock-scenario.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: '', HEYGEN_API_KEY: '' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
