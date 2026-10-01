import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSourceIdentity, inspectWorkflowBoundary } from './release-build-manifest.mjs';

// This tool re-verifies the AUTOMATABLE gates on an already-quarantined
// `npm run build:production` candidate, immediately before a deploy. It
// deliberately cannot and does not clear the gates that require real-world
// evidence (a genuine P0 paid-render proof, HeyGen account/pricing/privacy
// verification, rollback byte-attestation, owner sign-off): those remain in
// `outstandingLaunchGates` exactly as the build manifest recorded them.
// `releaseAuthorized` is therefore always false here. The narrower
// `routineDeployAuthorized` flag means only: this exact artifact may be
// deployed to production code-wise, not that the product may launch/bill.
const CI_REQUIRED_CHECKS = ['verify', 'analyze'];

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function outputInventory(directory, rootDir = directory) {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...await outputInventory(path, rootDir));
    else if (entry.isFile()) records.push({ path: relative(rootDir, path).replaceAll('\\', '/'), sha256: await hashFile(path) });
    else throw new Error('Unexpected non-file artifact in quarantined output.');
  }
  return records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function fingerprint(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function checkCurrentCandidateCi(checkRuns, requiredChecks = CI_REQUIRED_CHECKS) {
  const byName = Object.fromEntries((checkRuns || []).map(run => [run.name, run.conclusion]));
  const detail = Object.fromEntries(requiredChecks.map(name => [name, byName[name] ?? null]));
  const passed = requiredChecks.every(name => byName[name] === 'success');
  return { passed, detail };
}

export function computeAuthorizationResult({ manifest, currentSource, liveOutputSha256, freshDatabaseCheck, workflowBoundary, ciResult, ownerAuthorized }) {
  const checks = {
    sourceUnchangedSincePackaging: Boolean(
      manifest.source && currentSource.head === manifest.source.head
      && currentSource.sha256 === manifest.source.sha256
      && currentSource.projectLinkSha256 === manifest.source.projectLinkSha256,
    ),
    sourceClean: !currentSource.dirty,
    outputIntegrityIntact: liveOutputSha256 === manifest.output?.sha256,
    databaseVerifiedNow: Boolean(freshDatabaseCheck?.ok && freshDatabaseCheck.result?.verified === true),
    databaseUnchangedSincePackaging: Boolean(
      freshDatabaseCheck?.ok && freshDatabaseCheck.result?.verified === true && manifest.database
      && ['migrationSetSha256', 'schemaSha256', 'targetManifestSha256'].every(key => manifest.database[key] && manifest.database[key] === freshDatabaseCheck.result[key]),
    ),
    workflowBoundaryVerifiedNow: workflowBoundary?.verified === true,
    currentCandidateCiPassed: Boolean(ciResult?.passed),
  };

  const automatableGatesCleared = Object.values(checks).every(Boolean);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    candidateHead: currentSource.head,
    automatableChecks: checks,
    ciDetail: ciResult?.detail ?? null,
    automatableGatesCleared,
    ownerAuthorizationFlagProvided: Boolean(ownerAuthorized),
    routineDeployAuthorized: automatableGatesCleared && Boolean(ownerAuthorized),
    // Deliberately always false: this tool only re-verifies what code can
    // re-verify. Full release authorization needs real P0/HeyGen/attestation
    // evidence this tool cannot produce -- see outstandingLaunchGates.
    releaseAuthorized: false,
    outstandingLaunchGates: manifest.remainingReleaseGates || [],
    note: 'routineDeployAuthorized means this exact, re-verified artifact may be deployed to production code-wise (`vercel deploy --prebuilt --prod`). It does NOT mean the P0/launch release gate is satisfied -- see outstandingLaunchGates, which require real-world evidence no script can produce.',
  };
}

function argument(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

export async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifestPath = argument('--manifest') || join(root, '.vercel/release-build-manifest.json');
  const ownerAuthorized = process.argv.includes('--owner-authorized');

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.target !== 'production') throw new Error('Release build manifest is not a production candidate.');
  if (!manifest.output?.location) throw new Error('Release build manifest has no quarantined output location; run npm run build:production first.');
  await stat(manifest.output.location).catch(() => { throw new Error(`Quarantined output is missing at ${manifest.output.location}.`); });

  const currentSource = await captureSourceIdentity(root);
  const liveInventory = await outputInventory(manifest.output.location);
  const liveOutputSha256 = fingerprint(liveInventory);
  const workflowBoundary = await inspectWorkflowBoundary(manifest.output.location);

  const dbCheckRun = spawnSync(process.execPath, [join(root, 'tools/check-migrations.mjs'), '--strict', '--environment', 'production'], { cwd: root, env: process.env, encoding: 'utf8' });
  let freshDatabaseCheck;
  try {
    const jsonLine = dbCheckRun.stdout.trim().split('\n').filter(Boolean).pop();
    freshDatabaseCheck = { ok: dbCheckRun.status === 0, result: jsonLine ? JSON.parse(jsonLine) : null };
  } catch {
    freshDatabaseCheck = { ok: false, result: null };
  }

  const ghRepo = argument('--repo') || 'ARCHITECTARIEL/lux-video-os';
  const ciRun = spawnSync('gh', ['api', `repos/${ghRepo}/commits/${currentSource.head}/check-runs`], { encoding: 'utf8' });
  let ciResult = { passed: false, detail: null };
  if (ciRun.status === 0) {
    try { ciResult = checkCurrentCandidateCi(JSON.parse(ciRun.stdout).check_runs); } catch { /* leave as failed */ }
  }

  const result = computeAuthorizationResult({ manifest, currentSource, liveOutputSha256, freshDatabaseCheck, workflowBoundary, ciResult, ownerAuthorized });
  console.log(JSON.stringify(result, null, 2));

  if (result.routineDeployAuthorized) {
    const target = join(root, '.vercel/output');
    await rename(manifest.output.location, target);
    console.error(`\nQuarantined output restored to ${target} for deploy. Run: vercel deploy --prebuilt --prod`);
  } else {
    console.error('\nNot authorized for routine deploy -- see automatableChecks/ciDetail above for what is unresolved.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
