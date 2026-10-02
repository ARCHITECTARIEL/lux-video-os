import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { heygenRuntimeFiles, stageHeygenRuntimeFiles } from '../tools/stage-heygen-runtime-files.mjs';
import { migrationPlan, schemaSourceHashes } from '../tools/check-migrations.mjs';
import { nodeFileTrace } from '@vercel/nft';
import { build } from 'esbuild';

test('packaged Workflow verification assets resolve inside the function and preserve exact migration evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lux-runtime-package-'));
  try {
    const files = await stageHeygenRuntimeFiles(process.cwd(), directory, { bundled: true });
    const root = join(directory, 'runtime-repository');
    assert.deepEqual(await migrationPlan(join(root, 'drizzle')), await migrationPlan());
    const schemaLock = JSON.parse(await readFile(join(root, 'config/database-schema.lock.json'), 'utf8'));
    assert.deepEqual(schemaLock.sourceHashes, await schemaSourceHashes());
    assert.deepEqual(files, await heygenRuntimeFiles(process.cwd()));
    assert.ok(files.every(file => !file.startsWith('docs/') && !file.includes('.env') && !file.includes('private')));
    for (const file of files) assert.deepEqual(await readFile(join(root, file)), await readFile(join(process.cwd(), file)));
    // Restaging must be idempotent and must reject, rather than overwrite, drift.
    await stageHeygenRuntimeFiles(process.cwd(), directory, { bundled: true });
    await writeFile(join(root, 'config/heygen-space-anchor.json'), '{}');
    await assert.rejects(stageHeygenRuntimeFiles(process.cwd(), directory, { bundled: true }), /mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual bundled Node entrypoint loads the pinned anchor from function-local staged files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lux-runtime-bundle-'));
  try {
    await stageHeygenRuntimeFiles(process.cwd(), directory, { bundled: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await build({
      stdin: { contents: "export { loadPinnedHeygenSpaceAnchorProjection } from './lib/heygen-space-anchor.js';", resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'esm', outfile: join(directory, 'index.js'), logLevel: 'silent',
    });
    const runtime = await import(pathToFileURL(join(directory, 'index.js')).href);
    const anchor = await runtime.loadPinnedHeygenSpaceAnchorProjection({ now: new Date('2026-10-01T16:00:00.000Z') });
    assert.equal(anchor.providerSpaceFingerprint, '1c1b9eac97b6e38e481d30ddf12e4332ecb04d08f727a4ff55997a733b3f584a');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual Vercel file tracing excludes build recursion, secret files and private evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lux-runtime-trace-'));
  const blocked = ['.vercel/output/probe.json', '.vercel/review-output-fixture/functions/.well-known/workflow/.hidden/step.func/private.json', '.aws/region/.nested/.hidden/secret.json', '.git/objects/.nested/object', '.git/probe.json', '.env', '.env.heygen.local', '.omx/probe.json', '.aws/probe.json', 'docs/private-proof.json', 'tests/fixture.json', 'archive/old.json', 'data/private.json'];
  const allowed = 'public/required-logo.svg';
  try {
    const paths = [...blocked, allowed];
    for (const name of paths) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), '{}');
    }
    await mkdir(join(directory, 'api'));
    await writeFile(join(directory, 'api/entry.js'), "import {readFileSync} from 'node:fs';\n" + paths.map(name => `readFileSync(new URL('../${name}', import.meta.url));`).join('\n'));
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.ok(config.functions['api/**/*.js'].excludeFiles.length <= 256, 'Vercel excludes must fit the config schema limit.');
    const trace = await nodeFileTrace([join(directory, 'api/entry.js')], { base: directory, processCwd: directory, ignore: config.functions['api/**/*.js'].excludeFiles });
    const traced = new Set([...trace.fileList].map(name => name.replaceAll('\\', '/')));
    assert.equal(traced.has('api/entry.js'), true);
    assert.equal(traced.has(allowed), true, 'Required public assets remain traceable.');
    for (const name of blocked) assert.equal(traced.has(name), false, `Must not package ${name}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real binding dependency graph traces required metadata without build output or private files', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const trace = await nodeFileTrace([resolve('db/heygen-space-binding-repository.js')], {
    base: process.cwd(), processCwd: process.cwd(), ignore: config.functions['api/**/*.js'].excludeFiles,
  });
  const traced = new Set([...trace.fileList].map(name => name.replaceAll('\\', '/')));
  for (const name of traced) {
    assert.doesNotMatch(name, /^(?:\.vercel|\.git|\.omx|\.codex|\.agents|\.aws|docs|tests|archive|data)(?:\/|$)/);
    assert.doesNotMatch(name, /^\.env(?:\.|$)/);
  }
  for (const name of await heygenRuntimeFiles(process.cwd())) assert.equal(traced.has(name), true, `Missing required runtime file: ${name}`);
});
