// Routed through the consolidated workspace function to stay within the Vercel function limit.
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { dispatchClaimedJob } from '../../api/video-os-lite/render-v2.js';
import { database } from '../../db/client.js';
import { logOpsEvent, logOpsEventAwaited, redactOpsValue } from '../../lib/ops-log.js';
import {
  adminResolveJob, claimWorkflowStart, getAdminOverview, getJob, getJobEventTimeline, grantAdminCredit, listAdminTesters, listFailedOrStuckJobs,
  listMediaAssetsForJob, listRecentAccounts, listRecentCreditTransactions, listRecentJobs, listRecentStripeEvents,
  markJobReviewed, markJobVideoDeleted, quarantineMediaAsset, registerAdminTester, reserveRender, revokeAdminTester,
} from '../../db/repositories.js';
import { handleOptions, parseCookies, readJson, send, verifySessionToken } from '../../lib/video-os-account.js';
import { captureRouteError } from '../../lib/video-os-observability.js';
import { deletePrivateBlob, getPrivateBlob, PRIVATE_BLOB_CLASSIFICATIONS } from '../../lib/video-os-private-blob.js';
import { timingSafeMatch } from '../../lib/video-os-security.js';
import { getP0JobAttestation, P0JobAttestationError } from '../../db/p0-job-attestation.js';
import { diagnosticWindowOpen, handleProductionDbBindingDiagnostic } from '../../lib/production-db-binding-diagnostic.js';
import { reconcileStripePayments } from '../../lib/video-os-stripe-reconciliation.js';
import { runWatchdogSweep } from '../../lib/video-os-watchdog.js';

function isAdminRequest(req) {
  const token = String(process.env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const diagnosticToken = String(process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN || '').trim();
  if (diagnosticToken && timingSafeMatch(auth, diagnosticToken)) return false;
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

function isDiagnosticOperatorRequest(req, env = process.env) {
  const token = String(env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const match = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  return Boolean(token && match) && timingSafeMatch(match[1], token);
}

const P0_ATTESTATION_MAX_WINDOW_MS = 2 * 60 * 60_000;
const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 100;
const ACTIVITY_MAX_OFFSET = 10_000;
const OPS_LEVELS = new Set(['info', 'warn', 'error']);

function boundedQueryText(value, label, maxLength = 128) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw Object.assign(new Error(`${label} is too long.`), { statusCode: 400 });
  return text;
}

function boundedInteger(value, fallback, { min = 0, max } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`Expected a whole number between ${min} and ${max}.`), { statusCode: 400 });
  }
  return parsed;
}

function optionalDate(value, label) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${label} must be a valid date.`), { statusCode: 400 });
  return parsed;
}

export function parseActivityQuery(url, { requireEntity = false } = {}) {
  const entityId = boundedQueryText(url.searchParams.get('entityId'), 'entityId');
  if (requireEntity && !entityId) throw Object.assign(new Error('entityId is required.'), { statusCode: 400 });
  const level = boundedQueryText(url.searchParams.get('level'), 'level', 16).toLowerCase();
  if (level && !OPS_LEVELS.has(level)) throw Object.assign(new Error('level must be info, warn, or error.'), { statusCode: 400 });
  const from = optionalDate(url.searchParams.get('from'), 'from');
  const to = optionalDate(url.searchParams.get('to'), 'to');
  if (from && to && from > to) throw Object.assign(new Error('from must be earlier than to.'), { statusCode: 400 });
  return {
    accountId: boundedQueryText(url.searchParams.get('accountId'), 'accountId'),
    entityType: boundedQueryText(url.searchParams.get('entityType'), 'entityType', 32).toLowerCase(),
    entityId,
    event: boundedQueryText(url.searchParams.get('event'), 'event', 96),
    level,
    code: boundedQueryText(url.searchParams.get('code'), 'code', 80),
    from,
    to,
    limit: boundedInteger(url.searchParams.get('limit'), ACTIVITY_DEFAULT_LIMIT, { min: 1, max: ACTIVITY_MAX_LIMIT }),
    offset: boundedInteger(url.searchParams.get('offset'), 0, { min: 0, max: ACTIVITY_MAX_OFFSET }),
  };
}

function withoutTotalCount(row) {
  const { totalCount: _totalCount, ...event } = row;
  return event;
}

function pagedRows(rows, limit, offset) {
  // The CTE queries below deliberately return one count-only row when an
  // offset is past the last event. Filtering that placeholder preserves an
  // honest total while keeping the API's events collection empty.
  const events = rows.filter((row) => row.id).map(withoutTotalCount);
  const total = Number(rows[0]?.totalCount || 0);
  return { events, page: { limit, offset, total, hasMore: offset + events.length < total } };
}

// All values in these admin queries are bound through Drizzle's sql tag.
// The activity surface is deliberately read-only and never accepts a raw
// sort expression, column name, or SQL fragment from the request.
export async function listOpsActivity(filters, db = database()) {
  const conditions = [sql`true`];
  if (filters.accountId) conditions.push(sql`account_id = ${filters.accountId}`);
  if (filters.entityType) conditions.push(sql`entity_type = ${filters.entityType}`);
  if (filters.entityId) conditions.push(sql`entity_id = ${filters.entityId}`);
  if (filters.event) conditions.push(sql`event = ${filters.event}`);
  if (filters.level) conditions.push(sql`level = ${filters.level}`);
  if (filters.code === 'UNCODED') conditions.push(sql`code is null`);
  else if (filters.code) conditions.push(sql`code = ${filters.code}`);
  if (filters.from) conditions.push(sql`created_at >= ${filters.from}`);
  if (filters.to) conditions.push(sql`created_at <= ${filters.to}`);
  const result = await db.execute(sql`
    with filtered as (
      select id, created_at as "createdAt", level, event,
        account_id as "accountId", entity_type as "entityType", entity_id as "entityId",
        correlation_id as "correlationId", code, http_status as "httpStatus", message, details
      from ops_events
      where ${sql.join(conditions, sql` and `)}
    ), counted as (
      select count(*)::int as "totalCount" from filtered
    ), paged as (
      select * from filtered order by "createdAt" desc, id desc
      limit ${filters.limit} offset ${filters.offset}
    )
    select paged.*, counted."totalCount"
    from counted left join paged on true
    order by paged."createdAt" desc, paged.id desc
  `);
  const rows = result.rows || [];
  return pagedRows(rows, filters.limit, filters.offset);
}

export async function getOpsCodeSummary(db = database()) {
  const result = await db.execute(sql`
    select coalesce(code, 'UNCODED') as code, count(*)::int as count, max(created_at) as "latestAt"
    from ops_events
    where level = 'error' and created_at >= now() - interval '24 hours'
    group by coalesce(code, 'UNCODED')
    order by count(*) desc, coalesce(code, 'UNCODED') asc
    limit 20
  `);
  return result.rows || [];
}

export async function listEntityTimeline(filters, db = database()) {
  const entityType = filters.entityType || '';
  const result = await db.execute(sql`
    with timeline as (
      select 'ops'::text as source, oe.id::text as id, oe.created_at as "createdAt",
        oe.level, oe.event, oe.account_id as "accountId", oe.entity_type as "entityType",
        oe.entity_id as "entityId", oe.correlation_id as "correlationId", oe.code,
        oe.http_status as "httpStatus", oe.message, oe.details
      from ops_events oe
      where oe.entity_id = ${filters.entityId}
        and (${entityType} = '' or oe.entity_type = ${entityType})
      union all
      select 'job'::text as source, je.id::text as id, je.created_at as "createdAt",
        case when je.failure_category is not null or je.stage_to = 'failed' then 'error' else 'info' end as level,
        je.event_type as event, vj.account_id as "accountId", 'job'::text as "entityType",
        je.job_id as "entityId", je.correlation_id as "correlationId", je.failure_category as code,
        null::integer as "httpStatus", coalesce(je.details->>'message', '') as message,
        coalesce(je.details, '{}'::jsonb) || jsonb_build_object(
          'stageFrom', je.stage_from, 'stageTo', je.stage_to,
          'failureCategory', je.failure_category, 'provider', vj.provider
        ) as details
      from job_events je
      inner join video_jobs vj on vj.id = je.job_id
      where je.job_id = ${filters.entityId} and (${entityType} = '' or ${entityType} = 'job')
      union all
      select 'provider'::text as source, ple.id::text as id, ple.observed_at as "createdAt",
        case
          when plo.state in ('failed', 'ambiguous') or ple.provider_http_status >= 400 or ple.provider_code is not null then 'error'
          else 'info'
        end as level,
        ple.event_type as event, plo.application_account_id as "accountId",
        case
          when plo.job_id::text = ${filters.entityId} then 'job'
          when plo.identity_id::text = ${filters.entityId} then 'identity'
          else 'enrollment'
        end as "entityType",
        ${filters.entityId}::text as "entityId", ple.correlation_id as "correlationId",
        ple.provider_code as code, ple.provider_http_status as "httpStatus", ''::text as message,
        jsonb_strip_nulls(jsonb_build_object(
          'operationKind', plo.kind, 'operationState', plo.state, 'attempt', plo.attempt,
          'method', ple.method, 'pathTemplate', ple.path_template,
          'outcome', ple.outcome, 'observedResourceKind', ple.observed_resource_kind
        )) as details
      from provider_lifecycle_events ple
      inner join provider_lifecycle_operations plo
        on plo.id = ple.operation_id
        and plo.application_account_id = ple.application_account_id
        and plo.origin_scope_key = ple.origin_scope_key
      where (
        (${entityType} = '' and (
          plo.job_id::text = ${filters.entityId}
          or plo.identity_id::text = ${filters.entityId}
          or plo.enrollment_id::text = ${filters.entityId}
        ))
        or (${entityType} = 'job' and plo.job_id::text = ${filters.entityId})
        or (${entityType} = 'identity' and plo.identity_id::text = ${filters.entityId})
        or (${entityType} = 'enrollment' and plo.enrollment_id::text = ${filters.entityId})
      )
    ), counted as (
      select count(*)::int as "totalCount" from timeline
    ), paged as (
      select * from timeline order by "createdAt" desc, id desc
      limit ${filters.limit} offset ${filters.offset}
    )
    select paged.*, counted."totalCount"
    from counted left join paged on true
    order by paged."createdAt" desc, paged.id desc
  `);
  const rows = result.rows || [];
  return pagedRows(rows.map(row => row.id ? {
    ...row,
    details: redactOpsValue(row.details),
    message: redactOpsValue(row.message),
  } : row), filters.limit, filters.offset);
}

export function p0AttestationWindow(env = process.env, now = Date.now()) {
  const startedAt = Date.parse(String(env.VIDEO_OS_P0_ATTESTATION_STARTED_AT || ''));
  const expiresAt = Date.parse(String(env.VIDEO_OS_P0_ATTESTATION_EXPIRES_AT || ''));
  return env.VIDEO_OS_P0_ATTESTATION_ENABLED === 'true'
    && Number.isFinite(startedAt) && Number.isFinite(expiresAt)
    && startedAt <= now && expiresAt > now && expiresAt > startedAt
    && expiresAt - startedAt <= P0_ATTESTATION_MAX_WINDOW_MS;
}

function p0Response(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function p0BindingFromHeaders(headers = {}) {
  return {
    proofId: String(headers['x-p0-proof-id'] || '').trim(),
    jobId: String(headers['x-p0-job-id'] || '').trim(),
    correlationId: String(headers['x-p0-correlation-id'] || '').trim(),
    accountHash: String(headers['x-p0-account-hash'] || '').trim().toLowerCase(),
    deploymentIdHash: String(headers['x-p0-deployment-id-hash'] || '').trim().toLowerCase(),
    sourceCommitHash: String(headers['x-p0-source-commit-hash'] || '').trim().toLowerCase(),
    deploymentMode: String(headers['x-p0-deployment-mode'] || '').trim().toLowerCase(),
    renderMode: String(headers['x-p0-render-mode'] || '').trim(),
  };
}

function exactP0Host(req, env) {
  try {
    return env.VERCEL_ENV === 'production'
      && new URL(String(env.VIDEO_OS_PUBLIC_ORIGIN || '')).host === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

export async function handleP0AttestationRequest(req, res, {
  env = process.env,
  now = Date.now(),
  attest = getP0JobAttestation,
} = {}) {
  if (!p0AttestationWindow(env, now) || !exactP0Host(req, env)) {
    return p0Response(res, 404, { ok: false, code: 'attestation_unavailable' });
  }
  if (req.method !== 'GET') return p0Response(res, 405, { ok: false, code: 'method_not_allowed' });
  if (!isDiagnosticOperatorRequest(req, env)) {
    return p0Response(res, 401, { ok: false, code: 'operator_required' });
  }
  try {
    const result = await attest(p0BindingFromHeaders(req.headers), { env });
    return p0Response(res, 200, result);
  } catch (error) {
    if (error instanceof P0JobAttestationError) {
      return p0Response(res, error.statusCode, { ok: false, code: error.code });
    }
    return p0Response(res, 503, { ok: false, code: 'attestation_unavailable' });
  }
}

function isDbBindingOperatorRequest(req) {
  const token = String(process.env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN || '').trim();
  const adminToken = String(process.env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const cronToken = String(process.env.CRON_SECRET || '').trim();
  const match = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  return Boolean(token && match)
    && (!adminToken || !timingSafeMatch(token, adminToken))
    && (!cronToken || !timingSafeMatch(token, cronToken))
    && timingSafeMatch(match[1], token);
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
  if (operation === 'db-binding') {
    if (!diagnosticWindowOpen()) return handleProductionDbBindingDiagnostic(req, res);
    if (!isDbBindingOperatorRequest(req)) {
      res.statusCode = 401;
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, code: 'operator_required' }));
    }
    return handleProductionDbBindingDiagnostic(req, res);
  }
  if (operation === 'jobs') return send(res, 200, { ok: true, ...(await jobsSummary()) });
  if (operation === 'overview') return send(res, 200, { ok: true, overview: await getAdminOverview() });
  if (operation === 'attention') return send(res, 200, { ok: true, jobs: await listFailedOrStuckJobs(200) });
  if (operation === 'testers') return send(res, 200, { ok: true, testers: await listAdminTesters() });
  if (operation === 'accounts') return send(res, 200, { ok: true, accounts: await listRecentAccounts(200) });
  if (operation === 'credit-ledger') return send(res, 200, { ok: true, transactions: await listRecentCreditTransactions(200) });
  if (operation === 'stripe-events') return send(res, 200, { ok: true, events: await listRecentStripeEvents(200) });
  if (operation === 'activity') {
    const activity = await listOpsActivity(parseActivityQuery(url));
    return send(res, 200, { ok: true, ...activity });
  }
  if (operation === 'activity-summary') {
    return send(res, 200, { ok: true, windowHours: 24, codes: await getOpsCodeSummary() });
  }
  if (operation === 'entity-timeline') {
    const filters = parseActivityQuery(url, { requireEntity: true });
    const timeline = await listEntityTimeline(filters);
    return send(res, 200, { ok: true, entity: { type: filters.entityType || null, id: filters.entityId }, ...timeline });
  }
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

async function handlePost(req, res, operation, deps = {}) {
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
  if (operation === 'stripe-reconciliation') {
    const lookbackHours = Number(payload.lookbackHours) || undefined;
    const reconciliation = await reconcileStripePayments(lookbackHours ? { lookbackHours } : undefined);
    console.log(JSON.stringify({ event: 'video_os_stripe_reconciliation', mismatchCount: reconciliation.mismatchCount, sessionsChecked: reconciliation.sessionsChecked }));
    return send(res, 200, { ok: true, reconciliation });
  }
  if (operation === 'grant-credit') {
    const accountId = String(payload.accountId || '').trim();
    const amount = Number(payload.amount);
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    if (!accountId) return send(res, 400, { ok: false, error: 'accountId is required.' });
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100_000) return send(res, 400, { ok: false, error: 'amount must be a non-zero integer with a magnitude of 100,000 or less.' });
    if (!idempotencyKey) return send(res, 400, { ok: false, error: 'idempotencyKey is required.' });
    const result = await (deps.grantAdminCredit || grantAdminCredit)({ accountId, amount, note: payload.note, idempotencyKey });
    await logOpsEventAwaited({ level: 'info', persist: true, event: 'admin.credit.granted', accountId, code: result.duplicate ? 'CREDIT_GRANT_REPLAYED' : 'CREDIT_GRANTED', message: 'Admin credit grant was recorded.', details: { adminActor: 'admin', amount, duplicate: Boolean(result.duplicate) } }, { writer: deps.opsWriter });
    return send(res, 200, { ok: true, ...result });
  }
  if (operation === 'quarantine-asset') {
    const mediaAssetId = String(payload.mediaAssetId || '').trim();
    if (!mediaAssetId) return send(res, 400, { ok: false, error: 'mediaAssetId is required.' });
    const asset = await (deps.quarantineMediaAsset || quarantineMediaAsset)(mediaAssetId);
    if (!asset) return send(res, 404, { ok: false, error: 'Media asset not found.' });
    // The free-form reason is not logged because it may contain private data.
    // media_assets has no reason column; see quarantineMediaAsset().
    await logOpsEventAwaited({ level: 'info', persist: true, event: 'admin.asset.quarantined', accountId: asset.accountId, entityType: 'asset', entityId: mediaAssetId, message: 'Admin asset quarantine was recorded.', details: { adminActor: 'admin' } }, { writer: deps.opsWriter });
    return send(res, 200, { ok: true, asset });
  }
  if (operation === 'register-tester') {
    const email = String(payload.email || '').trim();
    const name = String(payload.name || '').trim();
    const credits = Number(payload.credits) || 5000;
    const note = String(payload.note || '').trim();
    if (!email) return send(res, 400, { ok: false, error: 'email is required.' });
    const tester = await (deps.registerAdminTester || registerAdminTester)({ email, name, credits, note });
    await logOpsEventAwaited({ level: 'info', persist: true, event: 'admin.tester.registered', accountId: tester.account?.id, message: 'Admin tester registration was recorded.', details: { adminActor: 'admin', testerDomain: /^[^@\s]+@([a-z0-9.-]+)$/i.exec(email)?.[1] || '[redacted]' } }, { writer: deps.opsWriter });
    return send(res, 200, { ok: true, tester });
  }
  if (operation === 'revoke-tester') {
    const accountId = String(payload.accountId || '').trim();
    if (!accountId) return send(res, 400, { ok: false, error: 'accountId is required.' });
    const result = await revokeAdminTester(accountId);
    console.log(JSON.stringify({ event: 'video_os_admin_revoke_tester', accountId }));
    return send(res, 200, { ok: true, result });
  }
  return send(res, 400, { ok: false, error: `Unknown admin operation: ${operation}` });
}

export function createAdminHandler(deps = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url, `https://${req.headers.host || 'lux-video-os.vercel.app'}`);
    const operation = url.searchParams.get('operation') || 'jobs';
    if (operation === 'p0-attestation') return handleP0AttestationRequest(req, res);
    if (handleOptions(req, res)) return;
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Use GET or POST for admin requests.' });
    try {
      if (req.method === 'GET' && operation === 'db-binding') return await handleGet(req, res, operation, url);
      if (!(deps.isAdminRequest || isAdminRequest)(req)) return send(res, 401, { ok: false, error: 'Admin login required.' });
      if (req.method === 'POST') return await handlePost(req, res, operation, deps);
      return await handleGet(req, res, operation, url);
    } catch (error) {
      captureRouteError(error, { route: 'admin', failureCategory: error?.failureCategory || 'ADMIN' });
      if (res.headersSent) return; // a streaming response (operation=video) may have already started
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
      logOpsEvent({ level: status >= 500 ? 'error' : 'warn', event: 'admin.request.failed', status, code: error?.failureCategory || 'ADMIN', message: error?.message || 'Admin request failed.' });
      send(res, status, { ok: false, error: status < 500 ? error.message : 'Admin request failed.' });
    }
  };
}

export default createAdminHandler();
