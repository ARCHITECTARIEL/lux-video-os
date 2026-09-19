import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercised directly against the driver module (not through
// video-os-private-blob.js's classification policy) since this file is
// specifically proving the storage *mechanics* -- atomic writes, etag
// round-tripping, precondition (ifMatch) enforcement -- are correct for
// VPS/local-filesystem hosting, independent of the policy layer already
// covered by tests/private-blob-policy.test.mjs.
const { del, get, put } = await import('../lib/storage-drivers/fs-blob-driver.js');

test('fs blob driver: put/get/delete round-trip with real files', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fs-blob-driver-test-'));
  const originalRoot = process.env.STORAGE_FS_ROOT;
  process.env.STORAGE_FS_ROOT = root;
  t.after(() => {
    if (originalRoot === undefined) delete process.env.STORAGE_FS_ROOT;
    else process.env.STORAGE_FS_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true });
  });

  await t.test('put then get returns the exact bytes and a stable etag', async () => {
    const written = await put('video-os/uploads/acc/file.bin', Buffer.from('hello world'), { contentType: 'application/octet-stream' });
    assert.match(written.etag, /^[a-f0-9]{64}$/);
    assert.equal(written.size, 11);

    const read = await get('video-os/uploads/acc/file.bin');
    assert.equal(read.blob.etag, written.etag);
    const chunks = [];
    for await (const chunk of read.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'hello world');
  });

  await t.test('get on a missing pathname returns null, not a throw', async () => {
    const missing = await get('video-os/uploads/acc/does-not-exist.bin');
    assert.equal(missing, null);
  });

  await t.test('put accepts a Readable stream body, not just a Buffer', async () => {
    const { Readable } = await import('node:stream');
    const source = Readable.from([Buffer.from('streamed '), Buffer.from('content')]);
    await put('video-os/uploads/acc/streamed.bin', source, {});
    const read = await get('video-os/uploads/acc/streamed.bin');
    const chunks = [];
    for await (const chunk of read.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'streamed content');
  });

  await t.test('ifMatch on put rejects a write against a stale etag', async () => {
    const first = await put('video-os/uploads/acc/versioned.json', Buffer.from('{"v":1}'), {});
    await put('video-os/uploads/acc/versioned.json', Buffer.from('{"v":2}'), { ifMatch: first.etag });
    await assert.rejects(
      put('video-os/uploads/acc/versioned.json', Buffer.from('{"v":3}'), { ifMatch: first.etag }),
      (error) => error.statusCode === 412 && error.name === 'BlobPreconditionFailedError',
    );
  });

  await t.test('ifMatch on delete rejects deleting a since-changed object', async () => {
    const first = await put('video-os/uploads/acc/to-delete.bin', Buffer.from('v1'), {});
    await put('video-os/uploads/acc/to-delete.bin', Buffer.from('v2'), { ifMatch: first.etag });
    await assert.rejects(
      del('video-os/uploads/acc/to-delete.bin', { ifMatch: first.etag }),
      (error) => error.statusCode === 412,
    );
    const result = await del('video-os/uploads/acc/to-delete.bin', {});
    assert.equal(result.deleted, true);
    assert.equal(await get('video-os/uploads/acc/to-delete.bin'), null);
  });

  await t.test('allowOverwrite: false rejects writing over an existing object', async () => {
    await put('video-os/uploads/acc/locked.bin', Buffer.from('first'), {});
    await assert.rejects(
      put('video-os/uploads/acc/locked.bin', Buffer.from('second'), { allowOverwrite: false }),
      (error) => error.statusCode === 409,
    );
  });

  await t.test('a pathname attempting directory traversal is rejected', async () => {
    await assert.rejects(put('video-os/uploads/../../escape.bin', Buffer.from('x'), {}), /Invalid storage pathname/);
  });
});
