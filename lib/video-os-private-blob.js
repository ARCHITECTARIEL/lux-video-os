import { put } from '@vercel/blob';

export const PRIVATE_BLOB_CLASSIFICATIONS = Object.freeze({
  ACCOUNT_STATE: 'account-state',
  AUTHENTICATION_STATE: 'authentication-state',
  RATE_LIMIT_STATE: 'rate-limit-state',
  CUSTOMER_UPLOAD: 'customer-upload',
  FINISHED_CUSTOMER_VIDEO: 'finished-customer-video',
  JOB_STATE: 'job-state',
  CREDIT_STATE: 'credit-state',
  STRIPE_EVENT: 'stripe-event',
  RECOVERY_RECEIPT: 'recovery-receipt',
});

const PREFIX_BY_CLASSIFICATION = Object.freeze({
  [PRIVATE_BLOB_CLASSIFICATIONS.ACCOUNT_STATE]: 'video-os/accounts/',
  [PRIVATE_BLOB_CLASSIFICATIONS.AUTHENTICATION_STATE]: 'video-os/auth/',
  [PRIVATE_BLOB_CLASSIFICATIONS.RATE_LIMIT_STATE]: 'video-os/rate/',
  [PRIVATE_BLOB_CLASSIFICATIONS.CUSTOMER_UPLOAD]: 'video-os/uploads/',
  [PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO]: 'video-os/finals/',
  [PRIVATE_BLOB_CLASSIFICATIONS.JOB_STATE]: 'video-os/jobs/',
  [PRIVATE_BLOB_CLASSIFICATIONS.CREDIT_STATE]: 'video-os/credit-state/',
  [PRIVATE_BLOB_CLASSIFICATIONS.STRIPE_EVENT]: 'video-os/stripe-events/',
  [PRIVATE_BLOB_CLASSIFICATIONS.RECOVERY_RECEIPT]: 'video-os/recovery-receipts/',
});

function policyError(message) {
  return Object.assign(new Error(message), {
    statusCode: 503,
    failureCategory: 'PERSISTENCE',
  });
}

export function privateBlobClassificationForPath(pathname) {
  const path = String(pathname || '');
  return Object.entries(PREFIX_BY_CLASSIFICATION)
    .find(([, prefix]) => path.startsWith(prefix))?.[0] || null;
}

export function assertPrivateBlobWrite({ classification, pathname, access = 'private' }) {
  const prefix = PREFIX_BY_CLASSIFICATION[classification];
  const path = String(pathname || '');
  if (!prefix) throw policyError('Blob write classification is not allowed.');
  if (access !== 'private') throw policyError('Public Blob writes are prohibited.');
  if (!path.startsWith(prefix) || path.length <= prefix.length || path.includes('..') || path.includes('\\')) {
    throw policyError('Blob pathname does not match its private classification.');
  }
  return { access: 'private', classification, pathname: path };
}

export async function putPrivateBlob(classification, pathname, body, options = {}) {
  const { access = 'private', token = process.env.BLOB_READ_WRITE_TOKEN, ...blobOptions } = options;
  assertPrivateBlobWrite({ classification, pathname, access });
  if (!token) throw policyError('Private Blob storage is not configured.');
  return put(pathname, body, { ...blobOptions, access: 'private', token });
}
