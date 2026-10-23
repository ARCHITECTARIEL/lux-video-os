import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('every known video job status has a watchdog disposition', () => {
  // video_jobs.status is free text; this transition map is the code's status list.
  const source = readFileSync(new URL('../db/repositories.js', import.meta.url), 'utf8');
  const transitions = source.match(/const ALLOWED_JOB_TRANSITIONS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  assert.ok(transitions, 'job status list must remain discoverable');
  const statuses = [...transitions.matchAll(/(?:^|\s)([a-z_]+):\s*\[/g)].map(match => match[1]);
  const covered = new Set(['ready', 'failed', 'cancelled', 'finish_contained']); // held for manual review
  for (const bucket of ['WATCHDOG_ACTIONABLE_STATUSES', 'WATCHDOG_STALE_AMBIGUOUS_ALERT_STATUSES', 'WATCHDOG_SAFE_TO_RELEASE_STATUSES']) {
    const match = source.match(new RegExp(`const ${bucket} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
    assert.ok(match, `${bucket} must remain discoverable`);
    for (const status of match[1].matchAll(/'([a-z_]+)'/g)) covered.add(status[1]);
  }
  assert.deepEqual(statuses.filter(status => !covered.has(status)), []);
});
