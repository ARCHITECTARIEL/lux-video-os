import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerifiedFinalBytes } from '../lib/video-os-final-bytes.js';
import { finalOutputPath } from '../lib/video-os-output-acceptance.js';
import { validateFinalMedia } from './final-media-validation.js';

export async function acceptStoredFinalOutput(job, artifact, expectedDurationMs) {
  'use step';
  if (!Number.isFinite(expectedDurationMs) || expectedDurationMs <= 0
    || artifact?.privatePathname !== finalOutputPath(job.accountId, job.id, artifact?.sha256)) {
    throw Object.assign(new Error('Final media source binding is invalid.'), { statusCode: 409, failureCategory: 'FINAL_MEDIA_VALIDATION' });
  }
  let directory;
  try {
    const stored = await readVerifiedFinalBytes(artifact);
    directory = await mkdtemp(join(tmpdir(), 'video-os-accept-'));
    const file = join(directory, 'final.mp4');
    await writeFile(file, stored.bytes, { flag: 'wx' });
    const validated = await validateFinalMedia(file, { job, expectedDurationMs });
    if (validated.sha256 !== artifact.sha256 || validated.bytes !== artifact.bytes) {
      throw Object.assign(new Error('Final media identity changed during validation.'), { statusCode: 409, failureCategory: 'FINAL_STORE' });
    }
    // Supplied acceptance metadata is deliberately overwritten by real decode.
    return { ...artifact, ...validated, privatePathname: artifact.privatePathname };
  } catch (error) {
    // Do not delete on rejection: a concurrent retry may already have accepted
    // this immutable object. Retain its safe identity for later quarantine/GC.
    error.rejectedArtifact = { sha256: artifact.sha256, bytes: artifact.bytes };
    throw error;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
