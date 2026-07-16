import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';

import { authChallenges, authSessions, entitlements, jobEvents, videoJobs } from '../db/schema.js';
import { initObservability, sanitizeSentryEvent } from '../lib/video-os-observability.js';
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
    '/api/video-os-lite/projects',
    '/api/video-os-lite/providers',
    '/api/video-os-lite/results',
  ]);
});

test('project creation establishes its signed Postgres owner before persistence', () => {
  const source = readFileSync('routes/video-os-lite/projects.js', 'utf8');
  const ensureIndex = source.indexOf('await ensureAccount({');
  const saveIndex = source.indexOf('await saveProject({');
  assert.ok(ensureIndex >= 0, 'project route must synchronize the signed account');
  assert.ok(saveIndex > ensureIndex, 'account synchronization must precede project insertion');
  assert.match(source.slice(0, ensureIndex), /if \(!payload\.id\) \{/);
  assert.match(source, /accountId:\s*session\.accountId/);
  assert.match(source, /initialCredits:\s*Number\(process\.env\.VIDEO_OS_TRIAL_CREDITS/);
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

test('Preview prebuild uses Preview-scoped Vercel configuration', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['build:preview'], 'node tools/build-production.mjs --preview');

  const source = readFileSync('tools/build-production.mjs', 'utf8');
  assert.match(source, /process\.argv\.includes\('--preview'\) \? 'preview' : 'production'/);
  assert.match(source, /\['build', '--target', target\]/);
});

test('finishing retries resume idempotently and failures reach credit release', () => {
  const source = readFileSync('workflows/video-render.js', 'utf8');
  assert.match(source, /if \(job\.status === 'provider_ready'\) await transitionJob\(/);
  assert.match(source, /else if \(job\.status !== 'finishing'\) throw/);
  assert.match(source, /\['provider_ready', 'finishing'\]\.includes\(job\.status\) && status\.ready/);
  assert.match(source, /return await finishProviderMedia\(jobId, status\.sourceUrl\)/);
});
