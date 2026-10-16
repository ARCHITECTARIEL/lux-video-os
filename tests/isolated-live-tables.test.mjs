import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
