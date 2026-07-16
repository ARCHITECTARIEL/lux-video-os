import { listRecentJobs } from '../../db/repositories.js';
import { handleOptions, parseCookies, send, verifySessionToken } from '../../lib/video-os-account.js';
import { captureRouteError } from '../../lib/video-os-observability.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Use GET for admin status.' });
  try {
    const token = String(process.env.VIDEO_OS_ADMIN_TOKEN || '').trim();
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let cookieAdmin = false;
    try { cookieAdmin = verifySessionToken(parseCookies(req).vos_admin).accountId === 'admin'; } catch {}
    if ((!token || auth !== token) && !cookieAdmin) return send(res, 401, { ok: false, error: 'Admin login required.' });
    const jobs = await listRecentJobs(100);
    const failed = jobs.filter((job) => job.status === 'failed').length;
    const rendering = jobs.filter((job) => ['provider_submitted', 'provider_rendering', 'finishing'].includes(job.status)).length;
    const ready = jobs.filter((job) => job.status === 'ready').length;
    send(res, 200, { ok: true, summary: { total: jobs.length, rendering, ready, failed }, jobs });
  } catch (error) {
    captureRouteError(error, { route: 'admin', failureCategory: error?.failureCategory || 'ADMIN' });
    send(res, error.statusCode || 400, { ok: false, error: error.message || 'Admin status failed.' });
  }
}
