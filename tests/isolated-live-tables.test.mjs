import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isolatedLiveTableNames, assertKnownIsolatedLiveTables } from '../tools/isolated-live-tables.mjs';

test('isolated-live allowlist matches the reviewed 0016 public-table snapshot', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../drizzle/meta/0016_snapshot.json', import.meta.url), 'utf8'));
  const expected = Object.keys(snapshot.tables).map(name => name.replace(/^public\./, '')).sort();
  assert.deepEqual([...isolatedLiveTableNames].sort(), expected);
  assertKnownIsolatedLiveTables(expected);
  assertKnownIsolatedLiveTables([]); // Migration mode starts with an empty database.
});

test('isolated-live rejects an unexpected public table', () => {
  assert.throws(() => assertKnownIsolatedLiveTables([...isolatedLiveTableNames, 'unreviewed_table']), /Unexpected table/);
});

test('unsupported upgrade mode stops before credentials or live target access', () => {
  const result = spawnSync(process.execPath, ['tools/verify-isolated-live.mjs', 'upgrade'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', BLOB_READ_WRITE_TOKEN: '', VIDEO_OS_LIVE_REPORT: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Upgrade mode requires a reviewed prefix schema lock/);
  assert.doesNotMatch(result.stderr, /An explicit report path is required|DATABASE_URL_REQUIRED/);
  assert.equal(result.stdout, '');
});
