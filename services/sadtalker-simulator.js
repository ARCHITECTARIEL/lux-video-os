// Local SIMULATION-mode Standard renderer (MASTER_SPEC.md 0.2: SIMULATION -> CANARY
// -> PRODUCTION). This is NOT SadTalker and performs no lip-sync inference -- it
// composes the account's own authorized portrait and narration audio into a real,
// valid MP4 (still image + real audio track) so the full pipeline (consent, quote,
// reservation, durable workflow, private storage, settlement, download) can be
// built and tested end to end without GPU/RunPod access. Swap this module for the
// real worker adapter before any CANARY or PRODUCTION execution; never present its
// output as genuine SadTalker inference to an owner or customer.
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from '@vercel/blob';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';

const safeName = (value) => String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';

function dimensions(format) {
  if (format === 'landscape') return [1920, 1080];
  if (format === 'square') return [1080, 1080];
  return [1080, 1920];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(`FFmpeg exited ${code}: ${stderr.slice(-900)}`), { failureCategory: 'FINISH_FFMPEG' }))));
  });
}

async function hashFile(path) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchOwnedAssetBytes(pathname) {
  const result = await get(pathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN, useCache: false });
  if (!result?.stream) throw Object.assign(new Error('Standard render source asset is unavailable.'), { statusCode: 410, failureCategory: 'PERSISTENCE' });
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

// input matches the shape validated by parseSadtalkerStageAInput (see
// db/standard-narration-repository.js's resolveSources): { jobId, accountId,
// correlationId, portrait: {assetId, mimeType, ...}, drivenAudio: {assetId,
// mimeType, ...} } plus the actual private asset records to read bytes from.
export async function renderStandardSimulation(input, assets, { format = 'vertical', title = 'video-os' } = {}) {
  if (!ffmpegPath) throw Object.assign(new Error('FFmpeg is unavailable.'), { failureCategory: 'CONFIG_MISSING' });
  const [width, height] = dimensions(format);
  const workdir = join('/tmp', `standard-render-${safeName(input.jobId)}`);
  await mkdir(workdir, { recursive: true });
  const portraitExt = assets.portrait.contentType === 'image/png' ? '.png' : '.jpg';
  const audioExt = assets.drivenAudio.contentType === 'audio/wav' || assets.drivenAudio.contentType === 'audio/x-wav' ? '.wav' : '.audio';
  const portraitPath = join(workdir, `portrait${portraitExt}`);
  const audioPath = join(workdir, `audio${audioExt}`);
  const output = join(workdir, 'final.mp4');
  try {
    const [portraitBytes, audioBytes] = await Promise.all([
      fetchOwnedAssetBytes(assets.portrait.privatePathname),
      fetchOwnedAssetBytes(assets.drivenAudio.privatePathname),
    ]);
    await Promise.all([writeFile(portraitPath, portraitBytes), writeFile(audioPath, audioBytes)]);
    const startedAt = Date.now();
    const vf = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, 'setsar=1', 'format=yuv420p'].join(',');
    await runFfmpeg(['-y', '-loop', '1', '-i', portraitPath, '-i', audioPath, '-vf', vf, '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', output]);
    const [info, sha256] = await Promise.all([stat(output), hashFile(output)]);
    const pathname = `video-os/finals/${safeName(input.accountId)}/${safeName(input.jobId)}-${sha256}.mp4`;
    const blob = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, createReadStream(output), { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
    return {
      privatePathname: blob.pathname, bytes: info.size, sha256, ffmpegMs: Date.now() - startedAt, width, height,
      filename: `${safeName(title)}-${format}.mp4`,
      simulation: true,
      adapter: 'standard-sadtalker-local',
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
