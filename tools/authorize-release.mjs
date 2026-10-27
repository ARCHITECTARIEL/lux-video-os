import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSourceIdentity, inspectWorkflowBoundary } from './release-build-manifest.mjs';
import { loadPinnedHeygenSpaceAnchorIdentity, loadPinnedHeygenSpaceAnchorProjection } from '../lib/heygen-space-anchor.js';
import { assertHeygenRefreshReleaseWindow } from '../lib/heygen-space-refresh.js';
import { assertConfiguredHeygenSpaceMarker, loadPinnedHeygenSpaceMarkerManifest } from '../lib/heygen-space-marker.js';
import { canonicalJsonBytes } from '../lib/heygen-reconciliation-contract.js';

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
// GitHub's check-runs endpoint defaults to 30 results per page and caps
// per_page at 100. A long-lived main head accumulates scheduled workflow runs,
// which can push a required check past the first page, so every page must be
// read. The page cap is a runaway guard: hitting it before total_count is
// reached is treated as a failure (fail closed), never as a partial pass.
export const CHECK_RUNS_PER_PAGE = 100;
export const CHECK_RUNS_MAX_PAGES = 20;

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Record shape (key order included) must match release-build-manifest.mjs's
// own outputInventory() exactly, or fingerprint() will differ even when
// every path/byte-count/hash is identical -- JSON.stringify is key-order
// sensitive per object.
export async function outputInventory(directory, rootDir = directory) {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...await outputInventory(path, rootDir));
    else if (entry.isFile()) records.push({ path: relative(rootDir, path).replaceAll('\\', '/'), bytes: (await stat(path)).size, sha256: await hashFile(path) });
    else throw new Error('Unexpected non-file artifact in quarantined output.');
  }
  return records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function fingerprint(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function isCompletedRun(run) {
  // Runs without a status field (older fixtures) count as completed only if
  // they carry a conclusion; GitHub always sends status.
  return run?.status === undefined ? run?.conclusion != null : run.status === 'completed';
}

function runTime(run) {
  const t = Date.parse(run?.completed_at ?? '');
  return Number.isFinite(t) ? t : -Infinity;
}

// Newer wins: later completed_at, then higher id. On a full tie the run seen
// first is kept (GitHub lists the newest run first).
function isNewerRun(candidate, current) {
  const dt = runTime(candidate) - runTime(current);
  if (dt !== 0 && !Number.isNaN(dt)) return dt > 0;
  const ci = Number(candidate?.id), cu = Number(current?.id);
  if (Number.isFinite(ci) && Number.isFinite(cu) && ci !== cu) return ci > cu;
  return false;
}

export function latestCompletedRunsByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns || []) {
    if (!run || typeof run.name !== 'string' || !isCompletedRun(run)) continue;
    const current = latest.get(run.name);
    if (!current || isNewerRun(run, current)) latest.set(run.name, run);
  }
  return latest;
}

export function checkCurrentCandidateCi(checkRuns, requiredChecks = CI_REQUIRED_CHECKS) {
  const latest = latestCompletedRunsByName(checkRuns);
  const detail = Object.fromEntries(requiredChecks.map(name => [name, latest.get(name)?.conclusion ?? null]));
  const passed = requiredChecks.every(name => detail[name] === 'success');
  return { passed, detail };
}

export function ghApiJson(path, { spawn = spawnSync } = {}) {
  const run = spawn('gh', ['api', path], { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    // Do not echo gh's stderr: keep the failure message free of request detail.
    throw new Error(`GitHub API request failed (exit ${run.status ?? 'none'}).`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error('GitHub API returned a non-JSON response.');
  }
}

// Reads every page of a commit's check-runs. Throws on any API error,
// malformed page, or if total_count cannot be reached within maxPages, so the
// caller fails closed.
export async function fetchAllCheckRuns({ repo, sha, ghApi = ghApiJson, perPage = CHECK_RUNS_PER_PAGE, maxPages = CHECK_RUNS_MAX_PAGES }) {
  if (!repo || !sha) throw new Error('fetchAllCheckRuns requires repo and sha.');
  const runs = [];
  let totalCount = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await ghApi(`repos/${repo}/commits/${sha}/check-runs?per_page=${perPage}&page=${page}`);
    if (!body || !Array.isArray(body.check_runs) || !Number.isInteger(body.total_count) || body.total_count < 0) {
      throw new Error(`Malformed check-runs response on page ${page}.`);
    }
    if (totalCount === null) totalCount = body.total_count;
    runs.push(...body.check_runs);
    if (runs.length >= totalCount) return { checkRuns: runs, totalCount, pages: page };
    if (body.check_runs.length === 0) {
      throw new Error(`check-runs ended early: ${runs.length} of ${totalCount} after page ${page}.`);
    }
  }
  throw new Error(`check-runs exceeded page cap (${maxPages} pages): ${runs.length} of ${totalCount} read.`);
}

export async function resolveCurrentCandidateCi({ repo, sha, ghApi = ghApiJson, requiredChecks = CI_REQUIRED_CHECKS, ...options }) {
  try {
    const { checkRuns } = await fetchAllCheckRuns({ repo, sha, ghApi, ...options });
    return checkCurrentCandidateCi(checkRuns, requiredChecks);
  } catch (error) {
    return { passed: false, detail: null, error: error?.message || 'check-runs lookup failed' };
  }
}

export function computeAuthorizationResult({ manifest, currentSource, liveOutputSha256, freshDatabaseCheck, workflowBoundary, ciResult, refreshCheck, ownerAuthorized }) {
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
    spaceAuthorityVerified: manifest.target === 'production' ? refreshCheck?.verified === true : true,
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

export async function checkQuarantinedMarkerFiles(root, output, manifest, env = process.env) {
  const relativePaths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-marker.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-marker.json',
  ];
  try {
    assertConfiguredHeygenSpaceMarker(manifest, env);
    const source = await readFile(join(root, 'config/heygen-space-marker.json'));
    if (createHash('sha256').update(canonicalJsonBytes(JSON.parse(source))).digest('hex') !== manifest.manifestSha256) {
      return { verified: false };
    }
    for (const path of relativePaths) {
      if (!(await readFile(join(output, path))).equals(source)) return { verified: false };
    }
    return { verified: true, mode: 'retained-marker' };
  } catch {
    return { verified: false };
  }
}

export async function checkQuarantinedRefreshFiles(root, output, { now = new Date() } = {}) {
  const relativePaths = [
    'functions/api/video-os-lite/workspace.func/config/heygen-space-refresh.json',
    'functions/.well-known/workflow/v1/step.func/runtime-repository/config/heygen-space-refresh.json',
  ];
  try {
    const source = await readFile(join(root, 'config/heygen-space-refresh.json'));
    for (const path of relativePaths) {
      if (!(await readFile(join(output, path))).equals(source)) return { verified: false };
    }
    const anchor = await loadPinnedHeygenSpaceAnchorProjection({ now });
    const remainingMs = assertHeygenRefreshReleaseWindow(anchor, { now });
    return { verified: true, expiresAt: anchor.anchorExpiresAt, remainingMs };
  } catch {
    return { verified: false };
  }
}

export async function checkQuarantinedSpaceAuthority(root, output, { now = new Date() } = {}) {
  const origin = await loadPinnedHeygenSpaceAnchorIdentity();
  const marker = await loadPinnedHeygenSpaceMarkerManifest(origin);
  return marker
    ? checkQuarantinedMarkerFiles(root, output, marker)
    : checkQuarantinedRefreshFiles(root, output, { now });
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
  const ciResult = await resolveCurrentCandidateCi({ repo: ghRepo, sha: currentSource.head });
  if (ciResult.error) console.error(`CI check-runs lookup failed closed: ${ciResult.error}`);

  const refreshCheck = await checkQuarantinedSpaceAuthority(root, manifest.output.location);
  const result = computeAuthorizationResult({ manifest, currentSource, liveOutputSha256, freshDatabaseCheck, workflowBoundary, ciResult, refreshCheck, ownerAuthorized });
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
