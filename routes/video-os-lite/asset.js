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

export default async function handler(req, res) {
  if (req.method !== 'GET') return fail(res, 405, 'Use GET to retrieve an asset.');
  try {
    const session = sessionFromRequest(req);
    const assetId = new URL(req.url, 'https://video-os.invalid').searchParams.get('assetId');
    const asset = await getOwnedMediaAsset(session.accountId, assetId);
    if (!asset) return fail(res, 404, 'Asset not found.');
    const result = await getPrivateBlob(asset.privatePathname);
    if (!result?.stream) return fail(res, 410, 'Asset is unavailable.');
    res.statusCode = 200;
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    for await (const chunk of result.stream) res.write(chunk);
    res.end();
  } catch (error) {
    return fail(res, error.statusCode || 500, error.statusCode === 401 ? error.message : 'Asset retrieval failed.');
  }
}
