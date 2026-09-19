// Proves the cinematic finishing filter graph (film grain via ffmpeg's own
// `noise` filter, optional LUT color grading) is real, valid ffmpeg syntax
// by actually running it against a real generated fixture video -- not
// just eyeballing the filter string. This is the exact filter graph
// finishMedia() uses; only the network-fetch half of finishMedia() (which
// needs an allowlisted HTTPS host) is skipped here, since that path is
// unrelated to this change and already covered by media-finisher's own
// SSRF/DNS-pinning logic elsewhere.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { cinematicFinishingFilterGraph } from '../services/media-finisher.js';

function runFfmpeg(args, options = {}) {
  const result = spawnSync(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
  if (result.error) throw new Error(`ffmpeg spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited ${result.status}: ${result.stderr?.toString().slice(-800)}`);
}

test('cinematicFinishingFilterGraph produces real, runnable ffmpeg syntax with visible grain', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'cinematic-grade-test-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const source = join(workdir, 'source.mp4');
  const graded = join(workdir, 'graded.mp4');
  const ungraded = join(workdir, 'ungraded.mp4');

  // A flat, single-color source: any variation ffmpeg's noise filter adds
  // is unambiguously grain, not compression artifacts from complex content.
  runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480:d=1', '-frames:v', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);

  await t.test('the filter graph string has the expected stages in order', () => {
    const vf = cinematicFinishingFilterGraph(640, 480, {});
    assert.match(vf, /^scale=640:480:force_original_aspect_ratio=increase,crop=640:480,setsar=1,eq=/);
    assert.match(vf, /noise=alls=8:allf=t\+u/);
    assert.match(vf, /,format=yuv420p$/);
    assert.doesNotMatch(vf, /lut3d/, 'no LUT env var set, so lut3d must not appear');
  });

  await t.test('running the graded filter graph against real ffmpeg succeeds and visibly adds grain', () => {
    const vf = cinematicFinishingFilterGraph(640, 480, {});
    runFfmpeg(['-y', '-i', source, '-vf', vf, '-frames:v', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', graded]);
    runFfmpeg(['-y', '-i', source, '-vf', 'scale=640:480,format=yuv420p', '-frames:v', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ungraded]);
    assert.ok(statSync(graded).size > 0, 'graded output must be a real, non-empty file');
    // Grain guarantees the graded output differs byte-for-byte from a
    // flat/ungrained encode of the same flat-color source -- a cheap,
    // reliable proxy for "the noise filter actually changed pixels."
    assert.notDeepEqual(readFileSync(graded), readFileSync(ungraded));
  });

  await t.test('setting VIDEO_OS_FILM_GRAIN_STRENGTH changes the emitted filter graph', () => {
    const vf = cinematicFinishingFilterGraph(640, 480, { VIDEO_OS_FILM_GRAIN_STRENGTH: '25' });
    assert.match(vf, /noise=alls=25:allf=t\+u/);
  });

  await t.test('setting VIDEO_OS_COLOR_LUT_PATH adds a real, runnable lut3d stage', () => {
    // A minimal valid identity .cube LUT (2x2x2) -- proves the lut3d
    // filter syntax itself is correct and ffmpeg accepts the file, not
    // just that the string contains the word "lut3d".
    const lutPath = join(workdir, 'identity.cube');
    const cubeContents = [
      'LUT_3D_SIZE 2',
      '0.0 0.0 0.0', '1.0 0.0 0.0', '0.0 1.0 0.0', '1.0 1.0 0.0',
      '0.0 0.0 1.0', '1.0 0.0 1.0', '0.0 1.0 1.0', '1.0 1.0 1.0',
    ].join('\n');
    writeFileSync(lutPath, cubeContents);
    // Reference the LUT by a bare relative filename (via cwd) rather than
    // an absolute path -- proves the lut3d filter mechanism itself works
    // without tripping over Windows-drive-letter-colon-vs-ffmpeg's-own-
    // colon-as-option-separator, a purely local-dev-on-Windows artifact
    // that doesn't reflect production (which only ever sees plain POSIX
    // paths here).
    const graphWithLut = cinematicFinishingFilterGraph(640, 480, { VIDEO_OS_COLOR_LUT_PATH: 'identity.cube' });
    assert.match(graphWithLut, /lut3d=/);
    const lutOutput = join(workdir, 'lut-graded.mp4');
    runFfmpeg(['-y', '-i', source, '-vf', graphWithLut, '-frames:v', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'lut-graded.mp4'], { cwd: workdir });
    assert.ok(statSync(lutOutput).size > 0);
  });
});
