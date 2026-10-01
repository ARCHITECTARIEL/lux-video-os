// Routed through the consolidated workspace function to stay within the Vercel function limit.
import { getPrivateBlob } from '../../lib/video-os-private-blob.js';
import { getOwnedMediaAsset } from '../../db/repositories.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';

function fail(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error }));
}

async function cancelStream(stream) {
  if (typeof stream?.destroy === 'function') stream.destroy();
  else if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
}

function responseLifecycle(res) {
  if (typeof res.once !== 'function' || typeof res.removeListener !== 'function') {
    return { waitForDrain: async () => {}, close: () => {} };
  }
  let terminalError;
  const drainWaiters = new Set();
  const stop = error => {
    if (terminalError) return;
    terminalError = error;
    for (const waiter of drainWaiters) {
      res.removeListener('drain', waiter.onDrain);
      waiter.reject(error);
    }
    drainWaiters.clear();
  };
  const onClose = () => stop(new Error('Asset response closed.'));
  const onError = error => stop(error);
  res.once('close', onClose);
  res.once('error', onError);
  return {
    waitForDrain: () => {
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = {
          reject,
          onDrain: () => {
            drainWaiters.delete(waiter);
            resolve();
          },
        };
        drainWaiters.add(waiter);
        res.once('drain', waiter.onDrain);
      });
    },
    close: () => {
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      for (const waiter of drainWaiters) res.removeListener('drain', waiter.onDrain);
      drainWaiters.clear();
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Use GET to retrieve an asset.');
  try {
    const session = sessionFromRequest(req);
    const assetId = new URL(req.url, 'https://video-os.invalid').searchParams.get('assetId');
    const asset = await getOwnedMediaAsset(session.accountId, assetId);
    if (!asset || asset.quarantinedAt) return fail(res, 404, 'Asset not found.');
    const result = await getPrivateBlob(asset.privatePathname);
    if (!result?.stream) return fail(res, 410, 'Asset is unavailable.');
    const expectedBytes = Number(asset.bytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      await cancelStream(result.stream);
      return fail(res, 410, 'Asset is unavailable.');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let bytes = 0;
    let completed = false;
    const lifecycle = responseLifecycle(res);
    try {
      for await (const value of result.stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (bytes > expectedBytes) { res.destroy?.(); return; }
        if (res.write(chunk) === false) await lifecycle.waitForDrain();
      }
      if (bytes !== expectedBytes) { res.destroy?.(); return; }
      res.end();
      completed = true;
    } finally {
      lifecycle.close();
      if (!completed) await cancelStream(result.stream);
    }
  } catch (error) {
    if (res.headersSent) { res.destroy?.(); return; }
    return fail(res, error.statusCode || 500, error.statusCode === 401 ? error.message : 'Asset retrieval failed.');
  }
}
