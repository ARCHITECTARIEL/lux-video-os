import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { DEFAULT_TRIAL_CREDITS } from '../lib/video-os-account.js';

test('regular signups receive no automatic render credits and Welcome makes no free-video promise', async () => {
  const landing = await readFile(new URL('../public/landing.html', import.meta.url), 'utf8');
  assert.equal(DEFAULT_TRIAL_CREDITS, 0);
  assert.doesNotMatch(landing, /free video|first video is free|free trial credits|enough credits to create one video|included for free/i);
  assert.match(landing, />Create a video<\/a>/);
});
