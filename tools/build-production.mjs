import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { videoRenderWorkflowMetadata } from '../workflows/video-render-metadata.js';

const root = new URL('../', import.meta.url);
const output = new URL('../.vercel/output/', import.meta.url);
const vercelCli = new URL('../node_modules/vercel/dist/index.js', import.meta.url);
const workflowCli = new URL('../node_modules/workflow/bin/run.js', import.meta.url);

function run(cli, args, env = process.env) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: fileURLToPath(root), stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function stageWorkflowFfmpeg(stepFunction) {
  const configUrl = new URL('.vc-config.json', stepFunction);
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const arch = config.architecture === 'arm64' ? 'arm64' : 'x64';
  const cacheDirectory = new URL('../cache/', output);
  const cached = new URL(`ffmpeg-linux-${arch}`, cacheDirectory);
  await mkdir(cacheDirectory, { recursive: true });
  if (!existsSync(cached)) {
    const installer = new URL('../node_modules/ffmpeg-static/install.js', import.meta.url);
    run(installer, [], { ...process.env, CI: '1', FFMPEG_BIN: fileURLToPath(cached), npm_config_platform: 'linux', npm_config_arch: arch });
  }
  const header = await readFile(cached);
  const expectedMachine = arch === 'arm64' ? 0xb7 : 0x3e;
  if (header.length < 20 || header.subarray(0, 4).toString('hex') !== '7f454c46' || header.readUInt16LE(18) !== expectedMachine) throw new Error(`Staged FFmpeg is not a Linux ${arch} ELF binary.`);
  const target = new URL('ffmpeg', stepFunction);
  await copyFile(cached, target);
  await chmod(target, 0o755);
}

const target = process.argv.includes('--preview') ? 'preview' : 'production';

// The original incident this gate exists for: a schema change merged to
// code, never applied to production, causing confusing render failures
// discovered only in live traffic. check-migrations.mjs --strict turns a
// detected drift into a hard build failure instead of a warning -- but that
// only has teeth if DATABASE_URL_UNPOOLED/DATABASE_URL are actually present
// when it runs, and this script's own process.env has neither by default
// (this migration check runs BEFORE `vercel build` below, and even
// afterwards `vercel build` only injects resolved env vars into ITS OWN
// build subprocess, never back into this parent process). Best-effort pull
// the real production values first so a real, authenticated deploy gets a
// real check instead of a silent skip. In CI (no Vercel auth token) this
// pull simply fails and is ignored, preserving today's exact skip behavior
// -- never blocks CI, only strengthens a real deploy.
if (target === 'production' && !process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
  const pullFile = new URL('../.env.production-migration-check.local', import.meta.url);
  try {
    const pullResult = spawnSync(
      process.execPath,
      [fileURLToPath(vercelCli), 'env', 'pull', '--environment=production', '--yes', fileURLToPath(pullFile)],
      { cwd: fileURLToPath(root), stdio: 'pipe', env: process.env, timeout: 15_000 },
    );
    if (pullResult.status === 0 && existsSync(pullFile)) {
      const pulled = await readFile(pullFile, 'utf8');
      for (const line of pulled.split('\n')) {
        const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
        if (match && match[1] && !process.env[match[1]]) process.env[match[1]] = match[2];
      }
    }
  } catch {
    // Best-effort only -- fall through to check-migrations.mjs's existing
    // "no DATABASE_URL, skip the live check" behavior.
  } finally {
    await rm(pullFile, { force: true });
  }
  if (!process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
    // Made visible rather than silent: check-migrations.mjs itself just
    // quietly skips the live check with no DATABASE_URL, which is exactly
    // how the original incident went unnoticed. This doesn't fail the
    // build (CI legitimately has no production DB access), but a human
    // running a real deploy should see plainly that drift was NOT verified.
    console.warn('\x1b[33m[build-production] Could not resolve a real production DATABASE_URL (pull failed or returned nothing) -- the live-database migration-drift check below will be SKIPPED, not passed. If this is a real production deploy, run `vercel env pull --environment=production` yourself first.\x1b[0m');
  }
}

const migrationCheck = new URL('check-migrations.mjs', import.meta.url);
run(migrationCheck, target === 'production' ? ['--strict'] : []);

await rm(output, { recursive: true, force: true });
run(vercelCli, ['build', '--target', target]);
const configUrl = new URL('config.json', output);
const appConfig = JSON.parse(await readFile(configUrl, 'utf8'));
run(workflowCli, ['build', '--target', 'vercel-build-output-api']);
const workflowConfig = JSON.parse(await readFile(configUrl, 'utf8'));
const routes = [...(workflowConfig.routes || []), ...(appConfig.routes || [])].filter((route, index, all) => index === all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(route)));
await writeFile(configUrl, `${JSON.stringify({ ...appConfig, ...workflowConfig, routes }, null, 2)}\n`, 'utf8');

const workflowManifest = new URL('diagnostics/workflows-manifest.json', output);
const renderFunction = new URL('functions/api/video-os-lite/render-v2.func/', output);
const workflowFlowFunction = new URL('functions/.well-known/workflow/v1/flow.func/', output);
const workflowStepFunction = new URL('functions/.well-known/workflow/v1/step.func/', output);
if (!existsSync(workflowManifest) || !existsSync(renderFunction) || !existsSync(workflowFlowFunction) || !existsSync(workflowStepFunction)) {
  throw new Error(`${target} build is incomplete: render function, workflow handlers, or workflow manifest is missing.`);
}
await stageWorkflowFfmpeg(workflowStepFunction);

const manifest = JSON.parse(await readFile(workflowManifest, 'utf8'));
const registeredWorkflowId = manifest.workflows?.['workflows/video-render.js']?.videoRenderWorkflow?.workflowId;
if (registeredWorkflowId !== videoRenderWorkflowMetadata.workflowId) {
  throw new Error(`Workflow metadata drift: caller uses ${videoRenderWorkflowMetadata.workflowId} but the build registered ${registeredWorkflowId || 'nothing'}.`);
}

console.log(`${target} build complete: ${routes.length} routes, application functions, workflow handlers, and manifest-backed caller metadata verified.`);
