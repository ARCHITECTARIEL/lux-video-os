import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const expectedModes = ['standard', 'premium', 'luxified'];
const checkValues = source => {
  const match = source.match(/(?:CHECK|\bcheck)\s*\(\s*(?:'video_jobs_render_mode_ck'\s*,\s*sql`)?[^\n]*?\bin\s*\(([^)]+)\)/i);
  assert.ok(match, 'render mode CHECK must exist');
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, value]) => value);
};

test('0015/0016 retain audit rows and persist only tier-level render modes', async () => {
  const [migration15, migration16, schema] = await Promise.all([
    read('../drizzle/0015_luxify_cinematic_consent.sql'),
    read('../drizzle/0016_render_mode.sql'),
    read('../db/schema.js'),
  ]);
  assert.doesNotMatch(`${migration15}\n${migration16}`, /ON DELETE\s+cascade/i);
  assert.deepEqual(checkValues(migration16), expectedModes);
  assert.deepEqual(checkValues(schema.match(/check\('video_jobs_render_mode_ck'[^\n]*/)?.[0] ?? ''), expectedModes);
  assert.doesNotMatch(migration16, /THEN\s+'luxify_cinematic_v1'/i);
});
