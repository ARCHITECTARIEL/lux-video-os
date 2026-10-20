import { sql, desc, eq } from 'drizzle-orm';

const startedAt = new Date().toISOString();
const WATCHDOG_MAX_AGE_MS = 45 * 60_000;
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
  const rows = await database().select({ createdAt: opsEvents.createdAt }).from(opsEvents)
    .where(eq(opsEvents.event, 'watchdog_heartbeat')).orderBy(desc(opsEvents.createdAt)).limit(1);
  return rows[0]?.createdAt?.toISOString() || null;
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

export function createHealthHandler({ env = process.env, dbProbe = probeDatabase, lastSweep = readLastSweepAt, now = () => new Date() } = {}) {
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
    let lastSweepAt = null;
    if (dbOk) {
      try { lastSweepAt = await within(2000, lastSweep); } catch { /* heartbeat has a separate alarm */ }
    }
    const checkedAt = now();
    const lastSweepMs = typeof lastSweepAt === 'string' ? Date.parse(lastSweepAt) : NaN;
    const sweepAgeMs = checkedAt.getTime() - lastSweepMs;
    const watchdogOk = dbOk && Number.isFinite(sweepAgeMs) && sweepAgeMs >= 0 && sweepAgeMs <= WATCHDOG_MAX_AGE_MS;
    const watchdogCode = !lastSweepAt ? 'watchdog_missing'
      : !Number.isFinite(sweepAgeMs) || sweepAgeMs < 0 ? 'watchdog_invalid'
        : sweepAgeMs > WATCHDOG_MAX_AGE_MS ? 'watchdog_stale' : undefined;
    const blobOk = Boolean(env.BLOB_READ_WRITE_TOKEN);
    const providerOk = Boolean(env.HEYGEN_API_KEY);
    const systemGitSha = String(env.VERCEL_GIT_COMMIT_SHA || '').trim();
    const packagedGitSha = String(env.VIDEO_OS_RELEASE_GIT_SHA || '').trim();
    const packagedGitShaValid = /^[a-f0-9]{40}$/.test(packagedGitSha);
    const releaseIdentityConflict = Boolean(systemGitSha && packagedGitSha && systemGitSha !== packagedGitSha);
    const production = env.VERCEL_ENV === 'production';
    const gitSha = production
      ? (packagedGitShaValid && !releaseIdentityConflict ? packagedGitSha : null)
      : systemGitSha || (packagedGitShaValid ? packagedGitSha : null);
    const releaseIdentityOk = !releaseIdentityConflict && /^[a-f0-9]{40}$/.test(gitSha || '');
    const releaseIdentityCode = releaseIdentityConflict ? 'release_identity_mismatch'
      : packagedGitSha && !packagedGitShaValid ? 'release_identity_invalid' : 'release_identity_missing';
    const status = !dbOk || !blobOk ? 'fail'
      : !providerOk || (production && (!watchdogOk || !releaseIdentityOk)) ? 'degraded' : 'ok';
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
        watchdog: { ok: watchdogOk, critical: false, lastSweepAt, ...(watchdogCode ? { code: watchdogCode } : {}) },
        releaseIdentity: { ok: releaseIdentityOk, critical: false, ...(!releaseIdentityOk ? { code: releaseIdentityCode } : {}) },
      },
    };
    res.statusCode = status === 'fail' ? 503 : 200;
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
}

export default createHealthHandler();
