import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';

import { isCreativeBasePathname } from '../lib/creative-finish-contract.js';
import { inspectMedia } from '../services/final-media-validation.js';
import { captureCreativeBase, creativeBaseRetentionExpiresAt, verifyCreativeBaseForPromotion } from '../services/creative-base-capture.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function makeMedia(output, color) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:r=5:d=0.8`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=0.8',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest', '-movflags', '+faststart', output,
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, String(result.stderr).slice(-500));
}

function offlinePrivateStorage() {
  const objects = new Map();
  let putBodyReads = 0;

  async function bodyBuffer(body) {
    const chunks = [];
    for await (const chunk of body) {
      putBodyReads += 1;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  return {
    async putPrivateObject(pathname, body, options = {}) {
      assert.equal(isCreativeBasePathname(pathname), true);
      assert.equal(options.allowOverwrite, false);
      if (objects.has(pathname)) {
        throw Object.assign(new Error('Object already exists.'), { statusCode: 409, code: 'EEXIST' });
      }
      const bytes = await bodyBuffer(body);
      const etag = digest(bytes);
      objects.set(pathname, { bytes, etag });
      return { pathname, etag, size: bytes.length, contentType: options.contentType };
    },

    async getPrivateObject(pathname) {
      const object = objects.get(pathname);
      if (!object) return null;
      return {
        blob: { pathname, etag: object.etag },
        stream: Readable.from([Buffer.from(object.bytes)]),
      };
    },

    async deletePrivateObject(pathname, { ifMatch } = {}) {
      const object = objects.get(pathname);
      if (object && object.etag !== ifMatch) {
        throw Object.assign(new Error('Object version changed.'), { statusCode: 412 });
      }
      objects.delete(pathname);
      return { deleted: true };
    },

    seed(pathname, bytes, etag = digest(bytes)) {
      objects.set(pathname, { bytes: Buffer.from(bytes), etag });
    },

    overwrite(pathname, bytes, { preserveEtag = false } = {}) {
      const prior = objects.get(pathname);
      const next = Buffer.from(bytes);
      objects.set(pathname, {
        bytes: next,
        etag: preserveEtag && prior ? prior.etag : digest(next),
      });
    },

    storedBytes(pathname) {
      return objects.has(pathname) ? Buffer.from(objects.get(pathname).bytes) : null;
    },

    has(pathname) {
      return objects.has(pathname);
    },

    get putBodyReads() {
      return putBodyReads;
    },
  };
}

test('offline creative base capture verifies all stored bytes and never overwrites a conflicting base', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lux-creative-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const firstSource = join(root, 'first.mp4');
  const otherSource = join(root, 'other.mp4');
  makeMedia(firstSource, 'blue');
  makeMedia(otherSource, 'red');
  const firstEvidence = await inspectMedia(firstSource);
  const otherEvidence = await inspectMedia(otherSource);
  const localBytes = await readFile(firstSource);
  const storage = offlinePrivateStorage();
  const baseId = randomUUID();
  const input = { baseId, sourcePath: firstSource, expectedSha256: firstEvidence.sha256, expectedBytes: firstEvidence.bytes };

  const first = await captureCreativeBase(input, storage);
  assert.equal(first.created, true);
  assert.equal(first.pathname, `video-os/creative-base/${baseId}.mp4`);
  assert.equal(first.sha256, firstEvidence.sha256);
  assert.ok(first.etag);
  assert.deepEqual(storage.storedBytes(first.pathname), localBytes);
  assert.deepEqual(await verifyCreativeBaseForPromotion({
    privatePathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: first.etag,
  }, storage), { pathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: first.etag });
  await assert.rejects(verifyCreativeBaseForPromotion({
    privatePathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: 'stale-version',
  }, storage), { code: 'CREATIVE_BASE_PROMOTION_READBACK_MISMATCH' });

  const readsBeforeConflict = storage.putBodyReads;
  const retry = await captureCreativeBase(input, storage);
  assert.equal(retry.created, false);
  assert.equal(retry.etag, first.etag);
  assert.equal(storage.putBodyReads, readsBeforeConflict,
    'an immutable conflict must be handled even when the adapter rejects before consuming the body');

  await assert.rejects(
    captureCreativeBase({
      baseId, sourcePath: otherSource,
      expectedSha256: otherEvidence.sha256, expectedBytes: otherEvidence.bytes,
    }, storage),
    { code: 'CREATIVE_BASE_IMMUTABILITY_CONFLICT', statusCode: 409 },
  );
  assert.deepEqual(storage.storedBytes(first.pathname), localBytes);

  await assert.rejects(
    captureCreativeBase({ ...input, expectedSha256: otherEvidence.sha256 }, storage),
    { code: 'CREATIVE_BASE_SOURCE_MISMATCH' },
  );
  await assert.rejects(captureCreativeBase({ ...input, baseId: '../account-id' }, storage),
    { code: 'CREATIVE_BASE_INPUT_INVALID' });
  await assert.rejects(captureCreativeBase({ ...input, baseId: null }, storage),
    { code: 'CREATIVE_BASE_INPUT_INVALID' });
  await assert.rejects(captureCreativeBase({ ...input, baseId: baseId.toUpperCase() }, storage),
    { code: 'CREATIVE_BASE_INPUT_INVALID' });
  await assert.rejects(captureCreativeBase(input), { name: 'TypeError' });
  await assert.rejects(verifyCreativeBaseForPromotion({
    privatePathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: first.etag,
  }), { name: 'TypeError' });

  // A corrupted newly published version can be deleted only with its own
  // returned etag. A pre-existing conflicting object above survives intact.
  const corruptId = randomUUID();
  const corruptPath = `video-os/creative-base/${corruptId}.mp4`;
  await assert.rejects(captureCreativeBase({ ...input, baseId: corruptId }, {
    ...storage,
    putPrivateObject: async (...args) => {
      const blob = await storage.putPrivateObject(...args);
      storage.overwrite(corruptPath, 'corrupted after publication', { preserveEtag: true });
      return blob;
    },
  }), { code: 'CREATIVE_BASE_IMMUTABILITY_CONFLICT' });
  assert.equal(storage.has(corruptPath), false);

  const lostAckId = randomUUID();
  const lostAck = await captureCreativeBase({ ...input, baseId: lostAckId }, {
    ...storage,
    putPrivateObject: async (...args) => {
      await storage.putPrivateObject(...args);
      throw new Error('simulated acknowledgement loss');
    },
  });
  assert.equal(lostAck.created, false);
  assert.equal(lostAck.sha256, firstEvidence.sha256);
  storage.overwrite(lostAck.pathname, 'changed after staging');
  await assert.rejects(verifyCreativeBaseForPromotion({
    privatePathname: lostAck.pathname, sha256: lostAck.sha256,
    bytes: lostAck.bytes, blobVersion: lostAck.etag,
  }, storage), { code: 'CREATIVE_BASE_PROMOTION_READBACK_MISMATCH' });
});

test('creative base retention has a fixed acceptance-based deadline', () => {
  assert.equal(creativeBaseRetentionExpiresAt('2026-10-14T00:00:00.000Z'), '2026-11-13T00:00:00.000Z');
  assert.throws(() => creativeBaseRetentionExpiresAt('invalid'), { code: 'CREATIVE_BASE_ACCEPTANCE_REQUIRED' });
});
