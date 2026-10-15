import { logOpsEventAwaited } from './ops-log.js';
import { ipPrefix } from './video-os-account.js';

const ADMIN_OPERATIONS = new Set([
  'jobs', 'overview', 'attention', 'testers', 'accounts', 'credit-ledger', 'stripe-events',
  'activity', 'activity-summary', 'entity-timeline', 'video', 'job-events', 'job-assets',
  'resolve-job', 'approve-job', 'delete-video', 'retry-job', 'watchdog-sweep',
  'stripe-reconciliation', 'grant-credit', 'quarantine-asset', 'register-tester',
  'revoke-tester', 'p0-attestation', 'canary-scope', 'db-binding', 'admin-login',
]);
export const ADMIN_ACTOR_TYPES = new Set(['admin_token', 'cron_secret', 'session', 'none']);

function operationForAudit(operation) {
  return ADMIN_OPERATIONS.has(operation) ? operation : 'unknown';
}

function deploymentIdentity(env) {
  const deploymentId = String(env.VERCEL_DEPLOYMENT_ID || '').trim();
  const gitSha = String(env.VERCEL_GIT_COMMIT_SHA || '').trim();
  return {
    deploymentId: /^[a-z0-9_-]{1,128}$/i.test(deploymentId) ? deploymentId : 'unknown',
    gitSha: /^(?:[a-f0-9]{7,64})$/i.test(gitSha) ? gitSha : 'unknown',
  };
}

function requestResult(status) {
  if (status < 400) return { result: 'succeeded', code: 'ADMIN_REQUEST_SUCCEEDED', level: 'info' };
  if (status < 500) return { result: 'rejected', code: 'ADMIN_REQUEST_REJECTED', level: 'warn' };
  return { result: 'failed', code: 'ADMIN_REQUEST_FAILED', level: 'error' };
}

async function auditAdminRequest(req, { operation, actorType, status, env, writer }) {
  const outcome = requestResult(status);
  const identity = deploymentIdentity(env);
  let requestIpPrefix;
  let userAgent = 'unknown';
  try {
    requestIpPrefix = ipPrefix(req).replace(/^([a-f0-9]+:[a-f0-9]+:[a-f0-9]+):[a-f0-9]+::\/64$/i, '$1::/48');
    userAgent = String(req.headers?.['user-agent'] || 'unknown').slice(0, 120);
  } catch {
    requestIpPrefix = 'unknown';
  }
  await logOpsEventAwaited({
    level: outcome.level,
    persist: true,
    event: 'admin.request.completed',
    status,
    code: outcome.code,
    message: 'Admin request completed.',
    details: {
      operation: operationForAudit(operation),
      result: outcome.result,
      actorType: ADMIN_ACTOR_TYPES.has(actorType) ? actorType : 'none',
      ipPrefix: requestIpPrefix,
      userAgent,
      ...identity,
    },
  }, { writer, emit: false });
}

const failedAlertWindows = new Map();
const ALERT_WINDOW_MS = 5 * 60_000;

function shouldAlert(actorType, status) {
  if (actorType !== 'none' && status !== 401 && status !== 403) return true;
  const key = `${actorType}:${status}`;
  const now = Date.now();
  if (now - (failedAlertWindows.get(key) ?? -Infinity) < ALERT_WINDOW_MS) return false;
  if (failedAlertWindows.size >= 32) {
    for (const [oldKey, at] of failedAlertWindows) {
      if (now - at >= ALERT_WINDOW_MS) failedAlertWindows.delete(oldKey);
    }
  }
  failedAlertWindows.set(key, now);
  return true;
}

async function alertAdminWrite(req, { operation, actorType, status, env, fetchImpl = fetch }) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || actorType === 'cron_secret') return;
  const webhookUrl = String(env.WATCHDOG_SLACK_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return;
  if (!shouldAlert(actorType, status)) return;
  const { deploymentId } = deploymentIdentity(env);
  const text = JSON.stringify({
    operation: operationForAudit(operation),
    status,
    actorType: ADMIN_ACTOR_TYPES.has(actorType) ? actorType : 'none',
    deploymentId,
  });
  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Admin responses must not depend on the optional Slack channel.
  }
}

// Existing route handlers call res.end() from several branches. Deferring
// that one boundary keeps their status/body behavior intact while ensuring
// the durable audit write has settled before the response completes.
export function deferAdminResponse(req, res, {
  operation,
  actorType = 'none',
  env = process.env,
  writer,
  fetchImpl,
} = {}) {
  const originalEnd = res.end.bind(res);
  let pending;
  let finalized = false;
  const finalize = async (status) => {
    if (finalized) return;
    finalized = true;
    let resolvedActorType = actorType;
    try {
      if (typeof resolvedActorType === 'function') resolvedActorType = resolvedActorType();
    } catch {
      resolvedActorType = 'none';
    }
    if (!ADMIN_ACTOR_TYPES.has(resolvedActorType)) resolvedActorType = 'none';
    await auditAdminRequest(req, { operation, actorType: resolvedActorType, status, env, writer });
    void alertAdminWrite(req, { operation, actorType: resolvedActorType, status, env, fetchImpl });
  };
  res.end = (...args) => {
    if (pending) return pending;
    const status = Number.isInteger(res.statusCode) ? res.statusCode : 200;
    pending = finalize(status).catch(() => {}).then(() => originalEnd(...args));
    return pending;
  };
  return {
    cancel() {
      if (pending || finalized) return false;
      finalized = true;
      res.end = originalEnd;
      return true;
    },
    async wait() {
      if (pending) await pending;
      else await finalize(Number.isInteger(res.statusCode) ? res.statusCode : 200).catch(() => {});
    },
  };
}
