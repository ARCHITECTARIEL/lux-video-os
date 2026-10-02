import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { list } from '@vercel/blob';

export const INVENTORY_SCHEMA_VERSION = 'video-os-storage-inventory/v2';

const CATEGORY_PREFIXES = Object.freeze([
  ['account-state', 'video-os/accounts/'],
  ['authentication-state', 'video-os/auth/'],
  ['rate-limit-state', 'video-os/rate/'],
  ['customer-upload', 'video-os/uploads/'],
  ['finished-customer-video', 'video-os/finals/'],
  ['job-state', 'video-os/jobs/'],
  ['credit-state', 'video-os/credit-state/'],
  ['stripe-event', 'video-os/stripe-events/'],
  ['recovery-receipt', 'video-os/recovery-receipts/'],
  // Observed legacy containment location. This is a retention hold, not proof
  // of ownership, source integrity, completed migration, or deletion authority.
  ['quarantined-retained', 'video-os/containment-20260715/quarantine/'],
]);

const ALL_CATEGORIES = Object.freeze([...CATEGORY_PREFIXES.map(([category]) => category), 'unclassified']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortStoreId(storeId) {
  const value = String(storeId || '').replace(/^store_/i, '');
  assert.match(value, /^[A-Za-z0-9]+$/, 'A valid Blob store ID is required.');
  return value;
}

function tokenTargetsStore(token, storeId) {
  return String(token || '').toLowerCase().startsWith(`vercel_blob_rw_${shortStoreId(storeId).toLowerCase()}_`);
}

function positiveInteger(value, label, { allowZero = true } = {}) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && (allowZero ? number >= 0 : number > 0), `${label} must be a safe integer.`);
  return number;
}

function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function classifyStoragePathname(pathname) {
  const match = CATEGORY_PREFIXES.find(([, prefix]) => String(pathname || '').startsWith(prefix));
  return match?.[0] || 'unclassified';
}

export function assertPrivateReportOutsideRepository(pathname, repositoryRoot = process.cwd()) {
  assert.ok(pathname, 'A private raw report path is required.');
  assert.ok(isAbsolute(pathname), 'The private raw report path must be absolute.');
  assert.ok(!isInside(repositoryRoot, pathname), 'The private raw report must stay outside the repository.');
  return resolve(pathname);
}

export async function collectStorageInventory({
  token,
  storeId,
  access,
  expectedCount,
  expectedBytes,
  projectId,
  environment,
  generatedAt = new Date().toISOString(),
  listPage = list,
} = {}) {
  assert.ok(token, 'BLOB_READ_WRITE_TOKEN is required.');
  assert.ok(tokenTargetsStore(token, storeId), 'The Blob credential does not target the expected store.');
  assert.ok(access === 'private' || access === 'public', 'Expected access must be private or public.');
  assert.match(String(projectId || ''), /^prj_[A-Za-z0-9]+$/, 'An expected Vercel project ID is required.');
  assert.match(String(environment || ''), /^(production|preview|development)$/, 'An expected Vercel environment is required.');
  expectedCount = positiveInteger(expectedCount, 'Expected object count');
  expectedBytes = positiveInteger(expectedBytes, 'Expected byte count');

  const store = shortStoreId(storeId).toLowerCase();
  const expectedHost = `${store}.${access}.blob.vercel-storage.com`;
  const raw = [];
  const seenPaths = new Set();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await listPage({ token, cursor, limit: 1000 });
    assert.ok(page && Array.isArray(page.blobs) && typeof page.hasMore === 'boolean', 'Blob list returned an invalid page.');
    for (const blob of page.blobs) {
      assert.ok(blob && typeof blob.pathname === 'string' && blob.pathname.length > 0, 'Blob list returned an invalid pathname.');
      assert.ok(!seenPaths.has(blob.pathname), 'Blob list returned a duplicate pathname.');
      seenPaths.add(blob.pathname);
      const url = new URL(blob.url);
      assert.equal(url.protocol, 'https:', 'Blob list returned a non-HTTPS URL.');
      assert.equal(url.hostname.toLowerCase(), expectedHost, 'Blob object access/store does not match the expected target.');
      assert.equal(decodeURIComponent(url.pathname.slice(1)), blob.pathname, 'Blob URL pathname does not match Blob metadata.');
      raw.push({
        pathname: blob.pathname,
        size: positiveInteger(blob.size, 'Blob size'),
        uploadedAt: new Date(blob.uploadedAt).toISOString(),
        etag: String(blob.etag || ''),
      });
    }
    if (page.hasMore) {
      assert.ok(page.cursor && !seenCursors.has(page.cursor), 'Blob pagination did not advance.');
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  raw.sort((left, right) => left.pathname.localeCompare(right.pathname));
  const totalBytes = raw.reduce((sum, blob) => sum + blob.size, 0);
  assert.equal(raw.length, expectedCount, 'Listed Blob count does not match store metadata.');
  assert.equal(totalBytes, expectedBytes, 'Listed Blob bytes do not match store metadata.');

  const categories = Object.fromEntries(ALL_CATEGORIES.map((category) => [category, { objects: 0, bytes: 0, objectIds: [] }]));
  const privateFingerprints = [];
  for (const blob of raw) {
    const category = classifyStoragePathname(blob.pathname);
    const objectId = createHmac('sha256', token).update(`video-os-storage-object/v1\0${blob.pathname}`).digest('hex');
    categories[category].objects += 1;
    categories[category].bytes += blob.size;
    categories[category].objectIds.push(objectId);
    privateFingerprints.push({
      category,
      objectId,
      bytes: blob.size,
      uploadedAt: blob.uploadedAt,
      etagSha256: sha256(blob.etag),
    });
  }
  for (const category of ALL_CATEGORIES) categories[category].objectIds.sort();

  const rawManifest = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    target: { storeId: `store_${shortStoreId(storeId)}`, projectId, environment, access },
    objects: raw,
  };
  const rawManifestSha256 = sha256(canonicalJson(rawManifest));
  const manifestBody = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    target: { storeId: `store_${shortStoreId(storeId)}`, projectId, environment, access },
    verification: {
      credentialBoundToExpectedStore: true,
      allPagesListed: true,
      objectHostsMatchExpectedAccess: true,
      countMatchesStoreMetadata: true,
      bytesMatchStoreMetadata: true,
    },
    totals: { objects: raw.length, bytes: totalBytes },
    categories,
    dispositionReview: {
      evidenceBasis: 'metadata-only',
      unclassifiedObjects: categories.unclassified.objects,
      quarantinedRetainedObjects: categories['quarantined-retained'].objects,
      unresolvedObjects: categories.unclassified.objects + categories['quarantined-retained'].objects,
      unresolvedBytes: categories.unclassified.bytes + categories['quarantined-retained'].bytes,
      quarantineDisposition: 'retain-without-mutation-pending-provenance-and-retention-review',
      migrationVerified: false,
      releaseAuthorized: false,
      destructiveActionsAuthorized: false,
    },
    objectFingerprintScheme: 'HMAC-SHA256 keyed by the store credential; values change after credential rotation',
    rawManifest: {
      retainedOutsideRepository: true,
      objects: raw.length,
      sha256: rawManifestSha256,
    },
    privateFingerprints,
  };
  const manifestSha256 = sha256(canonicalJson(manifestBody));
  const { privateFingerprints: _privateFingerprints, ...publicBody } = manifestBody;
  return {
    sanitized: { ...publicBody, generatedAt, manifestSha256 },
    raw: rawManifest,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    assert.ok(name?.startsWith('--') && argv[index + 1] !== undefined, 'Arguments must be --name value pairs.');
    values[name.slice(2)] = argv[index + 1];
  }
  return values;
}

export async function runStorageInventoryCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const privateRawReport = assertPrivateReportOutsideRepository(args['private-raw-report']);
  assert.ok(args.report, 'A sanitized report path is required.');
  const result = await collectStorageInventory({
    token: env.BLOB_READ_WRITE_TOKEN,
    storeId: args['store-id'],
    access: args.access,
    expectedCount: args['expected-count'],
    expectedBytes: args['expected-bytes'],
    projectId: args['project-id'],
    environment: args.environment,
  });
  await writeFile(privateRawReport, `${JSON.stringify(result.raw, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(args.report), `${JSON.stringify(result.sanitized, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result.sanitized)}\n`);
  return result.sanitized;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runStorageInventoryCli().catch((error) => {
    const safeCode = error?.code === 'EEXIST' ? 'report_already_exists' : 'inventory_failed';
    process.stderr.write(`Storage inventory failed closed: ${safeCode}.\n`);
    process.exitCode = 1;
  });
}
