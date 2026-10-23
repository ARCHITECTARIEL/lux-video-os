import { sql } from 'drizzle-orm';
import target from '../config/database-target.production.json' with { type: 'json' };
import { database } from '../db/client.js';
import { providerCreationActivationStatus } from '../db/provider-reconciliation-repository.js';
import { allowlistInvalidEntryCount, allowlistSource, identityAllowedAccountIds } from './identity-account-allowlist.js';
import { timingSafeMatch } from './video-os-security.js';
import { diagnosticMaintenanceMode } from './diagnostic-maintenance-gate.js';
import { auditOperatorDiagnostic, diagnosticAuditDetails } from './operator-diagnostic-audit.js';
import { createDiagnosticLimiter, diagnosticAvailable, diagnosticDigest as digest, diagnosticEnabled as enabled,
  diagnosticHost, diagnosticResponse, diagnosticWindowOpen, expectedIdentity, isDbBindingOperatorRequest,
  REVIEWED_TARGET_FILE_SHA256, REVIEWED_TARGET_OBJECT_SHA256 } from './operator-diagnostic-guard.js';

function disabledRuntimeGates(env, providerStatus) {
  return {
    durableRenderDisabled: !enabled(env, 'VIDEO_OS_DURABLE_WORKFLOW_ENABLED'),
    standardRenderDisabled: !enabled(env, 'VIDEO_OS_STANDARD_RENDER_ENABLED'),
    scriptedPhotoDisabled: !enabled(env, 'VIDEO_OS_SCRIPTED_PHOTO_ENABLED'),
    providerCreationDisabled: providerStatus(env).enabled !== true,
    billingDisabled: !enabled(env, 'VIDEO_OS_BILLING_ENABLED'),
    phoneEnrollmentDisabled: !enabled(env, 'VIDEO_OS_PHONE_VIDEO_ENROLLMENT_ENABLED'),
    phoneExtractionDisabled: !enabled(env, 'VIDEO_OS_PHONE_VIDEO_EXTRACTION_ENABLED'),
  };
}

export { diagnosticWindowOpen } from './operator-diagnostic-guard.js';

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
  if (!diagnosticAvailable(req, env, now)) {
    return { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } };
  }
  const host = diagnosticHost(req, env);
  const identity = expectedIdentity(req, env);
  if (!identity) {
    return { status: 400, body: { ok: false, code: 'expected_identity_required' } };
  }
  const { deploymentMatched, gitCommitMatched, projectMatched } = identity;
  const targetManifestMatched = identity.targetManifest === expectedTargetFileSha256
    && digest(JSON.stringify(reviewedTarget)) === expectedTargetObjectSha256;
  const urlMatched = canonicalUrlMatchesTarget(env.DATABASE_URL, reviewedTarget);
  const gates = disabledRuntimeGates(env, providerStatus);
  const source = allowlistSource(env);
  const allowedIds = identityAllowedAccountIds(env);
  const providerCreationCanaryScoped = allowedIds.some((accountId) => providerStatus(env, accountId).enabled === true);
  const enrollmentPin = String(env.VIDEO_OS_ENROLLMENT_CANARY_ACCOUNT_ID || '').trim();
  const identityProviderPinMatchesCanaryPin = Boolean(enrollmentPin)
    && typeof env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID === 'string'
    && timingSafeMatch(env.VIDEO_OS_IDENTITY_PROVIDER_ACCOUNT_ID.trim(), enrollmentPin);
  const gatesDisabled = Object.values(gates).every(Boolean) && !providerCreationCanaryScoped;
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
    providerCreationCanaryScoped,
    allowlistSource: source,
    allowlistCount: allowedIds.length,
    allowlistInvalidEntryCount: allowlistInvalidEntryCount(env),
    identityProviderPinMatchesCanaryPin,
    sourceByteAttested: false,
    readOnly,
    observedAtUtc: new Date(now).toISOString(),
  } };
}

const limiter = createDiagnosticLimiter();

export async function handleProductionDbBindingDiagnostic(req, res, options = {}) {
  const env = options.env || process.env;
  const now = options.now ?? Date.now();
  const audit = options.audit || ((event, body) => auditOperatorDiagnostic(event, body, { writer: options.auditWriter }));
  const rateLimit = options.rateLimit || limiter;
  let result;
  try {
    if (!diagnosticWindowOpen(env, now) || req.method !== 'GET' || env.VERCEL_ENV !== 'production') {
      result = { status: 404, body: { ok: false, code: 'diagnostic_unavailable' } };
    } else if (options.requireOperator && !isDbBindingOperatorRequest(req, env)) {
      result = { status: 401, body: { ok: false, code: 'operator_required' } };
    } else if (!rateLimit.consume(env, now)) {
      result = { status: 429, body: { ok: false, code: 'rate_limited' } };
    } else {
      result = await evaluateProductionDbBinding({ req, ...options, env, now });
    }
  } catch {
    result = { status: 503, body: { ok: false, code: 'diagnostic_unavailable' } };
  }
  try { await audit('admin.db_binding.checked', diagnosticAuditDetails(result.body)); } catch { /* Audit failures cannot change the diagnostic response. */ }
  diagnosticResponse(res, result.status, result.body);
}
