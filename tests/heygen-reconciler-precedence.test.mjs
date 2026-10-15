import assert from 'node:assert/strict';
import test from 'node:test';
import { heygenReconcilerMode } from '../lib/heygen-provider-safety.js';
const M = 'VIDEO_OS_HEYGEN_RECONCILER_MODE', L = 'VIDEO_OS_HEYGEN_SUBMIT_RECONCILER_ENABLED';
const cases = [
  [{}, 'off'], [{ [L]: 'true' }, 'act'], [{ [L]: 'false' }, 'off'], [{ [M]: '', [L]: 'true' }, 'act'], [{ [M]: '   ', [L]: 'true' }, 'act'],
  [{ [M]: '', [L]: 'false' }, 'off'], [{ [M]: 'bogus', [L]: 'true' }, 'off'], [{ [M]: ' Shadow ' }, 'shadow'], [{ [M]: 'ACT' }, 'act'],
  [{ [M]: 'act ' }, 'act'], [{ [M]: 'off', [L]: 'true' }, 'off'], [{ [L]: 'TRUE' }, 'off'], [{ [L]: ' true ' }, 'off'], [{ [L]: '1' }, 'off'],
  [{ [L]: 'yes' }, 'off'], [{ [L]: '' }, 'off'], [{ [M]: '', [L]: 'TRUE' }, 'off'], [{ [M]: '', [L]: ' true ' }, 'off'],
  [{ [M]: '', [L]: '1' }, 'off'], [{ [M]: '', [L]: 'yes' }, 'off'], [{ [M]: '', [L]: '' }, 'off'],
  [{ [M]: 'shadow', [L]: 'true' }, 'shadow'], [{ [M]: 'act', [L]: 'false' }, 'act'], [{ [M]: 'shadow\u0000' }, 'off'],
  [{ [M]: 'a ct' }, 'off'], [{ [M]: undefined, [L]: 'true' }, 'act'],
];
for (const [env, expected] of cases) test(`mode ${JSON.stringify(env)} -> ${expected}`, () => assert.equal(heygenReconcilerMode(env), expected));
