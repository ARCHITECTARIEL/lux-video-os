import { createHash } from 'node:crypto';
import { readFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSourceIdentity } from './release-build-manifest.mjs';
import { fingerprint, outputInventory } from './authorize-release.mjs';
import { PREVIEW_DEPLOY_COMMAND, previewUploadLimitWarning } from './preview-upload-limit.mjs';
import {
  identityEnrollmentCleanupWorkflowMetadata,
  identityEnrollmentExpiryWorkflowMetadata,
  identityEnrollmentExtractionWorkflowMetadata,
  identityEnrollmentHashWorkflowMetadata,
} from '../workflows/identity-enrollment-metadata.js';

// Preview-only restore of a quarantined `npm run build:preview` artifact.
// This tool does not open a database connection, does not read provider
// credentials, and does not run `vercel`. Production authorization stays in
// authorize-release.mjs and is unchanged.
const ENROLLMENT_WORKFLOW_FILE = 'workflows/identity-enrollment.js';
const ENROLLMENT_ROUTE_NAMES = Object.freeze(['enrollments', 'enrollment-upload', 'scripted-photo']);
const WORKFLOW_FUNCTIONS = Object.freeze([
  'functions/.well-known/workflow/v1/flow.func',
  'functions/.well-known/workflow/v1/step.func',
]);
const ENROLLMENT_WORKFLOWS = Object.freeze({
  identityEnrollmentHashWorkflow: identityEnrollmentHashWorkflowMetadata,
  identityEnrollmentExtractionWorkflow: identityEnrollmentExtractionWorkflowMetadata,
  identityEnrollmentCleanupWorkflow: identityEnrollmentCleanupWorkflowMetadata,
  identityEnrollmentExpiryWorkflow: identityEnrollmentExpiryWorkflowMetadata,
});

export function requestedTarget(argv = []) {
  const attached = argv.find(arg => typeof arg === 'string' && arg.startsWith('--target='));
  if (attached) return attached.slice('--target='.length);
  const index = argv.indexOf('--target');
  return index >= 0 ? argv[index + 1] : undefined;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function assertQuarantinedUnderVercel(root, location) {
  const vercelDir = resolve(root, '.vercel');
  const resolved = resolve(location);
  const rel = relative(vercelDir, resolved);
  if (rel === '' || rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Quarantined preview output must stay inside ${vercelDir}. Refusing to restore.`);
  }
}

function enrollmentWorkflowsRegistered(manifest) {
  const registered = manifest?.workflows?.[ENROLLMENT_WORKFLOW_FILE];
  return Object.entries(ENROLLMENT_WORKFLOWS).every(([name, metadata]) => registered?.[name]?.workflowId === metadata.workflowId);
}

async function functionReady(outputRoot, relativeDir) {
  try {
    const directory = join(outputRoot, relativeDir);
    const info = await stat(directory);
    if (!info.isDirectory()) return false;
    const config = await stat(join(directory, '.vc-config.json'));
    const entry = await stat(join(directory, 'index.js'));
    return config.isFile() && entry.isFile() && entry.size > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// The workflow Build Output builder emits flow.func and step.func as queue
// functions. It does not add HTTP routes for those two paths (only the
// webhook route). Enrollment workflows are reached through the workspace
// routes below, which build:preview already requires before it quarantines.
export async function assertPreviewWorkflowArtifact(outputRoot) {
  const missing = [];
  for (const relativeDir of WORKFLOW_FUNCTIONS) {
    if (!await functionReady(outputRoot, relativeDir)) missing.push(`${relativeDir} (.vc-config.json and index.js)`);
  }
  let routes = null;
  try {
    const config = JSON.parse(await readFile(join(outputRoot, 'config.json'), 'utf8'));
    if (Array.isArray(config?.routes)) routes = config.routes;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (!routes) missing.push('config.json routes');
  else {
    for (const name of ENROLLMENT_ROUTE_NAMES) {
      const present = routes.some(route => route?.src === `^/api/video-os-lite/${name}$` && route?.dest === '/api/video-os-lite/workspace.js');
      if (!present) missing.push(`enrollment route /api/video-os-lite/${name}`);
    }
  }
  let workflowManifest = null;
  const manifestPath = join(outputRoot, 'diagnostics/workflows-manifest.json');
  try {
    workflowManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  if (!enrollmentWorkflowsRegistered(workflowManifest)) {
    missing.push(`enrollment workflow ids in diagnostics/workflows-manifest.json (${Object.keys(ENROLLMENT_WORKFLOWS).join(', ')})`);
  }
  if (missing.length) {
    throw new Error(`Preview artifact is missing workflow functions or enrollment routes. Refusing to restore.\nMissing:\n- ${missing.join('\n- ')}\nA plain git deploy or CLI redeploy of this project builds only api/** and does not create .well-known/workflow/v1 flow.func and step.func, so enrollment workflows do not run.`);
  }
}

function assertPreviewSource(manifest, currentSource) {
  const recorded = manifest.source;
  if (!recorded
    || recorded.head !== currentSource?.head
    || recorded.sha256 !== currentSource?.sha256
    || recorded.projectLinkSha256 !== currentSource?.projectLinkSha256) {
    throw new Error('Preview artifact source identity does not match this checkout. Refusing to restore. Run npm run build:preview again in this same tree.');
  }
}

export async function authorizePreview({ argv = process.argv, root = fileURLToPath(new URL('../', import.meta.url)), deps = {} } = {}) {
  const {
    captureSource = captureSourceIdentity,
    inventory = outputInventory,
    fingerprintRecords = fingerprint,
    restoreOutput = rename,
    log = message => console.log(message),
    logError = message => console.error(message),
  } = deps;
  if (requestedTarget(argv) !== 'preview') {
    throw new Error('Preview restore accepts only --target=preview. Refusing a production target.');
  }
  if (argv.includes('--prod') || argv.includes('--production')) {
    throw new Error('Preview restore refuses a production deploy flag.');
  }

  const manifestPath = argument(argv, '--manifest') || join(root, '.vercel/release-build-manifest.json');
  let manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Preview release manifest is missing at ${manifestPath}. Run npm run build:preview first.`);
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Preview release manifest is not valid JSON. Refusing to restore.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Preview release manifest is not valid JSON. Refusing to restore.');
  }
  if (manifest.target !== 'preview') {
    throw new Error('Refusing a production artifact. Preview restore accepts only a quarantined npm run build:preview manifest.');
  }
  if (manifest.releaseAuthorized === true) {
    throw new Error('Preview restore refuses a manifest that claims release authorization.');
  }
  if (!manifest.output?.location || typeof manifest.output.sha256 !== 'string' || manifest.output.sha256.length === 0) {
    throw new Error('Preview manifest has no quarantined output location or hash. Run npm run build:preview first.');
  }

  const location = manifest.output.location;
  assertQuarantinedUnderVercel(root, location);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(`${location}.packaging-success.json`, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      throw new Error('Preview packaging receipt is missing or tampered. Refusing to restore.');
    }
    throw error;
  }
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  if (receipt.packagingComplete !== true || receipt.releaseAuthorized !== false || receipt.manifestSha256 !== manifestSha256 || receipt.outputSha256 !== manifest.output.sha256) {
    throw new Error('Preview release manifest does not match its packaging receipt. Refusing a tampered manifest.');
  }
  let sibling;
  try {
    sibling = await readFile(`${location}.release-build-manifest.json`);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Quarantined preview manifest copy is missing. Refusing a tampered manifest.');
    throw error;
  }
  if (!sibling.equals(manifestBytes)) {
    throw new Error('Preview release manifest does not match the quarantined copy. Refusing a tampered manifest.');
  }

  await stat(location).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Quarantined preview output is missing at ${location}.`);
    throw error;
  });
  const liveInventory = await inventory(location);
  const liveOutputSha256 = fingerprintRecords(liveInventory);
  if (liveOutputSha256 !== manifest.output.sha256) {
    throw new Error('Quarantined preview output does not match the release manifest hash. Refusing a tampered manifest.');
  }

  assertPreviewSource(manifest, await captureSource(root));
  await assertPreviewWorkflowArtifact(location);

  const warning = previewUploadLimitWarning(liveInventory.length);
  const destination = join(root, '.vercel', 'output');
  await mkdir(join(root, '.vercel'), { recursive: true });
  try {
    await stat(destination);
    throw new Error(`Refusing to replace existing output at ${destination}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await restoreOutput(location, destination);

  const result = {
    version: 1,
    target: 'preview',
    previewDeployAuthorized: true,
    routineDeployAuthorized: false,
    releaseAuthorized: false,
    outputSha256: liveOutputSha256,
    fileCount: liveInventory.length,
    uploadLimitWarning: warning,
    restoredTo: destination,
    deployCommand: PREVIEW_DEPLOY_COMMAND,
    note: 'previewDeployAuthorized restores this quarantined preview artifact for a non-production deploy. It is not production authorization. This tool does not deploy.',
  };
  log(JSON.stringify(result, null, 2));
  logError(`Quarantined preview output restored to ${destination}.`);
  logError(`Run: ${PREVIEW_DEPLOY_COMMAND}`);
  if (warning) logError(warning);
  return result;
}

export async function main(options) {
  return authorizePreview(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
