import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Standard local simulation resumes each persisted stage without replaying provider claims', () => {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', 'tests/helpers/simulation-resume-scenario.mjs'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, DATABASE_URL: '', BLOB_READ_WRITE_TOKEN: '' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
