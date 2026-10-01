import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { videoRenderWorkflowMetadata } from '../workflows/video-render-metadata.js';
import { stageHeygenRuntimeFiles } from './stage-heygen-runtime-files.mjs';
import { identityEnrollmentHashWorkflowMetadata, identityEnrollmentExtractionWorkflowMetadata, identityEnrollmentCleanupWorkflowMetadata, identityEnrollmentExpiryWorkflowMetadata } from '../workflows/identity-enrollment-metadata.js';
import { writeReleaseBuildManifest, assertProductionWorkflowBoundary, captureSourceIdentity, assertStableDatabase, quarantineBuildOutput, assertNoDefaultBuildOutput } from './release-build-manifest.mjs';

const root = new URL('../', import.meta.url);
const output = new URL('../.vercel/output/', import.meta.url);
const vercelCli = new URL('../node_modules/vercel/dist/index.js', import.meta.url);
const workflowCli = new URL('../node_modules/workflow/bin/run.js', import.meta.url);

function run(cli, args, env = process.env) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: fileURLToPath(root), stdio: 'inherit', env });
  if (result.status !== 0) throw new Error('Build subprocess failed; inspect the preceding diagnostic.');
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
const preflightOnly = process.argv.includes('--preflight-only');
async function build() {
if (!preflightOnly) await quarantineBuildOutput(fileURLToPath(output), 'previous');
else await assertNoDefaultBuildOutput(fileURLToPath(output));

// Production preparation requires an independently reviewed target manifest and
// exact live migration/schema evidence. Never pull secrets or skip this gate.
const preflightReceipt = new URL('../.vercel/database-preflight.json', import.meta.url);
await mkdir(new URL('../.vercel/', import.meta.url), { recursive: true });
await rm(preflightReceipt, { force: true });
const migrationCheck = new URL('check-migrations.mjs', import.meta.url);
run(migrationCheck, target === 'production'
  ? ['--strict', '--environment', 'production', '--receipt', fileURLToPath(preflightReceipt)]
  : ['--snapshot-only']);
const databaseEvidence = target === 'production'
  ? JSON.parse(await readFile(preflightReceipt, 'utf8'))
  : { verified: false, scope: 'snapshots-only', environment: 'preview' };
if (preflightOnly) {
  console.log(JSON.stringify({ target, database: databaseEvidence, releaseAuthorized: false }));
  return;
}

run(new URL('build-browser-clients.mjs', import.meta.url), []);
const expectedSource = await captureSourceIdentity(fileURLToPath(root));
await rm(new URL('../.vercel/release-build-manifest.json', import.meta.url), { force: true });
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
const workspaceFunction = new URL('functions/api/video-os-lite/workspace.func/', output);
const workflowFlowFunction = new URL('functions/.well-known/workflow/v1/flow.func/', output);
const workflowStepFunction = new URL('functions/.well-known/workflow/v1/step.func/', output);
if (!existsSync(workflowManifest) || !existsSync(renderFunction) || !existsSync(workflowFlowFunction) || !existsSync(workflowStepFunction)
  || !existsSync(new URL('.vc-config.json', workspaceFunction))
  || !existsSync(new URL('api/video-os-lite/workspace.js', workspaceFunction))) {
  throw new Error(`${target} build is incomplete: render function, workflow handlers, or workflow manifest is missing.`);
}
await stageWorkflowFfmpeg(workflowStepFunction);
await stageHeygenRuntimeFiles(fileURLToPath(root), fileURLToPath(workflowStepFunction), { bundled: true });
await stageHeygenRuntimeFiles(fileURLToPath(root), fileURLToPath(workspaceFunction));

const manifest = JSON.parse(await readFile(workflowManifest, 'utf8'));
const registeredWorkflowId = manifest.workflows?.['workflows/video-render.js']?.videoRenderWorkflow?.workflowId;
if (registeredWorkflowId !== videoRenderWorkflowMetadata.workflowId) {
  throw new Error(`Workflow metadata drift: caller uses ${videoRenderWorkflowMetadata.workflowId} but the build registered ${registeredWorkflowId || 'nothing'}.`);
}

let rollbackBaseline = null;
try { rollbackBaseline = JSON.parse(await readFile(new URL('../config/release-baseline.json', import.meta.url), 'utf8')); }
catch { console.warn('Rollback baseline unavailable or malformed; release remains blocked.'); }
let finalDatabaseEvidence = databaseEvidence;
if (target === 'production') {
  run(migrationCheck, ['--strict', '--environment', 'production', '--receipt', fileURLToPath(preflightReceipt)]);
  finalDatabaseEvidence = JSON.parse(await readFile(preflightReceipt, 'utf8'));
  assertStableDatabase(databaseEvidence, finalDatabaseEvidence);
}
for (const [name, metadata] of Object.entries({ identityEnrollmentHashWorkflow: identityEnrollmentHashWorkflowMetadata, identityEnrollmentExtractionWorkflow: identityEnrollmentExtractionWorkflowMetadata, identityEnrollmentCleanupWorkflow: identityEnrollmentCleanupWorkflowMetadata, identityEnrollmentExpiryWorkflow: identityEnrollmentExpiryWorkflowMetadata })) {
  const registered = manifest.workflows?.['workflows/identity-enrollment.js']?.[name]?.workflowId;
  if (registered !== metadata.workflowId) throw new Error(`Enrollment workflow metadata drift: ${name} is not registered under its caller ID.`);
}
for (const name of ['enrollments', 'enrollment-upload', 'scripted-photo']) {
  if (!routes.some(route => route.src === `^/api/video-os-lite/${name}$` && route.dest === '/api/video-os-lite/workspace.js') || !existsSync(new URL('functions/api/video-os-lite/workspace.func/', output))) throw new Error(`Missing enrollment/script API route: ${name}.`);
}
const receiptPath = fileURLToPath(new URL('../.vercel/release-build-manifest.json', import.meta.url));
const releaseManifest = await writeReleaseBuildManifest({ root: fileURLToPath(root), outputRoot: fileURLToPath(output), target, database: finalDatabaseEvidence, receiptPath, rollbackBaseline, expectedSource });
if (target === 'production') assertProductionWorkflowBoundary(releaseManifest.workflowBoundary);
// Every artifact from this preparation command is review-only. A future authorized
// release must recheck all gates before making anything available to --prebuilt.
releaseManifest.output.location = await quarantineBuildOutput(fileURLToPath(output), 'review');
await writeFile(receiptPath, JSON.stringify(releaseManifest, null, 2) + '\n');
await writeFile(`${releaseManifest.output.location}.packaging-success.json`, JSON.stringify({ packagingComplete: true, releaseAuthorized: false, sourceSha256: releaseManifest.source.sha256, outputSha256: releaseManifest.output.sha256 }) + '\n');
console.log(`${target} packaging complete: ${routes.length} routes. Review-only manifest written; no deployment authorization or P0 approval is implied.`);
if (!releaseManifest.workflowBoundary.verified) console.warn('Known Sandbox workflow boundary remains unverified; this diagnostic build cannot clear release.');
}
try { await build(); }
catch (error) {
  if (!preflightOnly) await quarantineBuildOutput(fileURLToPath(output), 'rejected');
  console.error(error.message);
  process.exitCode = 1;
}
