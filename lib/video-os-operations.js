import crypto from 'node:crypto';
import { accountHash, logEvent } from './video-os-security.js';
import { PRIVATE_BLOB_CLASSIFICATIONS, putPrivateBlob } from './video-os-private-blob.js';

export const FAILURE_CATEGORIES = Object.freeze(['AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'CONFIG_MISSING', 'VALIDATION', 'ENTITLEMENT', 'CONSENT', 'RATE_LIMIT', 'PROVIDER_SUBMIT', 'PROVIDER_SUBMIT_UNKNOWN', 'PROVIDER_POLL', 'PROVIDER_REJECTED', 'PROVIDER_TIMEOUT', 'SOURCE_POLICY', 'SOURCE_TIMEOUT', 'SOURCE_TOO_LARGE', 'SOURCE_MIME', 'FINISH_FFMPEG', 'FINISH_HYPERFRAMES', 'FINISH_REMOTION', 'FINAL_STORE', 'FINAL_MEDIA_VALIDATION', 'DOWNLOAD_AUTH', 'PERSISTENCE', 'RECOVERY', 'RECONCILIATION', 'INTERNAL']);

export function classifyFailure(error, fallback = 'INTERNAL') {
  if (FAILURE_CATEGORIES.includes(error?.failureCategory)) return error.failureCategory;
  if (error?.statusCode === 401) return 'AUTH_REQUIRED';
  if (error?.statusCode === 403) return 'AUTH_FORBIDDEN';
  if (error?.statusCode === 429) return 'RATE_LIMIT';
  return fallback;
}

export function jobEvent(event, job, fields = {}) {
  logEvent(event, { correlationId: job?.correlationId, jobId: job?.id, providerJobId: job?.providerJobId, accountIdHash: accountHash(job?.accountId), ...fields });
}

export async function writeRecoveryReceipt(job, fields = {}) {
  const attemptId = crypto.randomUUID();
  const receipt = { version: 1, attemptId, correlationId: job.correlationId, jobId: job.id, accountIdHash: accountHash(job.accountId), startedAt: fields.startedAt || new Date().toISOString(), completedAt: new Date().toISOString(), ...fields };
  await putPrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.RECOVERY_RECEIPT, `video-os/recovery-receipts/${job.accountId}/${job.id}/${attemptId}.json`, JSON.stringify(receipt), { contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false, token: process.env.BLOB_READ_WRITE_TOKEN });
  return receipt;
}

export const RENDER_SLOS = Object.freeze({
  apiAvailabilityMonthly: 0.999,
  submissionAcceptance: 0.995,
  providerReadyToFinalReady15m: 0.99,
  providerReadyToFinalReady30m: 0.999,
  endToEndDownload30m: 0.95,
  zeroCrossAccountDownloads: true,
  dailyReconciliationByUtcHour: 10,
});
