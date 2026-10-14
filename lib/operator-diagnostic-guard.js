import { createHash } from 'node:crypto';
import { timingSafeMatch } from './video-os-security.js';

const HASH = /^[a-f0-9]{64}$/;
const MAX_WINDOW_MS = 30 * 60_000;
const ORIGIN_HOST = 'lux-video-os.vercel.app';
// Git LF blob of the reviewed target manifest, shared by both diagnostics.
export const REVIEWED_TARGET_FILE_SHA256 = '987c494527adb6f4e7a08c0b68c38be6a1eb3d7430cdbdd4927ce6cfdd9961ef';
export const REVIEWED_TARGET_OBJECT_SHA256 = '320244fc07b05622cbd5b484d8f2ef0b2a96f7d487272cdf3d991da5cf7fdaa5';

export const diagnosticDigest = (value) => createHash('sha256').update(String(value || '')).digest('hex');
export const diagnosticEnabled = (env, name) => String(env[name] || '').trim().toLowerCase() === 'true';

export function diagnosticWindowOpen(env = process.env, now = Date.now()) {
  const startedAt = Date.parse(String(env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT || ''));
  const expiresAt = Date.parse(String(env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT || ''));
  return env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_ENABLED === 'true'
    && Number.isFinite(startedAt) && Number.isFinite(expiresAt)
    && startedAt <= now && expiresAt > now && expiresAt > startedAt
    && expiresAt - startedAt <= MAX_WINDOW_MS && now - startedAt <= MAX_WINDOW_MS;
}

export function diagnosticResponse(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

export function expectedDigest(req, name) {
  const value = String(req.headers[name] || '').trim().toLowerCase();
  return HASH.test(value) ? value : null;
}

export function diagnosticHost(req, env) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (host === ORIGIN_HOST) return { matched: true, stableAlias: true, uniqueDeployment: false };
  const unique = String(env.VERCEL_URL || '').trim().toLowerCase();
  const expected = expectedDigest(req, 'x-expected-deployment-url-sha256');
  return {
    matched: Boolean(/^[a-z0-9-]+\.vercel\.app$/.test(unique) && host === unique && expected === diagnosticDigest(unique)),
    stableAlias: false,
    uniqueDeployment: true,
  };
}

export function diagnosticAvailable(req, env, now) {
  return diagnosticWindowOpen(env, now) && req.method === 'GET'
    && env.VERCEL_ENV === 'production' && diagnosticHost(req, env).matched;
}

export function isDbBindingOperatorRequest(req, env = process.env) {
  const token = String(env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_OPERATOR_TOKEN || '').trim();
  const adminToken = String(env.VIDEO_OS_ADMIN_TOKEN || '').trim();
  const cronToken = String(env.CRON_SECRET || '').trim();
  const match = /^Bearer ([^\s]+)$/i.exec(String(req.headers.authorization || ''));
  return Boolean(token && match)
    && (!adminToken || !timingSafeMatch(token, adminToken))
    && (!cronToken || !timingSafeMatch(token, cronToken))
    && timingSafeMatch(match[1], token);
}

export function expectedIdentity(req, env) {
  const deployment = expectedDigest(req, 'x-expected-deployment-sha256');
  const gitCommit = expectedDigest(req, 'x-expected-git-commit-sha256');
  const project = expectedDigest(req, 'x-expected-project-sha256');
  const targetManifest = expectedDigest(req, 'x-expected-target-manifest-sha256');
  if (!deployment || !gitCommit || !project || !targetManifest) return null;
  return {
    deploymentMatched: Boolean(env.VERCEL_DEPLOYMENT_ID) && diagnosticDigest(env.VERCEL_DEPLOYMENT_ID) === deployment,
    gitCommitMatched: Boolean(env.VERCEL_GIT_COMMIT_SHA) && diagnosticDigest(env.VERCEL_GIT_COMMIT_SHA) === gitCommit,
    projectMatched: Boolean(env.VERCEL_PROJECT_ID) && diagnosticDigest(env.VERCEL_PROJECT_ID) === project,
    targetManifest,
  };
}

export function createDiagnosticLimiter() {
  let windowKey;
  let count = 0;
  let minute = [];
  return {
    consume(env, now) {
      const key = `${env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_STARTED_AT}|${env.VIDEO_OS_DB_BINDING_DIAGNOSTIC_EXPIRES_AT}`;
      if (key !== windowKey) { windowKey = key; count = 0; minute = []; }
      minute = minute.filter((time) => time > now - 60_000);
      if (minute.length >= 5 || count >= 20) return false;
      minute.push(now);
      count += 1;
      return true;
    },
    clear() { windowKey = undefined; count = 0; minute = []; },
  };
}
