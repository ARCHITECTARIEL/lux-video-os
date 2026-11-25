import { chmod, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import defaultFfmpegPath from 'ffmpeg-static';
import { logEvent } from '../lib/video-os-security.js';

function unique(values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

async function usableBinary(candidate, { statImpl, chmodImpl }) {
  let info;
  try { info = await statImpl(candidate); } catch { return null; }
  if (!info.isFile()) return null;
  if ((info.mode & 0o111) !== 0) return candidate;
  try { await chmodImpl(candidate, 0o755); } catch { return candidate; }
  try {
    const after = await statImpl(candidate);
    if (after.isFile()) return candidate;
  } catch { return candidate; }
  return candidate;
}

/**
 * First usable binary wins. Enrollment has no runtime ffmpeg env override;
 * callers may still pass `override` for an explicit path. Then the step
 * module directory, the process working directory, and ffmpeg-static.
 */
export async function resolveEnrollmentFfmpeg({
  override,
  moduleUrl,
  cwd = process.cwd(),
  staticPath = defaultFfmpegPath,
  statImpl = stat,
  chmodImpl = chmod,
} = {}) {
  let moduleDir = '';
  if (moduleUrl) {
    try { moduleDir = dirname(fileURLToPath(moduleUrl)); } catch { moduleDir = ''; }
  }
  const candidates = unique([
    override,
    moduleDir ? join(moduleDir, 'ffmpeg') : '',
    cwd ? join(cwd, 'ffmpeg') : '',
    staticPath,
  ]);
  for (const candidate of candidates) {
    const resolved = await usableBinary(candidate, { statImpl, chmodImpl });
    if (resolved) return resolved;
  }
  return undefined;
}

export function logEnrollmentFfmpegSpawnFailure(binary, error, log = logEvent) {
  log('enrollment.ffmpeg.spawn_failed', {
    code: 'FFMPEG_UNAVAILABLE',
    ffmpegPath: typeof binary === 'string' ? binary : '',
    errno: typeof error?.errno === 'number' ? error.errno : undefined,
    spawnCode: typeof error?.code === 'string' ? error.code : undefined,
  });
}
