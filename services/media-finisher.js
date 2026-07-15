import { put } from '@vercel/blob';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { assertAllowedMediaUrl, assertPublicDns } from '../lib/video-os-security.js';

const boundedNumber = (value, fallback, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number.isFinite(Number(value)) ? Number(value) : fallback));
const maxBytes = () => boundedNumber(process.env.VIDEO_OS_MAX_SOURCE_BYTES, 250_000_000, 1_000_000, 500_000_000);
const timeoutMs = () => boundedNumber(process.env.VIDEO_OS_SOURCE_TIMEOUT_MS, 60_000, 5_000, 120_000);
const safeName = (value) => String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';

async function downloadPinned(sourceUrl, target) {
  const url = assertAllowedMediaUrl(sourceUrl);
  const [pinned] = await assertPublicDns(url);
  let response;
  let request;
  const deadline = setTimeout(() => {
    const error = Object.assign(new Error('Provider media exceeded the absolute deadline.'), { failureCategory: 'SOURCE_TIMEOUT' });
    response?.destroy(error);
    request?.destroy(error);
  }, timeoutMs());
  try {
    response = await new Promise((resolve, reject) => {
    request = https.get(url, { timeout: timeoutMs(), lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family) }, resolve);
    request.on('timeout', () => request.destroy(Object.assign(new Error('Provider media timed out.'), { failureCategory: 'SOURCE_TIMEOUT' })));
    request.on('error', reject);
  });
  if (response.statusCode >= 300 && response.statusCode < 400) throw Object.assign(new Error('Provider redirects are denied.'), { failureCategory: 'SOURCE_POLICY' });
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error(`Provider media HTTP ${response.statusCode}.`), { failureCategory: 'SOURCE_POLICY' });
  const declared = Number(response.headers['content-length'] || 0);
  if (declared > maxBytes()) throw Object.assign(new Error('Provider media exceeds byte limit.'), { failureCategory: 'SOURCE_TOO_LARGE' });
  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (type && !type.includes('video/mp4') && !type.includes('application/octet-stream')) throw Object.assign(new Error('Provider media is not MP4.'), { failureCategory: 'SOURCE_MIME' });
  const file = await open(target, 'w');
  let bytes = 0;
  let header = Buffer.alloc(0);
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes()) throw Object.assign(new Error('Provider media exceeds byte limit.'), { failureCategory: 'SOURCE_TOO_LARGE' });
      if (header.length < 16) header = Buffer.concat([header, buffer]).subarray(0, 16);
      await file.write(buffer);
    }
  } finally { await file.close(); }
  if (!bytes || header.subarray(4, 8).toString('ascii') !== 'ftyp') throw Object.assign(new Error('Provider media failed MP4 signature validation.'), { failureCategory: 'SOURCE_MIME' });
  return bytes;
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

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
    child.on('close', (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`FFmpeg exited ${code}: ${stderr.slice(-900)}`), { failureCategory: 'FINISH_FFMPEG' })));
  });
}

async function hashFile(path) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function finishMedia(job, sourceUrl) {
  if (!ffmpegPath) throw Object.assign(new Error('FFmpeg is unavailable.'), { failureCategory: 'CONFIG_MISSING' });
  const [width, height] = dimensions(job.format);
  const workdir = join('/tmp', `video-os-${safeName(job.id)}`);
  await mkdir(workdir, { recursive: true });
  const input = join(workdir, 'source.mp4');
  const output = join(workdir, 'final.mp4');
  const sourceBytes = await downloadPinned(sourceUrl, input);
  const startedAt = Date.now();
  const vf = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, 'setsar=1', 'eq=saturation=1.14:contrast=1.06', `drawbox=x=0:y=0:w=iw:h=${Math.max(12, Math.floor(height / 80))}:color=0x111827@0.18:t=fill`, 'format=yuv420p'].join(',');
  await runFfmpeg(['-y', '-i', input, '-f', 'lavfi', '-i', 'sine=frequency=196:sample_rate=48000', '-filter_complex', `${vf}[vout];[1:a]volume=0.025[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=1[aout]`, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', output]);
  const [info, sha256] = await Promise.all([stat(output), hashFile(output)]);
  const pathname = `video-os/finals/${safeName(job.accountId)}/${safeName(job.id)}-${sha256}.mp4`;
  const blob = await put(pathname, createReadStream(output), { access: 'private', contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
  return { privatePathname: blob.pathname, bytes: info.size, sha256, sourceBytes, ffmpegMs: Date.now() - startedAt, width, height, filename: `${safeName(job.title)}-${job.format}.mp4` };
}
