// Read-side contract for evidence written by the trusted server media validator.
// This checks persisted evidence; it does not decode media or manufacture proof.
import {
  LUXIFY_PROVIDER_CAPABILITY,
  LUXIFY_RENDER_MODE,
  classifyLuxifyMarker,
} from './luxify-contract.js';
import { assertPersistedLuxifyJob } from './luxify-job-binding.js';

export const OUTPUT_ACCEPTANCE_VERSION = 1;
export const OUTPUT_ACCEPTANCE_POLICY = 'video-os-media-v1';

const LUXIFY_DIMENSIONS = Object.freeze({
  '720p': Object.freeze({ '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720] }),
  '1080p': Object.freeze({ '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }),
});

// Matches the existing final-media writers; Prompt 3 must use this same identity.
export function finalOutputPath(accountId, jobId, sha256) {
  const safeName = value => String(value || 'video-os').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'video-os';
  return `video-os/finals/${safeName(accountId)}/${safeName(jobId)}-${sha256}.mp4`;
}

function acceptedLuxifyBinding(job, evidence, media) {
  const mode = classifyLuxifyMarker(job?.input, { provider: job?.provider });
  if (mode === null) return true;
  if (mode !== 'luxify') return false;
  let binding;
  try { binding = assertPersistedLuxifyJob(job); } catch { return false; }
  const dimensions = LUXIFY_DIMENSIONS[binding.intent.resolution]?.[binding.intent.aspectRatio];
  const expectedDurationMs = binding.intent.durationSeconds * 1_000;
  const toleranceMs = Math.max(500, expectedDurationMs * 0.05);
  return Boolean(dimensions
    && evidence?.renderMode === LUXIFY_RENDER_MODE
    && evidence.providerCapability === LUXIFY_PROVIDER_CAPABILITY
    && evidence.resolution === binding.intent.resolution
    && evidence.aspectRatio === binding.intent.aspectRatio
    && media?.expectedDurationMs === expectedDurationMs
    && media.width === dimensions[0]
    && media.height === dimensions[1]
    && Math.abs(media.durationMs - expectedDurationMs) <= toleranceMs);
}

export function acceptedJobOutput(job) {
  const output = job?.output;
  const evidence = output?.acceptance;
  const media = evidence?.media;
  const checks = evidence?.checks;
  const path = output?.privatePathname;
  return Boolean(job?.status === 'ready'
    && ['heygen', 'sadtalker'].includes(job.provider)
    && typeof job.id === 'string' && job.id && typeof job.accountId === 'string' && job.accountId
    && typeof path === 'string' && path.startsWith('video-os/finals/') && path.length > 'video-os/finals/'.length
    && !path.includes('..') && !/[\\?#\s]/.test(path)
    && Number.isSafeInteger(output.bytes) && output.bytes > 0
    && typeof output.sha256 === 'string' && /^[a-f0-9]{64}$/.test(output.sha256)
    && path === finalOutputPath(job.accountId, job.id, output.sha256)
    && evidence?.version === OUTPUT_ACCEPTANCE_VERSION && evidence.policy === OUTPUT_ACCEPTANCE_POLICY
    && evidence.status === 'accepted' && evidence.jobId === job.id && evidence.accountId === job.accountId
    && typeof evidence.validatorVersion === 'string' && evidence.validatorVersion.trim().length > 0
    && evidence.privatePathname === path && evidence.bytes === output.bytes && evidence.sha256 === output.sha256
    && typeof evidence.validatedAt === 'string' && Number.isFinite(Date.parse(evidence.validatedAt))
    && media?.fullDecode === true && Number.isInteger(media.videoStreams) && media.videoStreams > 0
    && Number.isInteger(media.audioStreams) && media.audioStreams > 0
    && Number.isInteger(media.width) && media.width > 0 && Number.isInteger(media.height) && media.height > 0
    && Number.isFinite(media.durationMs) && media.durationMs > 0
    && acceptedLuxifyBinding(job, evidence, media)
    && checks?.duration === true && checks.dimensions === true && checks.byteLimit === true);
}
