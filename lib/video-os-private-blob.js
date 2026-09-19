// STORAGE_DRIVER selects where private objects actually live:
//  - 'blob' (default): @vercel/blob -- the Vercel-hosted path.
//  - 'fs': local filesystem under STORAGE_FS_ROOT -- the VPS-hosted path.
// Every caller in this codebase goes through putPrivateBlob/getPrivateBlob/
// deletePrivateBlob below rather than importing a driver directly, so this
// is the only place that needs to know which driver is active.
function selectedDriver() {
  return String(process.env.STORAGE_DRIVER || 'blob').trim().toLowerCase();
}

async function driver() {
  return selectedDriver() === 'fs'
    ? import('./storage-drivers/fs-blob-driver.js')
    : import('./storage-drivers/vercel-blob-driver.js');
}

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

function assertConfigured() {
  if (selectedDriver() === 'fs') return; // local disk needs no credential, just STORAGE_FS_ROOT (defaulted)
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw policyError('Private Blob storage is not configured.');
}

export async function putPrivateBlob(classification, pathname, body, options = {}) {
  const { access = 'private', ...driverOptions } = options;
  assertPrivateBlobWrite({ classification, pathname, access });
  assertConfigured();
  const { put } = await driver();
  return put(pathname, body, driverOptions);
}

export async function getPrivateBlob(pathname, options = {}) {
  assertConfigured();
  const { get } = await driver();
  return get(pathname, options);
}

export async function deletePrivateBlob(classification, pathname, options = {}) {
  const { ifMatch } = options;
  const policy = assertPrivateBlobWrite({ classification, pathname, access: 'private' });
  assertConfigured();
  if (!ifMatch) throw policyError('A Blob version is required for compensating deletion.');
  const { del } = await driver();
  await del(policy.pathname, { ifMatch });
  return { deleted: true };
}
