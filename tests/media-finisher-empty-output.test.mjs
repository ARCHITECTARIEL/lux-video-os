// Neither finishMedia() nor finishMediaWithRemotion() had ANY end-to-end
// test at all before this file -- tests/media-finisher-cinematic-grade.test.mjs
// and tests/remotion-composition.test.mjs only exercise the pure filter-graph
// string builders, never the actual download -> ffmpeg -> upload function
// bodies. That gap hid a real defect: a zero-exit-code FFmpeg process is not
// proof of a usable result. Empirically confirmed against the real ffmpeg
// binary this project ships (ffmpeg-static): `ffmpeg -i src.mp4 -vframes 0
// out.mp4` prints "Output file is empty, nothing was encoded" and still
// exits 0. Before the fix these functions here test for, that empty file
// would have been hashed, uploaded to the customer-facing Blob store, and
// the job marked 'ready' -- delivering a broken video instead of failing
// (and releasing reserved credits) the way services/hyperframes-finisher.js
// already guarded against for its own engine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { finishMedia } from '../services/media-finisher.js';
import { finishMediaWithRemotion } from '../services/remotion-finisher.js';

function realFfmpeg(args) {
  const result = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) throw new Error(`ffmpeg spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr?.toString().slice(-800)}`);
}

// Simulates a real, empirically-reproduced ffmpeg failure mode: the process
// exits 0 (so a bare exit-code check sees "success") but writes an empty file.
async function writesEmptyFileButResolves(args) {
  const output = args[args.length - 1];
  writeFileSync(output, Buffer.alloc(0));
}

function stubDownload(fixturePath) {
  return async (_sourceUrl, target) => {
    const bytes = readFileSync(fixturePath);
    writeFileSync(target, bytes);
    return bytes.length;
  };
}

function unreachablePutBlob() {
  return async () => { throw new Error('putPrivateBlob must not be called when the FFmpeg output failed validation.'); };
}

test('finishMedia and finishMediaWithRemotion reject an empty FFmpeg output instead of uploading it', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'media-finisher-empty-output-test-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const fixture = join(workdir, 'fixture-source.mp4');
  realFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libx264', '-c:a', 'aac', fixture]);

  const job = { id: 'job-empty-1', accountId: 'acct-empty-1', format: 'landscape', title: 'Empty Output Regression' };

  await t.test('finishMedia rejects with FINISH_FFMPEG and never reaches putPrivateBlob', async () => {
    await assert.rejects(
      () => finishMedia(job, 'https://example.test/source.mp4', {
        downloadProviderMedia: stubDownload(fixture),
        runFfmpeg: writesEmptyFileButResolves,
        putPrivateBlob: unreachablePutBlob(),
      }),
      (error) => {
        assert.match(error.message, /empty output/i);
        assert.equal(error.failureCategory, 'FINISH_FFMPEG');
        return true;
      },
    );
  });

  await t.test('finishMediaWithRemotion rejects with FINISH_REMOTION and never reaches putPrivateBlob', async () => {
    await assert.rejects(
      () => finishMediaWithRemotion(job, 'https://example.test/source.mp4', {
        downloadProviderMedia: stubDownload(fixture),
        runFfmpeg: writesEmptyFileButResolves,
        putPrivateBlob: unreachablePutBlob(),
      }),
      (error) => {
        assert.match(error.message, /empty output/i);
        assert.equal(error.failureCategory, 'FINISH_REMOTION');
        return true;
      },
    );
  });

  await t.test('finishMedia still succeeds end-to-end against a real, non-empty FFmpeg run', async () => {
    let uploaded = null;
    const result = await finishMedia(job, 'https://example.test/source.mp4', {
      downloadProviderMedia: stubDownload(fixture),
      putPrivateBlob: async (_classification, pathname, _stream, _options) => {
        uploaded = pathname;
        return { pathname };
      },
    });
    assert.ok(result.bytes > 0);
    assert.equal(uploaded, result.privatePathname);
  });

  await t.test('finishMediaWithRemotion still succeeds end-to-end against a real, non-empty FFmpeg run', async () => {
    let uploaded = null;
    const result = await finishMediaWithRemotion(job, 'https://example.test/source.mp4', {
      downloadProviderMedia: stubDownload(fixture),
      putPrivateBlob: async (_classification, pathname, _stream, _options) => {
        uploaded = pathname;
        return { pathname };
      },
    });
    assert.ok(result.bytes > 0);
    assert.equal(uploaded, result.privatePathname);
  });
});
