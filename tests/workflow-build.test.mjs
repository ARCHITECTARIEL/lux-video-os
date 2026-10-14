import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'node_modules', 'workflow', 'bin', 'run.js');

test('production workflow build step bundles offline into an isolated output directory', { skip: !existsSync(cli) && 'workflow CLI is not installed' }, async () => {
  const parent = join(root, '.omx', 'workflow-build-tests');
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, 'build-'));
  try {
    await copyFile(join(root, 'package.json'), join(temp, 'package.json'));
    for (const name of ['workflows', 'db', 'lib', 'services', 'routes', 'public', 'api', 'config', 'node_modules']) {
      await symlink(join(root, name), join(temp, name), 'junction');
    }
    const result = spawnSync(process.execPath, [cli, 'build', '--target', 'vercel-build-output-api'], {
      cwd: temp,
      env: { ...process.env, WORKFLOW_OBSERVABILITY_CWD: temp },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(temp, '.vercel', 'output', 'diagnostics', 'workflows-manifest.json')));
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(parent) + sep));
    await rm(temp, { recursive: true, force: true });
  }
});
