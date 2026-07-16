import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';

import { authChallenges, authSessions, entitlements, jobEvents, videoJobs } from '../db/schema.js';
import { initObservability, sanitizeSentryEvent } from '../lib/video-os-observability.js';

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
