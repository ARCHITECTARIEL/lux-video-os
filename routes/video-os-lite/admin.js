// Routed through the consolidated workspace function to stay within the Vercel function limit.
import {
  adminResolveJob, getAdminOverview, getJobEventTimeline, listFailedOrStuckJobs, listMediaAssetsForJob,
  listRecentAccounts, listRecentCreditTransactions, listRecentJobs, listRecentStripeEvents, quarantineMediaAsset,
} from '../../db/repositories.js';
import { handleOptions, parseCookies, readJson, send, verifySessionToken } from '../../lib/video-os-account.js';
import { captureRouteError } from '../../lib/video-os-observability.js';

function isAdminRequest(req) {
  const token = String(process.env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let cookieAdmin = false;
  try { cookieAdmin = verifySessionToken(parseCookies(req).vos_admin).accountId === 'admin'; } catch {}
  return (Boolean(token) && auth === token) || cookieAdmin;
}

async function jobsSummary() {
  const jobs = await listRecentJobs(100);
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const rendering = jobs.filter((job) => ['provider_submitted', 'provider_rendering', 'finishing'].includes(job.status)).length;
  const ready = jobs.filter((job) => job.status === 'ready').length;
  return { summary: { total: jobs.length, rendering, ready, failed }, jobs };
}

async function handleGet(req, res, operation, url) {
  if (operation === 'jobs') return send(res, 200, { ok: true, ...(await jobsSummary()) });
  if (operation === 'overview') return send(res, 200, { ok: true, overview: await getAdminOverview() });
  if (operation === 'attention') return send(res, 200, { ok: true, jobs: await listFailedOrStuckJobs(200) });
  if (operation === 'accounts') return send(res, 200, { ok: true, accounts: await listRecentAccounts(200) });
  if (operation === 'credit-ledger') return send(res, 200, { ok: true, transactions: await listRecentCreditTransactions(200) });
  if (operation === 'stripe-events') return send(res, 200, { ok: true, events: await listRecentStripeEvents(200) });
  if (operation === 'job-events') {
    const jobId = String(url.searchParams.get('jobId') || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    return send(res, 200, { ok: true, jobId, events: await getJobEventTimeline(jobId) });
  }
  if (operation === 'job-assets') {
    const jobId = String(url.searchParams.get('jobId') || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    return send(res, 200, { ok: true, jobId, assets: await listMediaAssetsForJob(jobId) });
  }
  return send(res, 400, { ok: false, error: `Unknown admin operation: ${operation}` });
}

async function handlePost(req, res, operation) {
  const payload = await readJson(req, 5_000);
  if (operation === 'resolve-job') {
    const jobId = String(payload.jobId || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    const job = await adminResolveJob(jobId, payload.note);
    if (!job) return send(res, 404, { ok: false, error: 'Job not found.' });
    return send(res, 200, { ok: true, job });
  }
  if (operation === 'quarantine-asset') {
    const mediaAssetId = String(payload.mediaAssetId || '').trim();
    if (!mediaAssetId) return send(res, 400, { ok: false, error: 'mediaAssetId is required.' });
    const asset = await quarantineMediaAsset(mediaAssetId);
    if (!asset) return send(res, 404, { ok: false, error: 'Media asset not found.' });
    // Not persisted (media_assets has no reason column yet -- see
    // quarantineMediaAsset()'s comment); logged here as a structured audit
    // line (not an error -- this is routine admin action, not a failure)
    // purely so the reason isn't lost entirely.
    console.log(JSON.stringify({ event: 'video_os_admin_quarantine', mediaAssetId, reason: String(payload.reason || '').slice(0, 300) || null }));
    return send(res, 200, { ok: true, asset });
  }
  return send(res, 400, { ok: false, error: `Unknown admin operation: ${operation}` });
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Use GET or POST for admin requests.' });
  try {
    if (!isAdminRequest(req)) return send(res, 401, { ok: false, error: 'Admin login required.' });
    const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
    const operation = url.searchParams.get('operation') || 'jobs';
    if (req.method === 'POST') return await handlePost(req, res, operation);
    return await handleGet(req, res, operation, url);
  } catch (error) {
    captureRouteError(error, { route: 'admin', failureCategory: error?.failureCategory || 'ADMIN' });
    send(res, error.statusCode || 400, { ok: false, error: error.message || 'Admin status failed.' });
  }
}
