import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';

import { PRIVATE_BLOB_CLASSIFICATIONS, assertPrivateBlobWrite, getPrivateBlob, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { inspectMedia } from '../services/final-media-validation.js';
import { captureCreativeBase, creativeBaseRetentionExpiresAt, verifyCreativeBaseForPromotion } from '../services/creative-base-capture.js';

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

test('private creative base capture verifies all stored bytes and never overwrites a conflicting base', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lux-creative-base-'));
  const priorDriver = process.env.STORAGE_DRIVER;
  const priorRoot = process.env.STORAGE_FS_ROOT;
  process.env.STORAGE_DRIVER = 'fs';
  process.env.STORAGE_FS_ROOT = join(root, 'store');
  t.after(async () => {
    if (priorDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = priorDriver;
    if (priorRoot === undefined) delete process.env.STORAGE_FS_ROOT;
    else process.env.STORAGE_FS_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  });
  const firstSource = join(root, 'first.mp4');
  const otherSource = join(root, 'other.mp4');
  makeMedia(firstSource, 'blue');
  makeMedia(otherSource, 'red');
  const firstEvidence = await inspectMedia(firstSource);
  const otherEvidence = await inspectMedia(otherSource);
  const baseId = randomUUID();
  const input = { baseId, sourcePath: firstSource, expectedSha256: firstEvidence.sha256, expectedBytes: firstEvidence.bytes };

  const first = await captureCreativeBase(input);
  assert.equal(first.created, true);
  assert.equal(first.pathname, `video-os/creative-base/${baseId}.mp4`);
  assert.equal(first.sha256, firstEvidence.sha256);
  assert.ok(first.etag);
  const localBytes = await readFile(firstSource);
  const stored = await getPrivateBlob(first.pathname);
  const chunks = [];
  for await (const chunk of stored.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), localBytes);
  assert.deepEqual(await verifyCreativeBaseForPromotion({
    privatePathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: first.etag,
  }), { pathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: first.etag });
  await assert.rejects(verifyCreativeBaseForPromotion({
    privatePathname: first.pathname, sha256: first.sha256, bytes: first.bytes, blobVersion: 'stale-version',
  }), { code: 'CREATIVE_BASE_PROMOTION_READBACK_MISMATCH' });

  const retry = await captureCreativeBase(input);
  assert.equal(retry.created, false);
  assert.equal(retry.etag, first.etag);
  await assert.rejects(
    captureCreativeBase({ baseId, sourcePath: otherSource, expectedSha256: otherEvidence.sha256, expectedBytes: otherEvidence.bytes }),
    { code: 'CREATIVE_BASE_IMMUTABILITY_CONFLICT', statusCode: 409 },
  );
  assert.deepEqual(await readFile(join(process.env.STORAGE_FS_ROOT, ...first.pathname.split('/'))), localBytes);

  await assert.rejects(
    captureCreativeBase({ ...input, expectedSha256: otherEvidence.sha256 }),
    { code: 'CREATIVE_BASE_SOURCE_MISMATCH' },
  );
  await assert.rejects(captureCreativeBase({ ...input, baseId: '../account-id' }), { code: 'CREATIVE_BASE_INPUT_INVALID' });
  await assert.rejects(captureCreativeBase({ ...input, baseId: null }), { code: 'CREATIVE_BASE_INPUT_INVALID' });
  await assert.rejects(captureCreativeBase({ ...input, baseId: baseId.toUpperCase() }), { code: 'CREATIVE_BASE_INPUT_INVALID' });
  assert.throws(() => assertPrivateBlobWrite({
    classification: PRIVATE_BLOB_CLASSIFICATIONS.CREATIVE_BASE,
    pathname: first.pathname,
    access: 'public',
  }));
  assert.throws(() => assertPrivateBlobWrite({
    classification: PRIVATE_BLOB_CLASSIFICATIONS.CREATIVE_BASE,
    pathname: 'video-os/creative-base/customer-name.mp4',
  }));

  // A corrupted newly published version can be deleted only with its own
  // returned etag. A pre-existing conflicting object above survives intact.
  const corruptId = randomUUID();
  const corruptPath = `video-os/creative-base/${corruptId}.mp4`;
  await assert.rejects(captureCreativeBase({ ...input, baseId: corruptId }, {
    putPrivateBlob: async (...args) => {
      const blob = await putPrivateBlob(...args);
      await writeFile(join(process.env.STORAGE_FS_ROOT, ...corruptPath.split('/')), 'corrupted after publication');
      return blob;
    },
  }), { code: 'CREATIVE_BASE_IMMUTABILITY_CONFLICT' });
  assert.equal(await getPrivateBlob(corruptPath), null);

  const lostAckId = randomUUID();
  const lostAck = await captureCreativeBase({ ...input, baseId: lostAckId }, {
    putPrivateBlob: async (...args) => {
      await putPrivateBlob(...args);
      throw new Error('simulated acknowledgement loss');
    },
  });
  assert.equal(lostAck.created, false);
  assert.equal(lostAck.sha256, firstEvidence.sha256);
  await writeFile(join(process.env.STORAGE_FS_ROOT, ...lostAck.pathname.split('/')), 'changed after staging');
  await assert.rejects(verifyCreativeBaseForPromotion({
    privatePathname: lostAck.pathname, sha256: lostAck.sha256,
    bytes: lostAck.bytes, blobVersion: lostAck.etag,
  }), { code: 'CREATIVE_BASE_PROMOTION_READBACK_MISMATCH' });
});

test('creative base retention has a fixed acceptance-based deadline', () => {
  assert.equal(creativeBaseRetentionExpiresAt('2026-10-14T00:00:00.000Z'), '2026-11-13T00:00:00.000Z');
  assert.throws(() => creativeBaseRetentionExpiresAt('invalid'), { code: 'CREATIVE_BASE_ACCEPTANCE_REQUIRED' });
});
