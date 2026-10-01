import { readVerifiedFinalBytes } from '../../lib/video-os-final-bytes.js';
import { getOwnedJob } from '../../db/repositories.js';
import { sessionFromRequest } from '../../lib/video-os-account.js';
import { acceptedJobOutput } from '../../lib/video-os-output-acceptance.js';

function failure(res, status, error) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ ok: false, error })); }

export function mediaDisposition(requestUrl, filename) {
  return requestUrl.searchParams.get('disposition') === 'inline' ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return failure(res, 405, 'Use GET to download.');
  try {
    const session = sessionFromRequest(req);
    const requestUrl = new URL(req.url, 'https://video-os.invalid');
    const jobId = requestUrl.searchParams.get('jobId');
    const job = await getOwnedJob(session.accountId, jobId);
    if (!job) return failure(res, 404, 'Final video not found.');
    if (job.status !== 'ready') return failure(res, 409, 'Final video is not ready.');
    if (job.videoDeletedAt) return failure(res, 410, 'Final video is unavailable.');
    if (!acceptedJobOutput(job)) return failure(res, 409, 'Output acceptance pending.');
    const result = await readVerifiedFinalBytes(job.output);
    const filename = String(job.output?.filename || 'video-os-final.mp4').replace(/[^a-zA-Z0-9._-]/g, '-');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', mediaDisposition(requestUrl, filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (result.etag) res.setHeader('ETag', result.etag);
    res.setHeader('Content-Length', String(result.bytes.length));
    res.write(result.bytes);
    res.end();
  } catch (error) { failure(res, error.statusCode || 500, error.statusCode === 401 ? error.message : 'Download failed.'); }
}
