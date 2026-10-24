import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('concurrent watchdog deliveries claim once and escalation store failures fall back safely', () => {
  const result = spawnSync(process.execPath, [
    '--experimental-test-module-mocks', 'tests/helpers/watchdog-claim-scenario.mjs',
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, DATABASE_URL: '' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
