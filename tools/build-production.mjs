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
