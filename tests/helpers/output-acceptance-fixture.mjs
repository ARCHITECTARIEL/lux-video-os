// Synthetic persisted evidence for contract tests only. Never a render receipt.
import { createHash } from 'node:crypto';
import { finalOutputPath } from '../../lib/video-os-output-acceptance.js';
export function acceptedJob(provider = 'heygen', overrides = {}) {
  const job = { id: '11111111-2222-4333-8444-555555555555', accountId: 'acceptance-owner', provider,
    status: 'ready', title: 'Accepted contract sample', format: 'vertical', costCredits: 90,
    createdAt: '2026-09-29T12:00:00Z', input: {}, ...overrides, output: {
      filename: 'accepted.mp4',
      bytes: 5, sha256: createHash('sha256').update('video').digest('hex'),
    } };
  job.output.privatePathname = finalOutputPath(job.accountId, job.id, job.output.sha256);
  job.output.acceptance = {
    version: 1, policy: 'video-os-media-v1', validatorVersion: 'synthetic-test-only', status: 'accepted', jobId: job.id, accountId: job.accountId,
    privatePathname: job.output.privatePathname, bytes: job.output.bytes, sha256: job.output.sha256,
    validatedAt: '2026-09-29T12:01:00Z',
    media: { fullDecode: true, videoStreams: 1, audioStreams: 1, width: 1080, height: 1920, durationMs: 5000 },
    checks: { duration: true, dimensions: true, byteLimit: true },
  };
  return job;
}
