import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser requests never claim an account or owner identifier', async () => {
  const client = await readFile(new URL('../public/lite.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /browserAccountId|currentAccountId|data\.accountId/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{[^}]*accountId/);
});