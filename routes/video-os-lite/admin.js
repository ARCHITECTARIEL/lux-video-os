// Routed through the consolidated workspace function to stay within the Vercel function limit.
import { getAdminOverview, getJobEventTimeline, listFailedOrStuckJobs, listRecentAccounts, listRecentJobs } from '../../db/repositories.js';
import { handleOptions, parseCookies, send, verifySessionToken } from '../../lib/video-os-account.js';
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

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for admin status.' });
  try {
    if (!isAdminRequest(req)) return send(res, 401, { ok: false, error: 'Admin login required.' });
    const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
    const operation = url.searchParams.get('operation') || 'jobs';

    if (operation === 'jobs') return send(res, 200, { ok: true, ...(await jobsSummary()) });
    if (operation === 'overview') return send(res, 200, { ok: true, overview: await getAdminOverview() });
    if (operation === 'attention') return send(res, 200, { ok: true, jobs: await listFailedOrStuckJobs(200) });
    if (operation === 'accounts') return send(res, 200, { ok: true, accounts: await listRecentAccounts(200) });
    if (operation === 'job-events') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
      return send(res, 200, { ok: true, jobId, events: await getJobEventTimeline(jobId) });
    }
    return send(res, 400, { ok: false, error: `Unknown admin operation: ${operation}` });
  } catch (error) {
    captureRouteError(error, { route: 'admin', failureCategory: error?.failureCategory || 'ADMIN' });
    send(res, error.statusCode || 400, { ok: false, error: error.message || 'Admin status failed.' });
  }
}
