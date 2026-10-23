import { sql, desc, eq } from 'drizzle-orm';
import { getOpsPersistFailureCount } from './ops-log.js';

const startedAt = new Date().toISOString();
const WATCHDOG_INTERVAL_MS = 15 * 60_000;
const HEADERS = {
  'Cache-Control': 'public, s-maxage=15, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

async function probeDatabase() {
  const { database } = await import('../db/client.js');
  await database().execute(sql`select 1`);
}

async function readLastSweepAt() {
  const [{ database }, { opsEvents }] = await Promise.all([import('../db/client.js'), import('../db/schema.js')]);
  const rows = await database().select({ createdAt: opsEvents.createdAt, details: opsEvents.details }).from(opsEvents)
    .where(eq(opsEvents.event, 'watchdog_heartbeat')).orderBy(desc(opsEvents.createdAt)).limit(1);
  return rows[0] ? { lastSweepAt: rows[0].createdAt.toISOString(),
    oldestStaleAgeMinutes: rows[0].details?.oldestStaleAgeMinutes ?? 0 } : null;
}

async function within(deadlineMs, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), deadlineMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthHandler({ env = process.env, dbProbe = probeDatabase, lastSweep = readLastSweepAt,
  opsFailures = getOpsPersistFailureCount, now = () => new Date(), processStartedAt = new Date(startedAt) } = {}) {
  return async function handler(req, res) {
    for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end(JSON.stringify({ ok: false, code: 'method_not_allowed' }));
      return;
    }

    const dbConfigured = Boolean(env.DATABASE_URL);
    const began = Date.now();
    let dbOk = false;
    let dbCode;
    if (!dbConfigured) dbCode = 'db_unconfigured';
    else {
      try {
        await within(2000, dbProbe);
        dbOk = true;
      } catch (error) {
        dbCode = error?.message === 'timeout' ? 'db_timeout' : 'db_unavailable';
      }
    }
    let sweep = null;
    let sweepUnreadable = false;
    if (dbOk) {
      try { sweep = await within(2000, lastSweep); } catch { sweepUnreadable = true; }
    }
    const lastSweepAt = typeof sweep === 'string' ? sweep : sweep?.lastSweepAt || null;
    const oldestStaleAgeMinutes = Number.isFinite(sweep?.oldestStaleAgeMinutes) ? sweep.oldestStaleAgeMinutes : 0;
    const checkedAt = now();
    const lastSweepMs = typeof lastSweepAt === 'string' ? Date.parse(lastSweepAt) : NaN;
    const sweepAgeMs = checkedAt.getTime() - lastSweepMs;
    const configuredEscalateHours = Number(env.VIDEO_OS_WATCHDOG_ESCALATE_HOURS);
    const escalateMinutes = (Number.isFinite(configuredEscalateHours) && configuredEscalateHours > 0
      ? configuredEscalateHours : 24) * 60;
    const production = env.VERCEL_ENV === 'production';
    const processAgeMs = checkedAt.getTime() - new Date(processStartedAt).getTime();
    const firstSweepGrace = !lastSweepAt && !sweepUnreadable && processAgeMs >= 0 && processAgeMs < 20 * 60_000;
    const invalidSweep = Boolean(lastSweepAt) && (!Number.isFinite(sweepAgeMs) || sweepAgeMs < -120_000);
    const watchdogStatus = sweepUnreadable ? 'warn'
      : !dbOk ? 'warn'
        : (!lastSweepAt && !firstSweepGrace) || (Number.isFinite(sweepAgeMs) && sweepAgeMs > WATCHDOG_INTERVAL_MS * 4)
          ? production ? 'fail' : 'warn'
          : invalidSweep ? 'warn'
            : (Number.isFinite(sweepAgeMs) && sweepAgeMs > WATCHDOG_INTERVAL_MS * 2)
              || oldestStaleAgeMinutes >= escalateMinutes ? 'warn' : !lastSweepAt ? 'warn' : 'ok';
    const watchdogOk = watchdogStatus === 'ok';
    const watchdogCode = sweepUnreadable ? 'watchdog_unreadable' : !lastSweepAt ? 'watchdog_missing'
      : invalidSweep ? 'watchdog_invalid'
        : watchdogStatus !== 'ok' ? oldestStaleAgeMinutes >= escalateMinutes ? 'watchdog_job_age' : 'watchdog_stale' : undefined;
    const failureCount = opsFailures();
    const opsStatus = failureCount >= 1 ? 'warn' : 'ok';
    const blobOk = Boolean(env.BLOB_READ_WRITE_TOKEN);
    const providerOk = Boolean(env.HEYGEN_API_KEY);
    const systemGitSha = String(env.VERCEL_GIT_COMMIT_SHA || '').trim();
    const packagedGitSha = String(env.VIDEO_OS_RELEASE_GIT_SHA || '').trim();
    const packagedGitShaValid = /^[a-f0-9]{40}$/.test(packagedGitSha);
    const releaseIdentityConflict = Boolean(systemGitSha && packagedGitSha && systemGitSha !== packagedGitSha);
    const gitSha = production
      ? (packagedGitShaValid && !releaseIdentityConflict ? packagedGitSha : null)
      : systemGitSha || (packagedGitShaValid ? packagedGitSha : null);
    const releaseIdentityOk = !releaseIdentityConflict && /^[a-f0-9]{40}$/.test(gitSha || '');
    const releaseIdentityCode = releaseIdentityConflict ? 'release_identity_mismatch'
      : packagedGitSha && !packagedGitShaValid ? 'release_identity_invalid' : 'release_identity_missing';
    const status = !dbOk || !blobOk || watchdogStatus === 'fail' ? 'fail'
      : !providerOk || (production && !releaseIdentityOk) || watchdogStatus === 'warn' || opsStatus === 'warn' ? 'degraded' : 'ok';
    const body = {
      status,
      service: 'lux-video-os',
      deploymentId: env.VERCEL_DEPLOYMENT_ID || null,
      gitSha,
      gitRef: env.VERCEL_GIT_COMMIT_REF || null,
      env: env.VERCEL_ENV || null,
      startedAt,
      checkedAt: checkedAt.toISOString(),
      checks: {
        db: { ok: dbOk, critical: true, latencyMs: Date.now() - began, ...(dbCode ? { code: dbCode } : {}) },
        blob: { ok: blobOk, critical: true, configured: blobOk },
        provider: { ok: providerOk, critical: false, configured: providerOk },
        watchdog: { ok: watchdogOk, critical: false, status: watchdogStatus, lastSweepAt, ...(watchdogCode ? { code: watchdogCode } : {}) },
        // Local process diagnostic only; it cannot establish fleet-wide persistence health.
        opsPersist: { ok: opsStatus === 'ok', critical: false, status: opsStatus },
        releaseIdentity: { ok: releaseIdentityOk, critical: false, ...(!releaseIdentityOk ? { code: releaseIdentityCode } : {}) },
      },
    };
    res.statusCode = status === 'fail' ? 503 : 200;
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
}

export default createHealthHandler();
