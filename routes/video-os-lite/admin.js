// Routed through the consolidated workspace function to stay within the Vercel function limit.
import crypto from 'node:crypto';
import { dispatchClaimedJob } from '../../api/video-os-lite/render-v2.js';
import {
  adminResolveJob, claimWorkflowStart, getAdminOverview, getJob, getJobEventTimeline, grantAdminCredit, listFailedOrStuckJobs,
  listMediaAssetsForJob, listRecentAccounts, listRecentCreditTransactions, listRecentJobs, listRecentStripeEvents,
  markJobReviewed, markJobVideoDeleted, quarantineMediaAsset, reserveRender,
} from '../../db/repositories.js';
import { handleOptions, parseCookies, readJson, send, verifySessionToken } from '../../lib/video-os-account.js';
import { captureRouteError } from '../../lib/video-os-observability.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../../lib/video-os-private-blob.js';
import { timingSafeMatch } from '../../lib/video-os-security.js';
import { runWatchdogSweep } from '../../lib/video-os-watchdog.js';

function isAdminRequest(req) {
  const token = String(process.env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let cookieAdmin = false;
  try { cookieAdmin = verifySessionToken(parseCookies(req).vos_admin).accountId === 'admin'; } catch {}
  // CRON_SECRET follows Vercel's own documented cron-auth convention
  // (https://vercel.com/docs/cron-jobs/manage-cron-jobs) even though this
  // repo's watchdog sweep is actually triggered by a GitHub Actions
  // schedule, not a native Vercel Cron -- see
  // .github/workflows/watchdog-sweep.yml for why. Reusing the same env var
  // name keeps the option open to switch triggers later without an admin
  // route change. timingSafeMatch (not ===) matches every other secret
  // comparison in this codebase -- this route now also guards a real
  // credit-minting mutation (operation=grant-credit), which raised the
  // value of this check beyond what a plain string compare should protect.
  return (Boolean(token) && timingSafeMatch(auth, token)) || (Boolean(cronSecret) && timingSafeMatch(auth, cronSecret)) || cookieAdmin;
}

async function jobsSummary() {
  const jobs = await listRecentJobs(100);
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const rendering = jobs.filter((job) => ['provider_submitted', 'provider_rendering', 'finishing'].includes(job.status)).length;
  const ready = jobs.filter((job) => job.status === 'ready').length;
  return { summary: { total: jobs.length, rendering, ready, failed }, jobs };
}

function jsonFailure(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error }));
}

// Admin video preview/download is intentionally its own path, not a
// permissive mode of api/video-os-lite/download-v2.js: that route enforces
// the customer's own session owns the job (getOwnedJob), which an admin
// reviewing any account's video never will. isAdminRequest() above is the
// authorization boundary here instead.
async function handleVideoStream(req, res, jobId) {
  if (!jobId) return jsonFailure(res, 400, 'jobId is required.');
  const job = await getJob(jobId);
  if (!job) return jsonFailure(res, 404, 'Job not found.');
  if (job.status !== 'ready') return jsonFailure(res, 409, 'Final video is not ready.');
  if (job.videoDeletedAt) return jsonFailure(res, 410, 'This video has been deleted.');
  const result = await getPrivateBlob(job.output?.privatePathname);
  if (!result?.stream) return jsonFailure(res, 410, 'Final video is unavailable.');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', result.blob.etag);
  for await (const chunk of result.stream) res.write(chunk);
  res.end();
}

async function handleGet(req, res, operation, url) {
  if (operation === 'jobs') return send(res, 200, { ok: true, ...(await jobsSummary()) });
  if (operation === 'overview') return send(res, 200, { ok: true, overview: await getAdminOverview() });
  if (operation === 'attention') return send(res, 200, { ok: true, jobs: await listFailedOrStuckJobs(200) });
  if (operation === 'accounts') return send(res, 200, { ok: true, accounts: await listRecentAccounts(200) });
  if (operation === 'credit-ledger') return send(res, 200, { ok: true, transactions: await listRecentCreditTransactions(200) });
  if (operation === 'stripe-events') return send(res, 200, { ok: true, events: await listRecentStripeEvents(200) });
  if (operation === 'video') return handleVideoStream(req, res, String(url.searchParams.get('jobId') || '').trim());
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

async function handleDeleteVideo(jobId) {
  const job = await getJob(jobId);
  if (!job) return null;
  const pathname = job.output?.privatePathname;
  if (pathname) {
    const existing = await getPrivateBlob(pathname);
    if (existing?.blob?.etag) {
      // Best-effort: if the Blob is already gone or the etag has moved on,
      // the DB-side videoDeletedAt marker below is still the source of
      // truth for "is this available," so a Blob-side failure here must
      // not block that.
      await deletePrivateBlob(PRIVATE_BLOB_CLASSIFICATIONS.FINISHED_CUSTOMER_VIDEO, pathname, { ifMatch: existing.blob.etag }).catch(() => {});
    }
  }
  return markJobVideoDeleted(jobId);
}

// Re-renders a job from its own already-authorized input (same provider,
// format, title, cost) under a fresh job id -- see the admin console's
// "Retry render" action. Deliberately does not accept a new input payload:
// that would mean re-implementing render-v2.js's full validation/
// authorization surface for arbitrary admin-supplied project/identity
// references, a much larger and riskier surface than "run this exact
// already-validated request again," which is what customer support
// actually needs this for.
//
// Restricted to heygen jobs. A sadtalker (Standard tier) job's `input` is a
// canonical narration payload produced by consuming a one-time-use
// standardNarrationQuotes row tied to an active narration consent record
// (see db/standard-narration-repository.js) -- the generic reserveRender()
// used below has no idea about that quote/consent system, so replaying a
// sadtalker job through it would create a render with no matching consent
// reservation. Standard-tier retry needs its own admin action later.
async function handleRetryJob(jobId) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (job.provider !== 'heygen') {
    throw Object.assign(new Error('Retry is only supported for HeyGen (Premium) jobs right now.'), { statusCode: 409, failureCategory: 'RECONCILIATION' });
  }
  const newJobId = `job-${crypto.randomUUID()}`;
  const reserved = await reserveRender({
    jobId: newJobId, accountId: job.accountId, idempotencyKey: crypto.randomUUID(),
    correlationId: `admin-retry-${job.id}`, provider: job.provider, title: job.title,
    format: job.format, costCredits: job.costCredits, input: job.input,
  });
  const claimed = await claimWorkflowStart(reserved.job.id);
  if (claimed) await dispatchClaimedJob(reserved.job.id, job.provider);
  return getJob(reserved.job.id);
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
  if (operation === 'approve-job') {
    const jobId = String(payload.jobId || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    const job = await markJobReviewed(jobId);
    if (!job) return send(res, 404, { ok: false, error: 'Job not found.' });
    return send(res, 200, { ok: true, job });
  }
  if (operation === 'delete-video') {
    const jobId = String(payload.jobId || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    const job = await handleDeleteVideo(jobId);
    if (!job) return send(res, 404, { ok: false, error: 'Job not found.' });
    return send(res, 200, { ok: true, job });
  }
  if (operation === 'retry-job') {
    const jobId = String(payload.jobId || '').trim();
    if (!jobId) return send(res, 400, { ok: false, error: 'jobId is required.' });
    const job = await handleRetryJob(jobId);
    if (!job) return send(res, 404, { ok: false, error: 'Job not found.' });
    return send(res, 200, { ok: true, job });
  }
  if (operation === 'watchdog-sweep') {
    const staleAfterMinutes = Number(payload.staleAfterMinutes) || undefined;
    return send(res, 200, { ok: true, sweep: await runWatchdogSweep(staleAfterMinutes ? { staleAfterMinutes } : undefined) });
  }
  if (operation === 'grant-credit') {
    const accountId = String(payload.accountId || '').trim();
    const amount = Number(payload.amount);
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    if (!accountId) return send(res, 400, { ok: false, error: 'accountId is required.' });
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000) return send(res, 400, { ok: false, error: 'amount must be a non-zero integer with a magnitude of 100,000 or less.' });
    if (!idempotencyKey) return send(res, 400, { ok: false, error: 'idempotencyKey is required.' });
    const result = await grantAdminCredit({ accountId, amount, note: payload.note, idempotencyKey });
    console.log(JSON.stringify({ event: 'video_os_admin_credit_grant', accountId, amount, duplicate: result.duplicate, note: String(payload.note || '').slice(0, 300) || null }));
    return send(res, 200, { ok: true, ...result });
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
    if (res.headersSent) return; // a streaming response (operation=video) may have already started
    send(res, error.statusCode || 400, { ok: false, error: error.message || 'Admin status failed.' });
  }
}
