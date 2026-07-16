import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { videoRenderWorkflowMetadata } from '../workflows/video-render-metadata.js';

const root = new URL('../', import.meta.url);
const output = new URL('../.vercel/output/', import.meta.url);
const vercelCli = new URL('../node_modules/vercel/dist/index.js', import.meta.url);
const workflowCli = new URL('../node_modules/workflow/bin/run.js', import.meta.url);

function run(cli, args) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: fileURLToPath(root), stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
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

const manifest = JSON.parse(await readFile(workflowManifest, 'utf8'));
const registeredWorkflowId = manifest.workflows?.['workflows/video-render.js']?.videoRenderWorkflow?.workflowId;
if (registeredWorkflowId !== videoRenderWorkflowMetadata.workflowId) {
  throw new Error(`Workflow metadata drift: caller uses ${videoRenderWorkflowMetadata.workflowId} but the build registered ${registeredWorkflowId || 'nothing'}.`);
}

console.log(`${target} build complete: ${routes.length} routes, application functions, workflow handlers, and manifest-backed caller metadata verified.`);
