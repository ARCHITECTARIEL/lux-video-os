import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertPrivateReportOutsideRepository,
  classifyStoragePathname,
  collectStorageInventory,
} from '../tools/inventory-release-storage.mjs';

const token = 'vercel_blob_rw_TestStore_secret-value';
const base = {
  token,
  storeId: 'store_TestStore',
  access: 'private',
  expectedCount: 2,
  expectedBytes: 30,
  projectId: 'prj_TestProject',
  environment: 'production',
  generatedAt: '2026-09-30T00:00:00.000Z',
};

function blob(pathname, size, etag = `etag-${size}`) {
  return {
    pathname,
    size,
    etag,
    uploadedAt: '2026-09-30T00:00:00.000Z',
    url: `https://teststore.private.blob.vercel-storage.com/${pathname.split('/').map(encodeURIComponent).join('/')}`,
  };
}

test('classifies every governed storage prefix and keeps unknowns explicit', () => {
  const expected = new Map([
    ['video-os/accounts/a.json', 'account-state'],
    ['video-os/auth/a.json', 'authentication-state'],
    ['video-os/rate/a.json', 'rate-limit-state'],
    ['video-os/uploads/a.mp4', 'customer-upload'],
    ['video-os/finals/a.mp4', 'finished-customer-video'],
    ['video-os/jobs/a.json', 'job-state'],
    ['video-os/credit-state/a.json', 'credit-state'],
    ['video-os/stripe-events/a.json', 'stripe-event'],
    ['video-os/recovery-receipts/a.json', 'recovery-receipt'],
    ['video-os/new-prefix/a.json', 'unclassified'],
  ]);
  for (const [pathname, category] of expected) assert.equal(classifyStoragePathname(pathname), category);
});

test('produces a deterministic sanitized inventory without raw names or URLs', async () => {
  const alice = blob('video-os/uploads/alice@example.com/source.mp4', 10);
  const job = blob('video-os/jobs/customer-job-id.json', 20);
  const first = await collectStorageInventory({ ...base, listPage: async () => ({ blobs: [alice, job], hasMore: false }) });
  const second = await collectStorageInventory({ ...base, listPage: async () => ({ blobs: [job, alice], hasMore: false }) });
  assert.deepEqual(first.sanitized, second.sanitized);
  assert.equal(first.sanitized.manifestSha256.length, 64);
  assert.equal(first.sanitized.rawManifest.sha256.length, 64);
  assert.equal(first.sanitized.categories['customer-upload'].objects, 1);
  assert.equal(first.sanitized.categories['job-state'].bytes, 20);
  assert.equal(first.sanitized.categories['customer-upload'].objectIds[0].length, 64);
  const published = JSON.stringify(first.sanitized);
  assert.doesNotMatch(published, /alice|customer-job-id|blob\.vercel-storage|pathname|etag-/i);
  assert.match(JSON.stringify(first.raw), /alice@example\.com/);
});

test('paginates once, rejects duplicate pathnames, and requires advancing cursors', async () => {
  const pages = [
    { blobs: [blob('video-os/accounts/a.json', 10)], hasMore: true, cursor: 'next' },
    { blobs: [blob('video-os/auth/b.json', 20)], hasMore: false },
  ];
  let calls = 0;
  const result = await collectStorageInventory({ ...base, listPage: async () => pages[calls++] });
  assert.equal(calls, 2);
  assert.equal(result.sanitized.totals.objects, 2);

  await assert.rejects(
    collectStorageInventory({ ...base, listPage: async () => ({ blobs: [blob('video-os/accounts/a.json', 10), blob('video-os/accounts/a.json', 20)], hasMore: false }) }),
    /duplicate pathname/,
  );
  await assert.rejects(
    collectStorageInventory({ ...base, listPage: async () => ({ blobs: [], hasMore: true, cursor: undefined }) }),
    /pagination did not advance/,
  );
});

test('fails closed for wrong credentials, access, count, bytes, or URL pathname', async () => {
  const good = [blob('video-os/accounts/a.json', 10), blob('video-os/auth/b.json', 20)];
  await assert.rejects(collectStorageInventory({ ...base, token: 'vercel_blob_rw_OtherStore_secret', listPage: async () => ({ blobs: good, hasMore: false }) }), /does not target/);
  await assert.rejects(collectStorageInventory({ ...base, access: 'public', listPage: async () => ({ blobs: good, hasMore: false }) }), /access\/store/);
  await assert.rejects(collectStorageInventory({ ...base, expectedCount: 3, listPage: async () => ({ blobs: good, hasMore: false }) }), /count does not match/);
  await assert.rejects(collectStorageInventory({ ...base, expectedBytes: 31, listPage: async () => ({ blobs: good, hasMore: false }) }), /bytes do not match/);
  const badPath = { ...good[0], url: 'https://teststore.private.blob.vercel-storage.com/different.json' };
  await assert.rejects(collectStorageInventory({ ...base, expectedCount: 1, expectedBytes: 10, listPage: async () => ({ blobs: [badPath], hasMore: false }) }), /pathname does not match/);
});

test('requires private raw evidence to stay outside the repository', () => {
  assert.throws(() => assertPrivateReportOutsideRepository('relative.json'), /must be absolute/);
  assert.throws(() => assertPrivateReportOutsideRepository(resolve('docs/raw.json')), /outside the repository/);
  const external = resolve(tmpdir(), 'video-os-private-evidence.json');
  assert.equal(assertPrivateReportOutsideRepository(external), external);
});
