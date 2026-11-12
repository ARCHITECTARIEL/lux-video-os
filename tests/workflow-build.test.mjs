import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'node_modules', 'workflow', 'bin', 'run.js');
const CREATIVE_FINISH_GATEWAY_MARKER = /creative[-_]finish|creative[-_]base|CREATIVE_BASE/i;
const CREATIVE_FINISH_BUNDLE_MARKER = /creative-finish-(?:contract|quote|revision)|creative-base-capture|VIDEO_OS_CREATIVE_FINISH|video-os[\\/]+creative-base/i;
const TEXT_BUNDLE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.map', '.mjs']);

async function bundleTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await bundleTextFiles(pathname));
    else if (entry.isFile() && TEXT_BUNDLE_EXTENSIONS.has(extname(entry.name))) files.push(pathname);
  }
  return files;
}

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
    const output = join(temp, '.vercel', 'output');
    assert.ok(existsSync(join(output, 'diagnostics', 'workflows-manifest.json')));
    assert.doesNotMatch(await readFile(join(root, 'lib', 'video-os-private-blob.js'), 'utf8'),
      CREATIVE_FINISH_GATEWAY_MARKER, 'the shared runtime Blob gateway must remain Creative Finish free');
    const leaked = [];
    for (const pathname of await bundleTextFiles(output)) {
      if (CREATIVE_FINISH_BUNDLE_MARKER.test(await readFile(pathname, 'utf8'))) {
        leaked.push(relative(output, pathname));
      }
    }
    assert.deepEqual(leaked, [], 'the production Workflow bundle must not contain held Creative Finish code or markers');
  } finally {
    assert.ok(resolve(temp).startsWith(resolve(parent) + sep));
    await rm(temp, { recursive: true, force: true });
  }
});
