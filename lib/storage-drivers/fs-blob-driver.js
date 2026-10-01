// Local-filesystem storage driver for VPS hosting. Implements the same
// {put, get, del} contract as @vercel/blob's put/get/del (see
// lib/video-os-private-blob.js), including etag-based optimistic
// concurrency (ifMatch), so callers written against @vercel/blob's shape
// (result.stream, result.blob.etag, BlobPreconditionFailedError) work
// unchanged regardless of which driver is selected.
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function root() {
  return process.env.STORAGE_FS_ROOT || '/var/lib/video-os/blob';
}

function targetPath(pathname) {
  const normalized = String(pathname || '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) {
    throw Object.assign(new Error('Invalid storage pathname.'), { statusCode: 400 });
  }
  return join(root(), normalized);
}

function etagPath(target) {
  return `${target}.etag`;
}

function preconditionFailed() {
  return Object.assign(new Error('Precondition failed: the object changed since it was last read.'), {
    statusCode: 412,
    name: 'BlobPreconditionFailedError',
  });
}

async function hashExistingFile(target) {
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw Object.assign(new Error('Unsupported storage body type.'), { statusCode: 500 });
}

async function readEtag(target) {
  try {
    return (await readFile(etagPath(target), 'utf8')).trim();
  } catch (error) {
    // The data link is the atomic publication point. A process can exit after
    // publishing it but before writing the sidecar, so recover the stable etag
    // from the actual bytes instead of making an existing object disappear.
    if (error.code === 'ENOENT') return hashExistingFile(target);
    throw error;
  }
}

function objectAlreadyExists() {
  return Object.assign(new Error('Object already exists at this pathname.'), {
    statusCode: 409,
    code: 'EEXIST',
  });
}

export async function put(pathname, body, options = {}) {
  'use step';
  const target = targetPath(pathname);
  const buffer = await toBuffer(body);
  const etag = crypto.createHash('sha256').update(buffer).digest('hex');

  if (options.ifMatch) {
    const current = await readEtag(target);
    if (current !== options.ifMatch) throw preconditionFailed();
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, buffer, { flag: 'wx' });
    if (options.allowOverwrite === false) {
      // A hard link publishes the complete temporary file only when target
      // does not already exist. Unlike exists-then-rename, this is one atomic
      // no-replace operation even when multiple writers race.
      try {
        await link(tmp, target);
      } catch (error) {
        if (error.code === 'EEXIST') throw objectAlreadyExists();
        throw error;
      }
    } else {
      // Overwritable state retains the established write-then-rename behavior.
      await rename(tmp, target);
    }
    await writeFile(etagPath(target), etag);
  } finally {
    // rename removes the temporary name; hard-link publication does not.
    await rm(tmp, { force: true });
  }

  return { pathname, etag, contentType: options.contentType || null, size: buffer.length };
}

export async function get(pathname, options = {}) {
  'use step';
  const target = targetPath(pathname);
  const etag = await readEtag(target);
  if (etag === null) return null;
  return { stream: createReadStream(target), blob: { etag, pathname } };
}

export async function del(pathname, options = {}) {
  'use step';
  const target = targetPath(pathname);
  if (options.ifMatch) {
    const current = await readEtag(target);
    if (current !== null && current !== options.ifMatch) throw preconditionFailed();
  }
  await rm(target, { force: true });
  await rm(etagPath(target), { force: true });
  return { deleted: true };
}
