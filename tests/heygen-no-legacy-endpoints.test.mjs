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

const legacyHeygenUrl = /https?:\/\/api\.heygen\.com\/v[12](?:\/|\b)/i;
const legacyHeygenPath = /\/v[12]\/(?:photo_avatar|talking_photo|avatar_group|avatars|voices|video_status|video|assets|templates?|user\/remaining_quota)(?:\/|\b)/i;
const heygenContext = /\bAPI_ORIGIN\b|api\.heygen\.com|services\/heygen/i;
const versionedPath = /\/v[12]\//i;
const bareVersionLiteral = /(['"`])\/v[12]\/?\1/i;
const nonHeygenUrl = /https?:\/\/[^\s'"`<>]+/gi;
const workflowPath = /(['"`])\/v1\/workflow(?:\/|\b)/gi;

function scanLegacyHeygenEndpoints(source) {
  const inHeygenContext = heygenContext.test(source);
  return source.split(/\r?\n/).flatMap((line, index) => {
    // Preserve HeyGen URLs, but ignore versioned paths belonging to other hosts.
    const candidate = line.replace(nonHeygenUrl, (url) =>
      /https?:\/\/api\.heygen\.com\//i.test(url) ? url : ' '.repeat(url.length),
    ).replace(workflowPath, (route) => ' '.repeat(route.length));
    const legacyRoute = legacyHeygenUrl.test(candidate) || legacyHeygenPath.test(candidate);
    const contextualRoute = inHeygenContext && (
      versionedPath.test(candidate) || bareVersionLiteral.test(candidate)
    );
    return legacyRoute || contextualRoute ? [index + 1] : [];
  });
}

test('guard catches every legacy HeyGen route noun', () => {
  for (const noun of [
    'photo_avatar', 'talking_photo', 'template', 'templates', 'user/remaining_quota',
    'avatar_group', 'avatars', 'voices', 'video', 'video_status', 'assets',
  ]) {
    assert.deepEqual(scanLegacyHeygenEndpoints(`const path = '/v2/${noun}';`), [1], noun);
  }
  assert.deepEqual(scanLegacyHeygenEndpoints("const path = '/v1/video_status';"), [1]);
  assert.deepEqual(scanLegacyHeygenEndpoints("const url = 'https://api.heygen.com/v2/unknown';"), [1]);
  assert.deepEqual(scanLegacyHeygenEndpoints("const url = 'https://api.heygen.com/v1/workflow/status';"), [1]);
});

test('guard catches any versioned path and split route in HeyGen-context files', () => {
  for (const context of ['API_ORIGIN', 'api.heygen.com', 'services/heygen']) {
    const source = `// ${context}\nconst route = '/v1/unknown';\nconst route2 = '/v2/' + 'voices';\nconst route3 = '/v1';\nconst route4 = '/v2';`;
    assert.deepEqual(scanLegacyHeygenEndpoints(source), [2, 3, 4, 5], context);
  }
});

test('guard excludes other providers and non-HeyGen versioned paths', () => {
  for (const other of [
    'https://accounts.google.com/o/oauth2/v2/auth',
    'https://api.runpod.ai/v2/endpoint/run',
    'https://tavusapi.com/v2/videos',
    'https://api.stripe.com/v1/charges',
    '/v1/workflow/status',
  ]) {
    assert.deepEqual(scanLegacyHeygenEndpoints(`// API_ORIGIN\nconst url = '${other}';`), [], other);
  }
  assert.deepEqual(scanLegacyHeygenEndpoints("const route = '/v2/unknown';"), []);
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
    for (const line of scanLegacyHeygenEndpoints(await readFile(file, 'utf8'))) {
      violations.push(`${path.relative(root, file)}:${line}`);
    }
  }
  assert.deepEqual(violations, []);
});
