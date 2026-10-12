import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEnrollmentHandler } from '../routes/video-os-lite/enrollments.js';

const IDS = Object.freeze({
  account: 'source-preview-owner',
  enrollment: '11111111-1111-4111-8111-111111111111',
});
const SOURCE_BYTES = Buffer.from('exact private phone-video bytes');
const SOURCE_SHA256 = createHash('sha256').update(SOURCE_BYTES).digest('hex');

function enrollment(overrides = {}) {
  return {
    id: IDS.enrollment,
    accountId: IDS.account,
    status: 'AWAITING_EXTRACTION_CONSENT',
    uploadPathname: 'video-os/enrollment-sources/owner/source.mov',
    uploadEtag: 'etag-exact-source',
    sourceBytes: SOURCE_BYTES.length,
    sourceSha256: SOURCE_SHA256,
    sourceMetadata: { mimeType: 'video/quicktime' },
    declaredContentType: 'video/quicktime',
    revokedAt: null,
    sourceDeletedAt: null,
    ...overrides,
  };
}

function request() {
  return {
    method: 'GET',
    url: '/api/video-os-lite/enrollments?enrollmentId=' + IDS.enrollment + '&preview=video',
    headers: {},
  };
}

function response(onSetHeader = () => {}) {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      onSetHeader(name, value);
      this.headers[name] = String(value);
    },
    write(value) { this.chunks.push(Buffer.from(value)); return true; },
    end(raw) {
      if (raw !== undefined) this.body = JSON.parse(Buffer.from(raw).toString('utf8'));
      this.ended = true;
    },
    destroy() { this.destroyed = true; },
  };
}

function stored(stream, record = enrollment(), blob = {}) {
  return {
    stream,
    blob: {
      pathname: record.uploadPathname,
      etag: record.uploadEtag,
      size: record.sourceBytes,
      ...blob,
    },
  };
}

async function tempHarness(t) {
  const root = await mkdtemp(join(tmpdir(), 'lux-video-os-preview-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    createEnrollmentPreviewTempDirectory: () => mkdtemp(join(root, 'materialized-')),
    assertClean: async () => assert.deepEqual(await readdir(root), []),
  };
}

function handlerFor({ record = enrollment(), privateBlob, createEnrollmentPreviewTempDirectory }) {
  return createEnrollmentHandler({
    sessionFromRequest: () => ({ accountId: IDS.account }),
    getOwnedEnrollment: async (accountId, enrollmentId) => (
      accountId === record.accountId && enrollmentId === record.id ? record : null
    ),
    getPrivateBlob: async () => privateBlob,
    createEnrollmentPreviewTempDirectory,
  });
}

test('source preview hashes the complete private stream before sending media headers and removes its temp file', async t => {
  const temp = await tempHarness(t);
  let sourceFinished = false;
  const source = {
    async *[Symbol.asyncIterator]() {
      yield SOURCE_BYTES.subarray(0, 9);
      yield SOURCE_BYTES.subarray(9);
      sourceFinished = true;
    },
    destroy() {},
  };
  const res = response(() => assert.equal(sourceFinished, true, 'media headers must follow full source verification'));
  await handlerFor({
    privateBlob: stored(source),
    createEnrollmentPreviewTempDirectory: temp.createEnrollmentPreviewTempDirectory,
  })(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), SOURCE_BYTES);
  assert.equal(res.headers['Content-Type'], 'video/quicktime');
  assert.equal(res.headers['Content-Length'], String(SOURCE_BYTES.length));
  assert.equal(res.headers['Content-Disposition'], undefined);
  assert.equal(res.headers.Location, undefined);
  assert.equal(JSON.stringify(res).includes('video-os/enrollment-sources'), false);
  await temp.assertClean();
});

test('same-length corrupt source video is rejected before media headers and removes its temp file', async t => {
  const temp = await tempHarness(t);
  const corrupt = Buffer.from(SOURCE_BYTES);
  corrupt[0] ^= 0xff;
  const res = response();
  await handlerFor({
    privateBlob: stored({ async *[Symbol.asyncIterator]() { yield corrupt; }, destroy() {} }),
    createEnrollmentPreviewTempDirectory: temp.createEnrollmentPreviewTempDirectory,
  })(request(), res);

  assert.equal(res.statusCode, 410);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Content-Length'], undefined);
  assert.deepEqual(res.chunks, []);
  assert.match(res.body.error, /unavailable/i);
  await temp.assertClean();
});

test('source preview preserves exact pathname and ETag gates before temp-file creation', async t => {
  for (const scenario of [
    { name: 'wrong pathname', blob: { pathname: 'video-os/enrollment-sources/owner/wrong.mov' } },
    { name: 'wrong ETag', blob: { etag: 'etag-wrong-source' } },
  ]) {
    await t.test(scenario.name, async () => {
      let cancelled = 0;
      let tempDirectories = 0;
      const source = { destroy() { cancelled += 1; } };
      const res = response();
      await handlerFor({
        privateBlob: stored(source, enrollment(), scenario.blob),
        createEnrollmentPreviewTempDirectory: async () => { tempDirectories += 1; throw new Error('must not materialize'); },
      })(request(), res);
      assert.equal(res.statusCode, 410);
      assert.equal(cancelled, 1);
      assert.equal(tempDirectories, 0);
      assert.equal(res.headers['Content-Length'], undefined);
    });
  }
});

test('source read errors remove the partial temp file before returning unavailable', async t => {
  const temp = await tempHarness(t);
  let cancelled = 0;
  const source = {
    async *[Symbol.asyncIterator]() {
      yield SOURCE_BYTES.subarray(0, 7);
      throw new Error('private source read failed');
    },
    destroy() { cancelled += 1; },
  };
  const res = response();
  await handlerFor({
    privateBlob: stored(source),
    createEnrollmentPreviewTempDirectory: temp.createEnrollmentPreviewTempDirectory,
  })(request(), res);
  assert.equal(res.statusCode, 410);
  assert.equal(cancelled, 1);
  await temp.assertClean();
});

test('client abort during verification cancels the source and removes the partial temp file without headers', async t => {
  const temp = await tempHarness(t);
  const res = new EventEmitter();
  res.setHeader = () => assert.fail('an aborted preverification response must not send headers');
  res.write = () => assert.fail('an aborted preverification response must not send bytes');
  res.end = () => assert.fail('an aborted preverification response must not end as success');
  res.destroy = () => { res.destroyed = true; };
  let cancelled = 0;
  const source = {
    async *[Symbol.asyncIterator]() {
      yield SOURCE_BYTES.subarray(0, 8);
      res.emit('close');
      yield SOURCE_BYTES.subarray(8);
    },
    destroy() { cancelled += 1; },
  };
  await handlerFor({
    privateBlob: stored(source),
    createEnrollmentPreviewTempDirectory: temp.createEnrollmentPreviewTempDirectory,
  })(request(), res);

  assert.equal(res.statusCode, undefined);
  assert.ok(cancelled >= 1);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('error'), 0);
  await temp.assertClean();
});
