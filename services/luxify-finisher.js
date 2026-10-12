import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from '../lib/video-os-private-blob.js';
import { luxifyMediaExpectations, validateFinalMedia } from './final-media-validation.js';
import { downloadProviderMedia } from './media-finisher.js';

const safeName = value => String(value || 'video-os')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'video-os';

function luxifyMediaError(code, message, failureCategory = 'FINAL_MEDIA_VALIDATION') {
  return Object.assign(new Error(message), { code, failureCategory, statusCode: failureCategory === 'PERSISTENCE' ? 503 : 422 });
}

export async function finishLuxifyMedia(job, sourceUrl, dependencies = {}) {
  const expectations = luxifyMediaExpectations(job);
  if (!expectations) {
    throw luxifyMediaError('LUXIFY_JOB_BINDING_INVALID', 'LUXIFY final media requires an exact persisted LUXIFY job.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'video-os-luxify-'));
  const candidate = join(directory, 'provider-final.mp4');
  const startedAt = Date.now();
  try {
    const download = dependencies.downloadProviderMedia || downloadProviderMedia;
    const validate = dependencies.validateFinalMedia || validateFinalMedia;
    const putBlob = dependencies.putPrivateBlob || putPrivateBlob;

    const sourceBytes = await download(sourceUrl, candidate);
    const validated = await validate(candidate, { job });
    if (sourceBytes !== validated.bytes) {
      throw luxifyMediaError('LUXIFY_SOURCE_IDENTITY_MISMATCH', 'LUXIFY provider media changed before validation.');
    }

    const pathname = validated.acceptance.privatePathname;
    const blob = await putBlob(
      PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO,
      pathname,
      createReadStream(candidate),
      { contentType: 'video/mp4', addRandomSuffix: false, allowOverwrite: false },
    );
    if (blob?.pathname !== pathname) {
      throw luxifyMediaError('LUXIFY_FINAL_PATH_MISMATCH', 'LUXIFY final storage path could not be verified.', 'PERSISTENCE');
    }

    return {
      ...validated,
      privatePathname: pathname,
      sourceBytes,
      // finalizeReadyJob currently passes this compatibility field back to
      // validateFinalMedia. LUXIFY validation derives authority from the
      // persisted durationSeconds and never trusts this returned value.
      sourceDurationMs: expectations.expectedDurationMs,
      filename: `${safeName(job.title)}-${job.format}.mp4`,
      luxifyMs: Date.now() - startedAt,
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
