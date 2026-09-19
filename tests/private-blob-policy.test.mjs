import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVATE_BLOB_CLASSIFICATIONS,
  assertPrivateBlobWrite,
  privateBlobClassificationForPath,
} from '../lib/video-os-private-blob.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const protectedCases = [
  [PRIVATE_BLOB_CLASSIFICATIONS.ACCOUNT_STATE, 'video-os/accounts/account-1.json'],
  [PRIVATE_BLOB_CLASSIFICATIONS.AUTHENTICATION_STATE, 'video-os/auth/token-hash.json'],
  [PRIVATE_BLOB_CLASSIFICATIONS.RATE_LIMIT_STATE, 'video-os/rate/window-1.json'],
  [PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, 'video-os/uploads/source.png'],
  [PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, 'video-os/finals/account-1/job-1.mp4'],
];

test('protected customer classifications are private-only and prefix-bound', () => {
  for (const [classification, pathname] of protectedCases) {
    assert.deepEqual(
      assertPrivateBlobWrite({ classification, pathname }),
      { access: 'private', classification, pathname },
    );
    assert.equal(privateBlobClassificationForPath(pathname), classification);
    assert.throws(
      () => assertPrivateBlobWrite({ classification, pathname, access: 'public' }),
      /Public Blob writes are prohibited/,
    );
  }
});

test('unknown classifications, mismatched prefixes, and traversal-like paths fail closed', () => {
  assert.throws(
    () => assertPrivateBlobWrite({ classification: 'unknown', pathname: 'video-os/unknown/value.json' }),
    /classification is not allowed/,
  );
  assert.throws(
    () => assertPrivateBlobWrite({ classification: PRIVATE_BLOB_CLASSIFICATIONS.ACCOUNT_STATE, pathname: 'video-os/auth/value.json' }),
    /does not match/,
  );
  assert.throws(
    () => assertPrivateBlobWrite({ classification: PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD, pathname: 'video-os/uploads/../accounts/value.json' }),
    /does not match/,
  );
});

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await javascriptFiles(path));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('deployable source has one Blob write gateway and no public access selection', async () => {
  const sourceRoots = ['api', 'lib', 'services', 'workflows'];
  const files = (await Promise.all(sourceRoots.map((directory) => javascriptFiles(join(root, directory))))).flat();
  const directPutImports = [];
  const publicSelectors = [];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const projectPath = relative(root, path).replaceAll('\\', '/');
    if (/access\s*:\s*['"]public['"]/.test(source)) publicSelectors.push(projectPath);
    // lib/video-os-private-blob.js is the gateway every other module must call
    // through; lib/storage-drivers/*-driver.js are its own private, swappable
    // backends (Vercel Blob vs. local filesystem for VPS hosting) and only
    // exist to be imported from that gateway, never from application code.
    const isGatewayOrDriver = projectPath === 'lib/video-os-private-blob.js' || projectPath.startsWith('lib/storage-drivers/');
    if (!isGatewayOrDriver && /import\s*\{[^}]*\bput\b[^}]*\}\s*from\s*['"]@vercel\/blob['"]/.test(source)) {
      directPutImports.push(projectPath);
    }
  }

  assert.deepEqual(publicSelectors, []);
  assert.deepEqual(directPutImports, []);
});

test('legacy account, authentication, rate-limit, upload, and final writers use the private gateway', async () => {
  const requiredGatewayUsers = [
    'lib/video-os-account.js',
    'api/video-os-lite/uploads.js',
    'services/media-finisher.js',
  ];
  for (const projectPath of requiredGatewayUsers) {
    const source = await readFile(join(root, projectPath), 'utf8');
    assert.match(source, /putPrivateBlob/);
    assert.doesNotMatch(source, /\bput\s*\(/);
  }
});
