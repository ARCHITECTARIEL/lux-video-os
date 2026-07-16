import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableName } from 'drizzle-orm';

import { authChallenges, authSessions, entitlements, jobEvents, videoJobs } from '../db/schema.js';
import { initObservability, sanitizeSentryEvent } from '../lib/video-os-observability.js';

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
