// Thin passthrough to @vercel/blob, matching the {put, get, del} contract
// shared with lib/storage-drivers/fs-blob-driver.js so callers don't need
// to know which driver is active.
import { del as blobDel, get as blobGet, put as blobPut } from '@vercel/blob';

export async function put(pathname, body, options = {}) {
  const { token = process.env.BLOB_READ_WRITE_TOKEN, ...rest } = options;
  return blobPut(pathname, body, { ...rest, access: 'private', token });
}

export async function get(pathname, options = {}) {
  const { token = process.env.BLOB_READ_WRITE_TOKEN, ...rest } = options;
  return blobGet(pathname, { access: 'private', useCache: false, ...rest, token });
}

export async function del(pathname, options = {}) {
  const { token = process.env.BLOB_READ_WRITE_TOKEN, ...rest } = options;
  await blobDel(pathname, { ...rest, token });
  return { deleted: true };
}
