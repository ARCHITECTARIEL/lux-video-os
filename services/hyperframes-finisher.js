import { Sandbox } from '@vercel/sandbox';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { LUX_MARKETING_COMPOSITION_HTML } from '../media/hyperframes/lux-marketing-proof/composition.js';
import { downloadProviderMedia, hashFile } from './media-finisher.js';

export const HYPERFRAMES_VERSION = '0.7.64';
export const HYPERFRAMES_COMPOSITION_ID = 'lux-marketing-proof';
export const HYPERFRAMES_SANDBOX_VCPUS = 4;
export const HYPERFRAMES_SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 500_000_000;

const safeName = (value) => String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';

function configurationError(message) {
  return Object.assign(new Error(message), { failureCategory: 'CONFIG_MISSING' });
}

export function hyperframesSnapshotId(env = process.env) {
  const snapshotId = String(env.VIDEO_OS_HYPERFRAMES_SNAPSHOT_ID || '').trim();
  if (!snapshotId) throw configurationError('HyperFrames Sandbox snapshot is not configured.');
  return snapshotId;
}

export function sandboxCreateOptions(snapshotId) {
  return {
    source: { type: 'snapshot', snapshotId },
    resources: { vcpus: HYPERFRAMES_SANDBOX_VCPUS },
    timeout: HYPERFRAMES_SANDBOX_TIMEOUT_MS,
    persistent: false,
    networkPolicy: {
      mode: 'custom',
      allowedDomains: ['fonts.googleapis.com', 'fonts.gstatic.com'],
    },
    tags: { workload: 'video-os-finish', engine: 'hyperframes' },
  };
}

export function hyperframesRenderCommand() {
  return {
    cmd: 'npx',
    args: [
      '--no-install', 'hyperframes', 'render', 'composition',
      '--output', 'final.mp4', '--quality', 'high', '--workers', '1',
      '--strict-all', '--no-best-effort', '--sdr', '--no-browser-gpu', '--quiet',
    ],
    timeoutMs: HYPERFRAMES_SANDBOX_TIMEOUT_MS - 30_000,
  };
}

async function assertSuccessfulCommand(command) {
  if (command.exitCode === 0) return;
  const stderr = (await command.stderr()).slice(-1_500);
  throw Object.assign(new Error(`HyperFrames render failed (exit ${command.exitCode}): ${stderr}`), { failureCategory: 'FINISH_HYPERFRAMES' });
}

async function assertMp4(path) {
  const header = Buffer.alloc(8);
  const file = await open(path, 'r');
  let bytesRead;
  try {
    ({ bytesRead } = await file.read(header, 0, header.length, 0));
  } finally {
    await file.close();
  }
  if (bytesRead < 8 || header.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw Object.assign(new Error('HyperFrames output failed MP4 signature validation.'), { failureCategory: 'FINISH_HYPERFRAMES' });
  }
}

export async function finishMediaWithHyperframes(job, sourceUrl, dependencies = {}) {
  if (job.format !== 'landscape') throw Object.assign(new Error('The initial HyperFrames composition supports landscape jobs only.'), { failureCategory: 'FINISH_HYPERFRAMES' });
  const createSandbox = dependencies.createSandbox || ((options) => Sandbox.create(options));
  const snapshotId = hyperframesSnapshotId(dependencies.env || process.env);
  const workdir = join('/tmp', `video-os-hyperframes-${safeName(job.id)}`);
  const input = join(workdir, 'source.mp4');
  const output = join(workdir, 'final.mp4');
  let sandbox;
  await mkdir(workdir, { recursive: true });
  try {
    const sourceBytes = await downloadProviderMedia(sourceUrl, input);
    const [composition, presenter] = await Promise.all([Buffer.from(LUX_MARKETING_COMPOSITION_HTML), readFile(input)]);
    const compositionSha256 = crypto.createHash('sha256').update(composition).digest('hex');
    const startedAt = Date.now();
    sandbox = await createSandbox(sandboxCreateOptions(snapshotId));
    await sandbox.writeFiles([
      { path: 'composition/index.html', content: composition },
      { path: 'composition/assets/presenter.mp4', content: presenter },
    ]);
    await assertSuccessfulCommand(await sandbox.runCommand(hyperframesRenderCommand()));
    const downloaded = await sandbox.downloadFile({ path: 'final.mp4' }, { path: output }, { mkdirRecursive: true });
    if (!downloaded) throw Object.assign(new Error('HyperFrames render produced no MP4.'), { failureCategory: 'FINISH_HYPERFRAMES' });
    const info = await stat(output);
    if (!info.size || info.size > MAX_OUTPUT_BYTES) throw Object.assign(new Error('HyperFrames output exceeded the bounded artifact size.'), { failureCategory: 'FINISH_HYPERFRAMES' });
    await assertMp4(output);
    const sha256 = await hashFile(output);
    const pathname = `video-os/finals/${safeName(job.accountId)}/${safeName(job.id)}-${sha256}.mp4`;
    const blob = await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, createReadStream(output), { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: true });
    return {
      privatePathname: blob.pathname,
      bytes: info.size,
      sha256,
      sourceBytes,
      width: 1920,
      height: 1080,
      filename: `${safeName(job.title)}-${job.format}.mp4`,
      compositionEngine: 'hyperframes',
      compositionEngineVersion: HYPERFRAMES_VERSION,
      compositionId: HYPERFRAMES_COMPOSITION_ID,
      compositionSha256,
      renderCompute: 'vercel-sandbox',
      renderMs: Date.now() - startedAt,
    };
  } finally {
    await sandbox?.stop().catch(() => {});
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
