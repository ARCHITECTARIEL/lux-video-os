import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import target from '../config/database-target.production.json' with { type: 'json' };
import { database } from '../db/client.js';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';
import { diagnosticMaintenanceMode } from './diagnostic-maintenance-gate.js';

const HASH = /^[a-f0-9]{64}$/;
const MAX_WINDOW_MS = 30 * 60_000;
const ORIGIN_HOST = 'lux-video-os.vercel.app';
// Pin the Git LF blob, not platform-specific working-tree CRLF bytes.
const REVIEWED_TARGET_FILE_SHA256 = '987c494527adb6f4e7a08c0b68c38be6a1eb3d7430cdbdd4927ce6cfdd9961ef';
const REVIEWED_TARGET_OBJECT_SHA256 = '320244fc07b05622cbd5b484d8f2ef0b2a96f7d487272cdf3d991da5cf7fdaa5';

const digest = (value) => createHash('sha256').update(String(value || '')).digest('hex');
const enabled = (env, name) => String(env[name] || '').trim().toLowerCase() === 'true';

function diagnosticHost(req, env) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (host === ORIGIN_HOST) return { matched: true, stableAlias: true, uniqueDeployment: false };
  const unique = String(env.VERCEL_URL || '').trim().toLowerCase();
  const expected = expectedDigest(req, 'x-expected-deployment-url-sha256');
  return {
    matched: Boolean(/^[a-z0-9-]+\.vercel\.app$/.test(unique) && host === unique && expected === digest(unique)),
    stableAlias: false,
    uniqueDeployment: true,
  };
}

function disabledRuntimeGates(env, providerStatus) {
  return {
    durableRenderDisabled: !enabled(env, 'VIDEO_OS_DURABLE_WORKFLOW_ENABLED'),
    standardRenderDisabled: !enabled(env, 'VIDEO_OS_STANDARD_RENDER_ENABLED'),
    scriptedPhotoDisabled: !enabled(env, 'VIDEO_OS_SCRIPTED_PHOTO_ENABLED'),
    providerCreationDisabled: providerStatus().enabled !== true,
    billingDisabled: !enabled(env, 'VIDEO_OS_BILLING_ENABLED'),
    phoneEnrollmentDisabled: !enabled(env, 'VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED'),
    phoneExtractionDisabled: !enabled(env, 'VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED'),
  };
}

export function diagnosticWindowOpen(env = process.env, now = Date.now()) {
  const startedAt = Date.parse(String(env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT || ''));
  const expiresAt = Date.parse(String(env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT || ''));
  return env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED === 'true'
    && Number.isFinite(startedAt) && Number.isFinite(expiresAt)
    && startedAt <= now && expiresAt > now && expiresAt > startedAt
    && expiresAt - startedAt <= MAX_WINDOW_MS && now - startedAt <= MAX_WINDOW_MS;
}

function diagnosticResponse(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function expectedDigest(req, name) {
  const value = String(req.headers[name] || '').trim().toLowerCase();
  return HASH.test(value) ? value : null;
}

function canonicalUrlMatchesTarget(value, reviewedTarget) {
  try {
    const parsed = new URL(String(value || ''));
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && reviewedTarget.hosts.includes(parsed.hostname)
      && Number(parsed.port || 5432) === reviewedTarget.port
      && decodeURIComponent(parsed.pathname.slice(1)) === reviewedTarget.database
      && reviewedTarget.roles.includes(decodeURIComponent(parsed.username));
  } catch { return false; }
}

export async function evaluateProductionDbBinding({ req, env = process.env, db = database, now = Date.now(),
  reviewedTarget = target, expectedTargetFileSha256 = REVIEWED_TARGET_FILE_SHA256,
  expectedTargetObjectSha256 = REVIEWED_TARGET_OBJECT_SHA256,
  providerStatus = providerCreationActivationStatus }) {
  if (!diagnosticWindowOpen(env, now)) {
    return { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } };
  }
  if (req.method !== 'GET' || env.VERCEL_ENV !== 'production') {
    return { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } };
  }
  const host = diagnosticHost(req, env);
  if (!host.matched) return { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } };
  const expectedDeployment = expectedDigest(req, 'x-expected-deployment-sha256');
  const expectedGitCommit = expectedDigest(req, 'x-expected-git-commit-sha256');
  const expectedProject = expectedDigest(req, 'x-expected-project-sha256');
  const expectedTarget = expectedDigest(req, 'x-expected-target-manifest-sha256');
  if (!expectedDeployment || !expectedGitCommit || !expectedProject || !expectedTarget) {
    return { status: 400, body: { ok: false, code: 'expected_identity_required' } };
  }
  const deploymentMatched = Boolean(env.VERCEL_DEPLOYMENT_ID)
    && digest(env.VERCEL_DEPLOYMENT_ID) === expectedDeployment;
  const gitCommitMatched = Boolean(env.VERCEL_GIT_COMMIT_SHA)
    && digest(env.VERCEL_GIT_COMMIT_SHA) === expectedGitCommit;
  const projectMatched = Boolean(env.VERCEL_PROJECT_ID)
    && digest(env.VERCEL_PROJECT_ID) === expectedProject;
  const targetManifestMatched = expectedTarget === expectedTargetFileSha256
    && digest(JSON.stringify(reviewedTarget)) === expectedTargetObjectSha256;
  const urlMatched = canonicalUrlMatchesTarget(env.DATABASE_URL, reviewedTarget);
  const gates = disabledRuntimeGates(env, providerStatus);
  const gatesDisabled = Object.values(gates).every(Boolean);
  const maintenanceAdmissionActive = diagnosticMaintenanceMode(env) === 'active';
  let liveMatched = false;
  let readOnly = false;
  if (deploymentMatched && gitCommitMatched && projectMatched && targetManifestMatched && urlMatched && gatesDisabled && maintenanceAdmissionActive) {
    const rows = await db().transaction(async (tx) => {
      const result = await tx.execute(sql`select current_database() as database, current_user as role,
        current_setting('transaction_read_only') as read_only`);
      return result.rows;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    const row = rows[0];
    readOnly = row?.read_only === 'on';
    liveMatched = readOnly && row.database === reviewedTarget.database
      && reviewedTarget.roles.includes(row.role);
  }
  const attested = deploymentMatched && gitCommitMatched && projectMatched
    && targetManifestMatched && urlMatched && gatesDisabled && maintenanceAdmissionActive && liveMatched;
  return { status: attested ? 200 : 409, body: {
    ok: attested,
    stableAliasHostMatched: host.stableAlias,
    uniqueDeploymentHostMatched: host.uniqueDeployment,
    deploymentMatched,
    gitCommitMatched,
    projectMatched,
    targetManifestMatched,
    canonicalUrlMatchesTarget: urlMatched,
    connectedDatabaseMatchesTarget: liveMatched,
    maintenanceAdmissionActive,
    ...gates,
    sourceByteAttested: false,
    readOnly,
    observedAtUtc: new Date(now).toISOString(),
  } };
}

export async function handleProductionDbBindingDiagnostic(req, res, options) {
  try {
    const result = await evaluateProductionDbBinding({ req, ...options });
    diagnosticResponse(res, result.status, result.body);
  } catch {
    diagnosticResponse(res, 503, { ok: false, code: 'diagnostic_unavailable' });
  }
}
