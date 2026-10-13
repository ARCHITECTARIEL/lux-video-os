import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const excludedDirectories = new Set([
  '.git', '.omx', '.vercel', 'node_modules', 'tests', 'docs', 'wiki',
  'build', 'dist', 'coverage', 'output', '.next',
]);
const sourceExtensions = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.py', '.json', '.html', '.sh', '.ps1',
]);

// These route nouns are HeyGen-specific in this repo. Generic /v1/ and /v2/
// belong to other providers too (Google, RunPod, Stripe, Tavus, Workflow),
// so only a literal HeyGen origin or these legacy HeyGen route shapes fail.
const legacyHeygenUrl = /https?:\/\/api\.heygen\.com\/v[12](?:\/|\b)/i;
const legacyHeygenPath = /\/v[12]\/(?:avatar_group(?:\/|\b)|avatars(?:\/|\b)|voices(?:\/|\b)|video(?:\/|\b)|video_status(?:\/|\b))/i;

test('guard targets HeyGen routes without rejecting other providers', () => {
  assert.equal(legacyHeygenUrl.test('https://api.heygen.com/v2/voices'), true);
  assert.equal(legacyHeygenPath.test('/v1/video_status'), true);
  for (const other of [
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://api.runpod.ai/v2/endpoint/run',
    'https://tavusapi.com/v2/videos',
    'https://api.stripe.com/v1/charges',
    '/v1/workflow/status',
  ]) {
    assert.equal(legacyHeygenUrl.test(other) || legacyHeygenPath.test(other), false, other);
  }
});

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.env')) continue; // Never inspect credentials.
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) yield* sourceFiles(fullPath);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

test('non-test source has no legacy HeyGen endpoint', async () => {
  const violations = [];
  for await (const file of sourceFiles(root)) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (legacyHeygenUrl.test(line) || legacyHeygenPath.test(line)) {
        violations.push(`${path.relative(root, file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});
