import { LUX_MARKETING_COMPOSITION_HTML } from '../media/hyperframes/lux-marketing-proof/composition.js';

export function hyperframesComposition(sourceDurationMs) {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || sourceDurationMs > 180000) {
    throw Object.assign(new Error('HyperFrames source duration is invalid.'), { failureCategory: 'FINAL_MEDIA_VALIDATION' });
  }
  const ratio = sourceDurationMs / 5240;
  const scale = value => String(Number((Number(value) * ratio).toFixed(6)));
  return LUX_MARKETING_COMPOSITION_HTML
    .replace(/data-(start|duration)="(\d+(?:\.\d+)?)"/g, (_match, attribute, value) => `data-${attribute}="${scale(value)}"`)
    .replace(/\b(\d+(?:\.\d+)?)s(?=[\s;])/g, (_match, value) => `${scale(value)}s`);
}

export const HYPERFRAMES_VERSION = '0.7.64';
export const HYPERFRAMES_COMPOSITION_ID = 'lux-marketing-proof';
export const HYPERFRAMES_SANDBOX_VCPUS = 4;
export const HYPERFRAMES_SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;
export const HYPERFRAMES_MVP_SUPPORTED = false;

function configurationError(message, code = 'CONFIG_MISSING') {
  return Object.assign(new Error(message), { code, failureCategory: 'CONFIG_MISSING' });
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

export async function finishMediaWithHyperframes() {
  throw configurationError(
    'HyperFrames finishing is unavailable in the HeyGen-only MVP release.',
    'HYPERFRAMES_MVP_UNSUPPORTED',
  );
}
