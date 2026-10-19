#!/usr/bin/env node

// Synthetic, local-only proof of the proposed Creative Finish order. This file
// is deliberately not imported by a route, worker, or Workflow.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ffmpegPath from 'ffmpeg-static';
import { inspectMedia } from '../services/final-media-validation.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORMATS = Object.freeze({
  landscape: [640, 360],
  vertical: [360, 640],
  square: [480, 480],
});

const WARM_LUT = [
  'TITLE "Synthetic Warm Proof"',
  'LUT_3D_SIZE 2',
  '0 0 0', '1 0 0', '0.15 0.9 0', '1 0.9 0',
  '0 0 0.65', '1 0 0.65', '0.15 0.9 0.65', '1 0.9 0.65',
  '',
].join('\n');

function runFfmpeg(args, { cwd, binaryOutput = false } = {}) {
  assert.ok(ffmpegPath, 'The installed ffmpeg-static binary is required.');
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...args,
  ], {
    cwd,
    encoding: binaryOutput ? null : 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.error || '').slice(-1000);
    throw new Error(`Synthetic FFmpeg proof failed (${result.status ?? 'spawn'}): ${diagnostic}`);
  }
  return result.stdout;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rgbPixel(file, x, y, cwd) {
  const bytes = runFfmpeg([
    '-ss', '0.5', '-i', file, '-vf', `crop=2:2:${x}:${y},format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ], { cwd, binaryOutput: true });
  assert.ok(bytes.length >= 3, 'The sample frame must decode to RGB.');
  return [...bytes.subarray(0, 3)];
}

function bandRms(file, start, cwd) {
  const bytes = runFfmpeg([
    '-ss', String(start), '-i', file, '-t', '0.25', '-vn',
    '-af', 'bandpass=f=220:width_type=h:width=20',
    '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1',
  ], { cwd, binaryOutput: true });
  let sum = 0;
  const samples = Math.floor(bytes.length / 4);
  assert.ok(samples > 1000, 'The music sample must contain decoded audio.');
  for (let i = 0; i < samples; i += 1) {
    const value = bytes.readFloatLE(i * 4);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function finishGraph(width, height) {
  const boxX = 24;
  const boxHeight = Math.max(44, Math.round(height * 0.12));
  const boxY = height - boxHeight - 20;
  const boxWidth = Math.round(width * 0.45);
  const fontSize = Math.max(24, Math.round(height * 0.06));
  return {
    box: { x: boxX, y: boxY, width: boxWidth, height: boxHeight },
    graph: [
      `[0:v]format=rgb24,lut3d=file='warm.cube',` +
        `drawbox=x=${boxX}:y=${boxY}:w=${boxWidth}:h=${boxHeight}:color=0x12219c:t=fill,` +
        `drawtext=text=LUX:fontcolor=white:fontsize=${fontSize}:x=${boxX + 12}:y=${boxY + 5},` +
        'format=yuv420p[v]',
      '[0:a]asplit=2[voice][side]',
      '[1:a]volume=0.28[music]',
      '[music][side]sidechaincompress=threshold=0.025:ratio=12:attack=5:release=100[duck]',
      '[voice][duck]amix=inputs=2:duration=first:normalize=0[a]',
    ].join(';'),
  };
}

async function renderFormat(format, dimensions, directory) {
  const [width, height] = dimensions;
  const source = `${format}-source.mp4`;
  const finished = `${format}-finished.mp4`;
  runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=0x607080:s=${width}x${height}:r=24:d=3`,
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
    '-filter_complex', '[1:a]adelay=1000,apad=pad_dur=1,atrim=0:3,volume=0.7[voice]',
    '-map', '0:v', '-map', '[voice]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-t', '3', source,
  ], { cwd: directory });

  const { graph, box } = finishGraph(width, height);
  runFfmpeg([
    '-y', '-i', source,
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3',
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-t', '3', '-movflags', '+faststart', finished,
  ], { cwd: directory });

  const sourceInfo = await inspectMedia(join(directory, source));
  const finalInfo = await inspectMedia(join(directory, finished));
  assert.deepEqual([finalInfo.width, finalInfo.height], dimensions);
  assert.equal(finalInfo.videoStreams, 1);
  assert.equal(finalInfo.audioStreams, 1);
  assert.ok(finalInfo.fullDecode);
  assert.ok(Math.abs(finalInfo.durationMs - 3000) <= 250);

  const backdropBefore = rgbPixel(source, 2, 2, directory);
  const backdropAfter = rgbPixel(finished, 2, 2, directory);
  const brandPatch = rgbPixel(finished, box.x + box.width - 12, box.y + Math.round(box.height / 2), directory);
  const musicOutsideSpeech = bandRms(finished, 0.25, directory);
  const musicDuringSpeech = bandRms(finished, 1.25, directory);

  assert.ok(backdropAfter[0] / backdropAfter[2] > (backdropBefore[0] / backdropBefore[2]) * 1.3,
    `Warm LUT should shift the backdrop toward red (${backdropBefore.join(',')} -> ${backdropAfter.join(',')}).`);
  assert.ok(backdropAfter[2] < backdropBefore[2] - 15,
    `Warm LUT should reduce backdrop blue (${backdropBefore.join(',')} -> ${backdropAfter.join(',')}).`);
  assert.ok(Math.abs(brandPatch[0] - 18) < 35 && Math.abs(brandPatch[1] - 33) < 35 && Math.abs(brandPatch[2] - 156) < 40,
    'Brand graphic color should survive grading because overlay follows LUT.');
  assert.ok(musicDuringSpeech < musicOutsideSpeech * 0.8, 'Music should duck under the synthetic speech interval.');

  return {
    format,
    source,
    finished,
    sourceSha256: sourceInfo.sha256,
    finalSha256: finalInfo.sha256,
    bytes: finalInfo.bytes,
    width,
    height,
    durationMs: finalInfo.durationMs,
    videoCodec: finalInfo.videoCodec,
    audioCodec: finalInfo.audioCodec,
    fullDecode: finalInfo.fullDecode,
    backdropBefore,
    backdropAfter,
    brandPatch,
    musicOutsideSpeech,
    musicDuringSpeech,
  };
}

export async function runCreativeFinishLocalProof({ outputParent = join(repoRoot, '.omx', 'artifacts', 'creative-finish') } = {}) {
  await mkdir(outputParent, { recursive: true });
  const directory = await mkdtemp(join(outputParent, 'run-'));
  await writeFile(join(directory, 'warm.cube'), WARM_LUT);
  const formats = [];
  for (const [format, dimensions] of Object.entries(FORMATS)) {
    formats.push(await renderFormat(format, dimensions, directory));
  }
  const lutSha256 = sha256(await readFile(join(directory, 'warm.cube')));
  const receipt = {
    proof: 'creative-finish-local-synthetic-v1',
    scope: 'local-only; synthetic audio/video; no provider, storage, quote, or billing proof',
    directory,
    lutSha256,
    formats,
  };
  await writeFile(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCreativeFinishLocalProof().then((receipt) => {
    process.stdout.write(`${JSON.stringify({ directory: receipt.directory, receipt: join(receipt.directory, 'receipt.json'),
      formats: receipt.formats.map(({ format, finalSha256, bytes }) => ({ format, finalSha256, bytes })) })}\n`);
  }).catch((error) => {
    process.stderr.write(`Creative Finish local proof failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
