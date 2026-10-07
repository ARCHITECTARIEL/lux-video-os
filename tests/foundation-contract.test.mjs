import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';

import { authChallenges, authSessions, entitlements, jobEvents, videoJobs } from '../db/schema.js';
import { assertFailedRenderRecoveryEligibility } from '../db/repositories.js';
import { shouldReleaseWorkflowReservation } from '../api/video-os-lite/render-v2.js';
import { initObservability, sanitizeSentryEvent } from '../lib/video-os-observability.js';
import { providerMediaHostname } from '../services/heygen.js';
import { createPinnedLookup } from '../services/media-finisher.js';
import { videoRenderWorkflowMetadata } from '../workflows/video-render-metadata.js';

function countApiFunctions(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return count + countApiFunctions(target);
    return count + Number(entry.isFile() && entry.name.endsWith('.js'));
  }, 0);
}

test('minimum durable schema covers authentication, entitlements, and workflow truth', () => {
  assert.deepEqual(
    [authChallenges, authSessions, entitlements, videoJobs, jobEvents].map(getTableName),
    ['auth_challenges', 'auth_sessions', 'entitlements', 'video_jobs', 'job_events'],
  );
});

test('Sentry remains dormant without a DSN', () => {
  delete process.env.SENTRY_DSN;
  assert.equal(initObservability(), false);
});

test('Sentry request sanitization removes secrets and query strings', () => {
  const event = sanitizeSentryEvent({ request: { cookies: 'secret', data: { token: 'secret' }, headers: { Authorization: 'Bearer secret', Accept: 'application/json' }, url: 'https://video.example/path?token=secret' } });
  assert.equal(event.request.cookies, undefined);
  assert.equal(event.request.data, undefined);
  assert.equal(event.request.headers.Authorization, undefined);
  assert.equal(event.request.headers.Accept, 'application/json');
  assert.equal(event.request.url, 'https://video.example/path');
});

test('Preview deployment stays within the Hobby serverless function budget', () => {
  const apiFunctions = countApiFunctions(path.resolve('api'));
  const workflowRuntimeFunctions = 3;
  assert.equal(apiFunctions, 9);
  assert.ok(apiFunctions + workflowRuntimeFunctions <= 12);

  const routes = JSON.parse(readFileSync('vercel.json', 'utf8')).routes;
  const workspaceRoutes = routes.filter((route) => route.dest === '/api/video-os-lite/workspace.js').map((route) => route.src).sort();
  assert.deepEqual(workspaceRoutes, [
    '/api/video-os-lite/admin',
    '/api/video-os-lite/asset',
    '/api/video-os-lite/copywriter',
    '/api/video-os-lite/enrollment-upload',
    '/api/video-os-lite/enrollments',
    '/api/video-os-lite/identities',
    '/api/video-os-lite/projects',
    '/api/video-os-lite/provider-consent',
    '/api/video-os-lite/providers',
    '/api/video-os-lite/results',
    '/api/video-os-lite/scripted-photo',
    '/api/video-os-lite/standard',
  ]);
});

test('project creation establishes its signed Postgres owner before persistence', () => {
  const source = readFileSync('routes/video-os-lite/projects.js', 'utf8');
  // Standard project creation is unconditional (no update path), so its
  // ensureAccount/saveStandardProject pair is the first occurrence in the
  // file; the legacy Premium pair (guarded by `!payload.id` since it also
  // handles updates) is the last.
  const standardEnsureIndex = source.indexOf('await ensureAccount({');
  const standardSaveIndex = source.indexOf('await saveStandardProject({');
  assert.ok(standardEnsureIndex >= 0 && standardSaveIndex > standardEnsureIndex, 'Standard project creation must synchronize the signed account before persistence');
  const repositorySource = readFileSync('db/repositories.js', 'utf8');
  const standardProjectStart = repositorySource.indexOf('export async function saveStandardProject');
  const standardProjectEnd = repositorySource.indexOf('export async function listProjects', standardProjectStart);
  assert.match(repositorySource.slice(standardProjectStart, standardProjectEnd), /script:\s*''/,
    'Standard projects must remain compatible with legacy projects.script NOT NULL schemas without inventing script content');
  const ensureIndex = source.lastIndexOf('await ensureAccount({');
  const saveIndex = source.lastIndexOf('await saveProject({');
  assert.ok(ensureIndex >= 0, 'project route must synchronize the signed account');
  assert.ok(saveIndex > ensureIndex, 'account synchronization must precede project insertion');
  assert.match(source.slice(0, ensureIndex), /if \(!payload\.id\) \{/);
  assert.match(source, /accountId:\s*session\.accountId/);
  assert.match(source, /initialCredits:\s*DEFAULT_TRIAL_CREDITS/);
});

test('render start uses immutable workflow metadata registered by the build manifest', () => {
  assert.equal(Object.isFrozen(videoRenderWorkflowMetadata), true);
  assert.deepEqual(videoRenderWorkflowMetadata, {
    workflowId: 'workflow//./workflows/video-render//videoRenderWorkflow',
  });

  const source = readFileSync('api/video-os-lite/render-v2.js', 'utf8');
  assert.match(source, /start\(videoRenderWorkflowMetadata, \[reserved\.job\.id\]\)/);
  assert.doesNotMatch(source, /import \{ videoRenderWorkflow \}/);
});

test('workflow acceptance preserves its reservation when run tracking persistence fails', () => {
  const prepared = { id: 'job-proof', status: 'workflow_started', workflowRunId: null };
  assert.equal(shouldReleaseWorkflowReservation({ job: prepared, workflowDispatchAttempted: false }), true);
  assert.equal(shouldReleaseWorkflowReservation({ job: prepared, workflowDispatchAttempted: true }), false);
  assert.equal(shouldReleaseWorkflowReservation({ job: { ...prepared, workflowRunId: 'wrun-proof' }, workflowDispatchAttempted: false }), false);

  const routeSource = readFileSync('api/video-os-lite/render-v2.js', 'utf8');
  // On Vercel (the default / WORKFLOW_DISPATCH_MODE=vercel), a claimed job
  // must still actually be dispatched via start() -- not silently left as
  // "attempted" with nothing behind it.
  assert.match(routeSource, /workflowDispatchAttempted = true;\s+if \(dispatchesViaVercelWorkflow\(\)\) \{\s+const run = await start/);
  assert.match(routeSource, /code: workflowAccepted \? 'workflow_tracking_pending' : 'workflow_dispatch_uncertain'/);
  // On a VPS (WORKFLOW_DISPATCH_MODE != vercel), dispatch is intentionally a
  // no-op: worker/render-worker.mjs's poll loop drives the job forward from
  // 'workflow_started' instead of Vercel Workflow's runtime.
  assert.match(routeSource, /\} else \{\s+workflowAccepted = true;\s+\}/);
  const repositorySource = readFileSync('db/repositories.js', 'utf8');
  assert.match(repositorySource, /status:\s*'workflow_started'.+eq\(videoJobs\.status, 'reserved'\)/s);
  assert.doesNotMatch(repositorySource, /set\(\{ workflowRunId, status: 'workflow_started'/);
});

test('Preview prebuild uses Preview-scoped Vercel configuration', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['build:preview'], 'node tools/build-production.mjs --preview');

  const source = readFileSync('tools/build-production.mjs', 'utf8');
  assert.match(source, /process\.argv\.includes\('--preview'\) \? 'preview' : 'production'/);
  assert.match(source, /\['build', '--target', target\]/);
});

test('finishing resumes from the canonical claimed job and ready-media evidence', () => {
  const source = readFileSync('workflows/video-render.js', 'utf8');
  assert.match(source, /if \(readClaim\.job\.status === 'provider_ready'\) await transitionJob\(/);
  assert.match(source, /else if \(readClaim\.job\.status !== 'finishing'\) throw/);
  assert.match(source, /readClaim\.sourceUrlDigest/);
  assert.match(source, /return await finishProviderMedia\(jobId, status\.sourceUrl\)/);
});

test('completed provider telemetry reduces media evidence to a credential-free hostname', () => {
  assert.equal(providerMediaHostname('https://Media.Example.test/video.mp4?signature=secret'), 'media.example.test');
  assert.throws(() => providerMediaHostname('http://media.example.test/video.mp4'));
  assert.throws(() => providerMediaHostname('https://user:secret@media.example.test/video.mp4'));

  const source = readFileSync('services/heygen.js', 'utf8');
  assert.match(source, /logEvent\('provider\.media_ready', \{ providerHostname: providerMediaHostname\(sourceUrl\) \}\)/);
  assert.doesNotMatch(source, /logEvent\('provider\.media_ready',\s*\{\s*sourceUrl\s*[,:}]/);
});

test('failed provider artifact recovery is narrow and transactionally gated', () => {
  const eligible = { status: 'failed', providerJobId: 'existing-provider-job', output: { message: 'Provider media hostname is not allowlisted.' } };
  assert.equal(assertFailedRenderRecoveryEligibility(eligible), true);
  assert.equal(assertFailedRenderRecoveryEligibility({ ...eligible, output: { message: 'Step failed after 3 retries: Invalid IP address: undefined' } }), true);
  assert.equal(assertFailedRenderRecoveryEligibility({ ...eligible, output: { message: 'Step failed after 3 retries: spawn /var/task/ffmpeg ENOENT' } }), true);
  assert.throws(() => assertFailedRenderRecoveryEligibility({ ...eligible, providerJobId: null }));
  assert.throws(() => assertFailedRenderRecoveryEligibility({ ...eligible, output: { message: 'Provider rejected the render.' } }));
  assert.throws(() => assertFailedRenderRecoveryEligibility(eligible, { charged: true }));
  assert.throws(() => assertFailedRenderRecoveryEligibility({ ...eligible, status: 'provider_submitted' }));

  const source = readFileSync('db/repositories.js', 'utf8');
  assert.match(source, /eventType:\s*'workflow\.recovery_reserved'/);
  assert.match(source, /existingProviderJob:\s*true/);
});

test('pinned provider DNS lookup honors Node single and all-address callback contracts', () => {
  const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
  lookup('media.example.test', { all: false }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  lookup('media.example.test', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
  assert.throws(() => createPinnedLookup({ address: undefined, family: undefined }));
});

test('Preview build stages a verified platform-correct FFmpeg in the workflow step', () => {
  const source = readFileSync('tools/build-production.mjs', 'utf8');
  assert.match(source, /stageWorkflowFfmpeg\(workflowStepFunction\)/);
  assert.match(source, /npm_config_platform:\s*'linux'/);
  assert.match(source, /header\.subarray\(0, 4\)\.toString\('hex'\) !== '7f454c46'/);
  assert.match(source, /await chmod\(target, 0o755\)/);
});
