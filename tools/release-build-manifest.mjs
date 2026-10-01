import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

async function hashFile(path) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export const MVP_RELEASE_PROVIDER = 'heygen';
const HEYGEN_RELEASE_GATES = Object.freeze([
  'HEYGEN_ONLY_RUNTIME_SCOPE_UNVERIFIED',
  'HEYGEN_ACCOUNT_CAPABILITIES_UNVERIFIED',
  'HEYGEN_PRICING_UNVERIFIED',
  'HEYGEN_PRIVACY_RETENTION_UNVERIFIED',
  'HEYGEN_DELETION_RECONCILIATION_UNVERIFIED',
  'HEYGEN_LIVE_CANARY_UNVERIFIED',
]);

export function providerReleasePosture(selectedProvider = MVP_RELEASE_PROVIDER) {
  const provider = String(selectedProvider || '').trim().toLowerCase();
  if (provider === 'heygen') {
    return {
      selectedProvider: provider,
      runtimeClass: 'managed-api',
      workerImageIdentity: {
        applicable: false,
        verified: null,
        reason: 'The selected HeyGen managed API does not deploy a Video OS worker image.',
      },
      providerEvidence: {
        verified: false,
        reason: 'Packaging has no independent live HeyGen account, deletion/reconciliation, privacy, pricing, or canary verifier.',
        requiredGates: [...HEYGEN_RELEASE_GATES],
      },
      remainingReleaseGates: [...HEYGEN_RELEASE_GATES],
    };
  }
  if (['runpod', 'sadtalker', 'self-hosted'].includes(provider)) {
    return {
      selectedProvider: provider,
      runtimeClass: 'self-hosted-worker',
      workerImageIdentity: {
        applicable: true,
        verified: false,
        reason: 'Selected self-hosted provider image digest and model identity require independent evidence.',
      },
      providerEvidence: {
        verified: false,
        reason: 'Packaging has no independently verified worker image and model provenance receipt.',
        requiredGates: ['WORKER_IMAGE_IDENTITY_UNVERIFIED'],
      },
      remainingReleaseGates: ['WORKER_IMAGE_IDENTITY_UNVERIFIED'],
    };
  }
  return {
    selectedProvider: provider || null,
    runtimeClass: 'unsupported',
    workerImageIdentity: { applicable: null, verified: false, reason: 'Release provider is not recognized.' },
    providerEvidence: { verified: false, reason: 'Release provider selection is unsupported.', requiredGates: ['RELEASE_PROVIDER_UNSUPPORTED'] },
    remainingReleaseGates: ['RELEASE_PROVIDER_UNSUPPORTED'],
  };
}

export function workflowBoundary(manifest) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(manifest) || manifest.version !== '1.0.0' || !['classes', 'workflows', 'steps'].every(key => Object.hasOwn(manifest, key) && record(manifest[key])) || !Object.keys(manifest.workflows).length || !Object.keys(manifest.steps).length) {
    return { verified: false, code: 'WORKFLOW_MANIFEST_INCOMPLETE', sandboxClassModules: [] };
  }
  const modules = [];
  const inspect = value => {
    if (typeof value === 'string' && value.replaceAll('\\', '/').includes('@vercel/sandbox')) modules.push(value);
    else if (Array.isArray(value)) value.forEach(inspect);
    else if (record(value)) for (const [key, child] of Object.entries(value)) { inspect(key); inspect(child); }
  };
  inspect(manifest);
  return { verified: modules.length === 0, code: modules.length ? 'SANDBOX_WORKFLOW_BOUNDARY_UNPROVEN' : 'NO_KNOWN_SANDBOX_CLASS_LEAK', sandboxClassModules: modules };
}
export function assertProductionWorkflowBoundary(boundary) {
  if (boundary?.verified !== true) throw new Error('Production packaging blocked: Sandbox workflow boundary is unproven.');
}
export async function inspectWorkflowBoundary(outputRoot) {
  const path = join(outputRoot, 'functions/.well-known/workflow/v1/manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (!manifest.workflows || !manifest.steps) throw new Error('Workflow manifest is incomplete.');
  return { ...workflowBoundary(manifest), manifestSha256: await hashFile(path) };
}
async function outputInventory(directory, root = directory) {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...await outputInventory(path, root));
    else if (entry.isFile()) records.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: (await stat(path)).size, sha256: await hashFile(path) });
    else throw new Error('Unexpected non-file artifact in build output.');
  }
  return records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const fingerprint = records => createHash('sha256').update(JSON.stringify(records)).digest('hex');
export async function quarantineBuildOutput(outputRoot, category = 'rejected') {
  try { await stat(outputRoot); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const destination = join(outputRoot, '..', `${category}-output-${Date.now()}-${process.pid}`);
  await rename(outputRoot, destination);
  return destination;
}
export async function assertNoDefaultBuildOutput(outputRoot) {
  try { await stat(outputRoot); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Preflight cannot clear a stale default prebuilt output; run full preparation to quarantine it.');
}
export async function captureSourceIdentity(root) {
  const git = args => { const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (run.status !== 0) throw new Error('Git source identity is unavailable.'); return run.stdout.trim(); };
  const candidates = git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const paths = [...new Set(candidates)].filter(path => /^(\.github|api|routes|lib|services|server|worker|deploy|remotion|scripts|db|drizzle|workflows|public|media|workers|tools|tests|config)\//.test(path) || (!path.includes('/') && (/\.(?:[cm]?js|json|ya?ml)$/.test(path) || ['.vercelignore', '.npmrc', '.nvmrc', '.node-version', 'Dockerfile'].includes(path)))).sort();
  const source = await Promise.all(paths.map(async path => ({ path, sha256: await hashFile(join(root, path)) })));
  const projectPath = join(root, '.vercel/project.json');
  const project = JSON.parse((await readFile(projectPath, 'utf8')).replace(/^\uFEFF/, ''));
  return { head: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])), sha256: fingerprint(source), files: source,
    projectLinkSha256: await hashFile(projectPath), project: { id: project.projectId, teamId: project.orgId, name: project.projectName } };
}
export function assertUnchangedBuildSource(before, after) {
  if (!before || before.head !== after.head || before.sha256 !== after.sha256 || before.projectLinkSha256 !== after.projectLinkSha256) {
    throw new Error('Build source or project identity changed during packaging; discard this attempt and rebuild.');
  }
}
export function rollbackGates(baseline, projectId) {
  const age = Date.now() - Date.parse(baseline?.observedAt);
  if (!baseline || baseline.projectId !== projectId || !/^dpl_[A-Za-z0-9]+$/.test(baseline.deploymentId || '') || !/^[a-z0-9-]+\.vercel\.app$/.test(baseline.deploymentUrl || '') || baseline.target !== 'production' || baseline.state !== 'READY' || !Number.isFinite(age) || age < 0 || age > 86400000) return ['ROLLBACK_BASELINE_UNVERIFIED'];
  // No byte-attestation verifier exists here. An editable boolean cannot clear it.
  return ['ROLLBACK_SOURCE_BYTES_UNATTESTED'];
}
export function assertStableDatabase(before, after) {
  if (before?.verified !== true || after?.verified !== true || before.environment !== 'production' || after.environment !== 'production' || ['migrationSetSha256', 'schemaSha256', 'targetManifestSha256'].some(key => !before[key] || before[key] !== after[key]) || !before.validatedConnection?.endpoint || JSON.stringify(before.validatedConnection) !== JSON.stringify(after.validatedConnection) || JSON.stringify(before.identity) !== JSON.stringify(after.identity)) throw new Error('Production database identity or schema changed during packaging.');
}
export async function writeReleaseBuildManifest({ root, outputRoot, target, database, receiptPath, rollbackBaseline, expectedSource }) {
  const source = await captureSourceIdentity(root);
  assertUnchangedBuildSource(expectedSource, source);
  const output = await outputInventory(outputRoot);
  const boundary = await inspectWorkflowBoundary(outputRoot);
  const providerRelease = providerReleasePosture();
  const manifest = {
    version: 1, createdAt: new Date().toISOString(), target,
    status: 'REVIEW_ONLY', releaseAuthorized: false,
    source,
    output: { sha256: fingerprint(output), files: output }, database, workflowBoundary: boundary,
    rollbackBaseline: rollbackBaseline || null,
    providerRelease,
    workerImageIdentity: providerRelease.workerImageIdentity,
    remainingReleaseGates: ['OWNER_EXECUTION_AUTHORIZATION', 'CURRENT_CANDIDATE_CI', 'PRIVATE_STORAGE_MIGRATION_PROOF', 'PRODUCTION_P0_RECEIPT', ...providerRelease.remainingReleaseGates, ...rollbackGates(rollbackBaseline, source.project.id), ...(!boundary.verified ? [boundary.code] : []), ...(database?.verified !== true || database?.environment !== 'production' ? ['PRODUCTION_DATABASE_UNVERIFIED'] : [])],
  };
  await writeFile(receiptPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
