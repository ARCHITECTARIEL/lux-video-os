import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MAX_FINISHED_CUSTOMER_VIDEO_BYTES,
  PRIVATE_BLOB_CLASSIFICATIONS,
  getPrivateBlob,
  putPrivateBlob,
} from '../lib/video-os-private-blob.js';

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function finalPath(bytes, name = 'job-1') {
  return `video-os/finals/account-1/${name}-${digest(bytes)}.mp4`;
}

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('finished video storage is content-addressed, bounded, and immutable on real local storage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'immutable-final-storage-'));
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalRoot = process.env.STORAGE_FS_ROOT;
  process.env.STORAGE_DRIVER = 'fs';
  process.env.STORAGE_FS_ROOT = root;
  t.after(() => {
    if (originalDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = originalDriver;
    if (originalRoot === undefined) delete process.env.STORAGE_FS_ROOT;
    else process.env.STORAGE_FS_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('an exact-byte retry succeeds without replacing the canonical object', async () => {
    const bytes = Buffer.from('same finished mp4 bytes');
    const pathname = finalPath(bytes);
    const first = await putPrivateBlob(
      PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
      pathname,
      bytes,
      { contentType: 'video/mp4', allowOverwrite: true },
    );
    // The data object is the publication boundary. Simulate a process exit
    // before its etag sidecar was written and prove retry still hashes bytes.
    rmSync(`${join(root, ...pathname.split('/'))}.etag`, { force: true });
    const retry = await putPrivateBlob(
      PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
      pathname,
      bytes,
      { contentType: 'video/mp4', allowOverwrite: true, ifMatch: 'caller-cannot-enable-overwrite' },
    );

    assert.equal(first.pathname, pathname);
    assert.equal(retry.pathname, pathname);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.etag, first.etag);
    const stored = await getPrivateBlob(pathname);
    assert.deepEqual(await streamBytes(stored.stream), bytes);
  });

  await t.test('a corrupt pre-existing canonical object fails closed after hashing actual bytes', async () => {
    const expected = Buffer.from('expected immutable bytes');
    const pathname = finalPath(expected, 'job-corrupt');
    await putPrivateBlob(
      PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
      pathname,
      expected,
      { contentType: 'video/mp4' },
    );
    writeFileSync(join(root, ...pathname.split('/')), Buffer.from('corrupt bytes'));

    await assert.rejects(
      putPrivateBlob(
        PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
        pathname,
        expected,
        { contentType: 'video/mp4', allowOverwrite: true },
      ),
      (error) => {
        assert.equal(error.code, 'FINISHED_VIDEO_IMMUTABILITY_CONFLICT');
        assert.equal(error.statusCode, 409);
        assert.equal(error.message, 'Stored finished video does not match the submitted bytes.');
        assert.doesNotMatch(error.message, /job-corrupt|expected|corrupt/i);
        return true;
      },
    );
    assert.deepEqual(
      await streamBytes((await getPrivateBlob(pathname)).stream),
      Buffer.from('corrupt bytes'),
    );
  });

  await t.test('pathname hash mismatch is rejected before any object is written', async () => {
    const bytes = Buffer.from('real bytes');
    const pathname = finalPath(Buffer.from('different bytes'), 'job-mismatch');
    await assert.rejects(
      putPrivateBlob(
        PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
        pathname,
        bytes,
        { contentType: 'video/mp4' },
      ),
      (error) => error.code === 'FINISHED_VIDEO_HASH_MISMATCH' && error.statusCode === 422,
    );
    assert.equal(await getPrivateBlob(pathname), null);
  });

  await t.test('streamed bodies are rejected as soon as they exceed 100 MiB', async () => {
    const oneMiB = Buffer.alloc(1024 * 1024, 0x61);
    async function* oversized() {
      for (let index = 0; index <= 100; index += 1) yield oneMiB;
    }

    const placeholderHash = '0'.repeat(64);
    await assert.rejects(
      putPrivateBlob(
        PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
        `video-os/finals/account-1/job-too-large-${placeholderHash}.mp4`,
        oversized(),
        { contentType: 'video/mp4' },
      ),
      (error) => error.code === 'FINISHED_VIDEO_TOO_LARGE' && error.statusCode === 413,
    );
    assert.equal(MAX_FINISHED_CUSTOMER_VIDEO_BYTES, 100 * 1024 * 1024);
  });
});
