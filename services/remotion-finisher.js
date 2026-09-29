import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { downloadProviderMedia, hashFile } from './media-finisher.js';

export const REMOTION_VERSION = '4.0.0';
export const REMOTION_COMPOSITION_ID = 'lux-remotion-finisher';

const safeName = (value) => String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';

function dimensions(format) {
  if (format === 'portrait') return [1080, 1920];
  if (format === 'square') return [1080, 1080];
  return [1920, 1080];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`Remotion FFmpeg engine exited ${code}: ${stderr.slice(-900)}`), { failureCategory: 'FINISH_REMOTION' })));
  });
}

export function buildRemotionFilterGraph(width, height, options = {}) {
  const isPortrait = height > width;
  const boxHeight = Math.max(70, Math.floor(height * 0.08));
  const boxY = height - boxHeight - Math.floor(height * 0.06);
  const boxWidth = Math.floor(width * 0.55);
  const boxX = Math.floor(width * 0.05);

  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
    'eq=saturation=1.12:contrast=1.05',
    `drawbox=x=0:y=0:w=12:h=ih:color=0x12219c@0.85:t=fill`,
    `drawbox=x=${boxX}:y=${boxY}:w=${boxWidth}:h=${boxHeight}:color=0x071018@0.82:t=fill:enable='between(t,1,7)'`,
    `drawbox=x=${boxX}:y=${boxY}:w=6:h=${boxHeight}:color=0x38bdf8@0.95:t=fill:enable='between(t,1,7)'`,
    'format=yuv420p',
  ].join(',');
}

export async function finishMediaWithRemotion(job, sourceUrl, dependencies = {}) {
  if (!ffmpegPath) throw Object.assign(new Error('Remotion render compute is unavailable.'), { failureCategory: 'CONFIG_MISSING' });
  const [width, height] = dimensions(job.format);
  const workdir = join('/tmp', `video-os-remotion-${safeName(job.id)}`);
  await mkdir(workdir, { recursive: true });
  const input = join(workdir, 'source.mp4');
  const output = join(workdir, 'final.mp4');

  const download = dependencies.downloadProviderMedia || downloadProviderMedia;
  const putBlob = dependencies.putPrivateBlob || putPrivateBlob;
  const runner = dependencies.runFfmpeg || runFfmpeg;

  try {
    const sourceBytes = await download(sourceUrl, input);
    const startedAt = Date.now();
    const vf = buildRemotionFilterGraph(width, height, {
      presenterTitle: job.input?.avatar?.name || job.title,
      presenterSubtitle: 'LUX Video OS'
    });

    await runner([
      '-y', '-i', input,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      output
    ]);

    const info = await stat(output);
    // See services/media-finisher.js's finishMedia for why this can't be
    // skipped: a zero-exit FFmpeg run is not proof of a usable result.
    if (!info.size) throw Object.assign(new Error('Remotion FFmpeg engine produced an empty output file.'), { failureCategory: 'FINISH_REMOTION' });
    const sha256 = await hashFile(output);
    const pathname = `video-os/finals/${safeName(job.accountId)}/${safeName(job.id)}-${sha256}.mp4`;

    const blob = await putBlob(
      PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
      pathname,
      createReadStream(output),
      { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true }
    );

    return {
      privatePathname: blob.pathname,
      bytes: info.size,
      sha256,
      sourceBytes,
      width,
      height,
      filename: `${safeName(job.title)}-${job.format}.mp4`,
      compositionEngine: 'remotion',
      compositionEngineVersion: REMOTION_VERSION,
      compositionId: REMOTION_COMPOSITION_ID,
      renderCompute: 'remotion-ffmpeg',
      renderMs: Date.now() - startedAt,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
